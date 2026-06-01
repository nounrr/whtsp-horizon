const path = require('path');

// Load environment variables from .env (use absolute path so it works under PM2/systemd)
const dotenvResult = require('dotenv').config({ path: path.join(__dirname, '.env') });
if (dotenvResult?.error) {
  console.warn('[config] .env not loaded:', dotenvResult.error.message);
}

const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const qrcodeTerminal = require('qrcode-terminal');
const QRCodeLib = require('qrcode');
const cron = require('node-cron');

const { createPoolFromEnv } = require('./lib/db');
const { runDailyTaskReminders, runDailyTaskRemindersViaApi } = require('./reminders/dailyTaskReminders');
const { getLogs, getSentMessages, clearLogs, logReminder, logEESend } = require('./lib/logger');
const { RateLimitedQueue } = require('./lib/sendQueue');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { maxHttpBufferSize: 5e7 }); // 50MB limit for media uploads

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(value, { min, max, fallback }) {
  const n = Number(value);
  const intVal = Number.isFinite(n) ? Math.floor(n) : fallback;
  if (!Number.isFinite(intVal)) return fallback;
  return Math.max(min, Math.min(max, intVal));
}

function randIntInclusive(min, max) {
  const a = Math.floor(min);
  const b = Math.floor(max);
  if (b <= a) return a;
  return a + Math.floor(Math.random() * (b - a + 1));
}

// Security: simple API key protection for send endpoints
const API_KEY = process.env.WA_API_KEY || null;

function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ ok: false, error: 'api_key_not_configured' });
  const provided = req.get('x-api-key');
  if (!provided || provided !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

let client = new Client({
  authStrategy: new LocalAuth({
    clientId: process.env.WWEBJS_CLIENT_ID || undefined,
    dataPath: process.env.WWEBJS_AUTH_DIR || undefined,
  }),
  puppeteer: {
    headless: true,
    // If Chrome is installed locally, you can set CHROME_PATH env to its executable
    executablePath: process.env.CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
  },
  // Désactiver les fonctionnalités qui peuvent causer des erreurs
  authTimeoutMs: 60000,
  qrMaxRetries: 5,
  webVersion: process.env.WWEBJS_WEB_VERSION || undefined,
  // Options pour éviter l'erreur "markedUnread"
  webVersionCache: {
    type: 'local',
  }
});

function createFreshWaClient() {
  return new Client({
    authStrategy: new LocalAuth({
      clientId: process.env.WWEBJS_CLIENT_ID || undefined,
      dataPath: process.env.WWEBJS_AUTH_DIR || undefined,
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.CHROME_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
    },
    authTimeoutMs: 60000,
    qrMaxRetries: 5,
    webVersion: process.env.WWEBJS_WEB_VERSION || undefined,
    webVersionCache: {
      type: 'local',
    }
  });
}

const REMINDER_SOURCE = (process.env.REMINDER_SOURCE || 'db').toLowerCase(); // 'db' | 'api'

// DB pool (SIRH back database)
let dbPool = null;
if (REMINDER_SOURCE !== 'api') {
  try {
    dbPool = createPoolFromEnv();
    console.log('[db] MySQL pool created');
  } catch (e) {
    console.warn('[db] Not configured, reminders disabled until DB_* env vars are set:', e?.message);
  }
}

let isClientReady = false;
let lastQr = null;
let lastState = 'INIT';
let lastReadyAt = null;
let lastGetState = null;
let lastGetStateAt = null;
let connectedWithoutReadySince = null;
let recoveringReady = false;
let readyRecoveryFailures = 0;
let reinitTimer = null;
let initializingClient = false;
let initializedClient = false;

function isTransientWaError(err) {
  const message = String(err?.message || err || '');
  return /Session closed|Target closed|Execution context was destroyed|Protocol error/i.test(message);
}

async function replaceWaClient() {
  const oldClient = client;
  isClientReady = false;
  connectedWithoutReadySince = null;
  recoveringReady = false;
  readyRecoveryFailures = 0;
  if (oldClient) {
    try {
      oldClient.removeAllListeners();
      await oldClient.destroy();
    } catch (e) {
      console.warn('[wa] destroy before replacing client failed:', e?.message || e);
    }
  }
  await sleep(1000);
  client = createFreshWaClient();
  bindClientEvents();
}

async function recoverMissingReady() {
  if (recoveringReady || isClientReady) return;
  if (!client || typeof client.inject !== 'function') return;

  recoveringReady = true;
  try {
    console.warn('[wa] attempting to recover missing ready event with client.inject()');
    await client.inject();
    readyRecoveryFailures = 0;
  } catch (e) {
    readyRecoveryFailures++;
    console.warn('[wa] ready recovery failed:', e?.message || e);
    if (readyRecoveryFailures >= 3) {
      console.warn('[wa] ready recovery failed 3 times; scheduling full reconnect');
      readyRecoveryFailures = 0;
      scheduleReinit(1000);
    }
  } finally {
    recoveringReady = false;
  }
}

async function initializeClient(reason = 'startup') {
  if (initializingClient) {
    console.log(`[wa] initialize already in progress (${reason})`);
    return false;
  }

  initializingClient = true;
  try {
    if (initializedClient || reason !== 'startup') {
      await replaceWaClient();
    }

    let attempts = 0;
    while (true) {
      try {
        console.log(`[wa] Initialisation du client WhatsApp (${reason}, attempt ${attempts + 1})...`);
        await client.initialize();
        break;
      } catch (err) {
        attempts++;
        // "Execution context was destroyed" and friends are transient page-navigation
        // errors during injection. Rebuild the client and retry in place before
        // falling back to the slower scheduleReinit path.
        if (isTransientWaError(err) && attempts < 3) {
          console.warn(`[wa] transient init error (attempt ${attempts}), replacing client and retrying:`, err?.message || err);
          await replaceWaClient();
          await sleep(2000);
          continue;
        }
        throw err;
      }
    }
    initializedClient = true;
    return true;
  } catch (e) {
    initializedClient = false;
    isClientReady = false;
    console.error('[wa] initialize failed:', e?.message || e);
    if (/SingletonLock|ProcessSingleton|profile directory/i.test(String(e?.message || e))) {
      console.error('[wa] Chrome profile is locked. Stop duplicate PM2/node/chrome processes using WWEBJS_AUTH_DIR, then remove stale Singleton* files only after those processes are stopped.');
    }
    scheduleReinit(15000);
    return false;
  } finally {
    initializingClient = false;
  }
}

async function refreshClientState() {
  try {
    const state = await client.getState();
    lastGetState = state;
    lastGetStateAt = Date.now();

    if (typeof state === 'string' && state) {
      // Keep lastState aligned with what WhatsApp reports (whatsapp-web.js can miss change_state on some updates)
      lastState = state;
    }

    // CONNECTED can be reported before whatsapp-web.js has fully injected its
    // runtime. Do not mark the client ready until the real "ready" event fires.
    if (state === 'CONNECTED' && !isClientReady) {
      if (!connectedWithoutReadySince) {
        connectedWithoutReadySince = Date.now();
        console.warn('[wa] state is CONNECTED but ready event has not fired yet; waiting');
      } else if (Date.now() - connectedWithoutReadySince > 60000) {
        console.warn('[wa] CONNECTED without ready for more than 60s; trying ready recovery');
        connectedWithoutReadySince = Date.now();
        await recoverMissingReady();
      }
    } else {
      connectedWithoutReadySince = null;
      readyRecoveryFailures = 0;
    }

    if (state !== 'CONNECTED' && isClientReady) {
      // If WhatsApp reports non-connected state, reflect it.
      isClientReady = false;
    }

    return state;
  } catch (_e) {
    return null;
  }
}
function scheduleReinit(delayMs = 3000) {
  if (reinitTimer) return;
  reinitTimer = setTimeout(() => {
    reinitTimer = null;
    try {
      console.log('Reinitialisation du client WhatsApp...');
      initializeClient('reconnect').catch((err) => {
        console.warn('[wa] reconnect failed:', err?.message || err);
      });
    } catch (e) {
      console.warn('Erreur lors de la réinitialisation:', e?.message);
    }
  }, delayMs);
}

// WhatsApp send throttling (prevents burst sending that can trigger bans/blocks)
// Defaults: 10 messages per 10 minutes, smoothed to ~1/min with some jitter.
const WA_RATE_WINDOW_MS = process.env.WA_RATE_WINDOW_MS ? Number(process.env.WA_RATE_WINDOW_MS) : 10 * 60 * 1000;
const WA_RATE_MAX = process.env.WA_RATE_MAX ? Number(process.env.WA_RATE_MAX) : 10;
const WA_MIN_INTERVAL_MS = process.env.WA_MIN_INTERVAL_MS
  ? Number(process.env.WA_MIN_INTERVAL_MS)
  : (Number.isFinite(WA_RATE_WINDOW_MS) && Number.isFinite(WA_RATE_MAX) && WA_RATE_MAX > 0)
    ? Math.ceil(WA_RATE_WINDOW_MS / WA_RATE_MAX)
    : 0;
const WA_JITTER_MS = process.env.WA_JITTER_MS ? Number(process.env.WA_JITTER_MS) : 2500;

// Optional occasional long pause between sends (helps mimic human usage)
const WA_LONG_PAUSE_CHANCE = process.env.WA_LONG_PAUSE_CHANCE ? Number(process.env.WA_LONG_PAUSE_CHANCE) : 0;
const WA_LONG_PAUSE_MIN_MS = process.env.WA_LONG_PAUSE_MIN_MS ? Number(process.env.WA_LONG_PAUSE_MIN_MS) : 0;
const WA_LONG_PAUSE_MAX_MS = process.env.WA_LONG_PAUSE_MAX_MS ? Number(process.env.WA_LONG_PAUSE_MAX_MS) : 0;

// WhatsApp-web.js sometimes crashes inside "sendSeen" after WhatsApp Web updates.
// Default to false to keep sending messages reliable; can be re-enabled via WA_SEND_SEEN=true.
const WA_SEND_SEEN = String(process.env.WA_SEND_SEEN || 'false').toLowerCase() === 'true';

// File to persist queue state
const QUEUE_FILE = path.join(__dirname, '.queue-persist.json');

const waSendQueue = new RateLimitedQueue({
  name: 'wa-send',
  storageFile: QUEUE_FILE,
  minIntervalMs: WA_MIN_INTERVAL_MS,
  maxPerWindow: WA_RATE_MAX,
  windowMs: WA_RATE_WINDOW_MS,
  jitterMs: WA_JITTER_MS,
  longPauseChance: WA_LONG_PAUSE_CHANCE,
  longPauseMinMs: WA_LONG_PAUSE_MIN_MS,
  longPauseMaxMs: WA_LONG_PAUSE_MAX_MS,
  maxRetries: process.env.WA_QUEUE_MAX_RETRIES ? Number(process.env.WA_QUEUE_MAX_RETRIES) : 5,
  retryDelayMs: process.env.WA_QUEUE_RETRY_DELAY_MS ? Number(process.env.WA_QUEUE_RETRY_DELAY_MS) : 30000,
  logger: console,
  processor: async ({ jid, phoneNumber, text, media }) => {
    try {
    await waitForWaReady();

    let targetJid = jid;
    if (!targetJid && phoneNumber) {
      targetJid = normalizeToJid(phoneNumber);
      const numberId = await client.getNumberId(targetJid.replace('@c.us', ''));
      if (!numberId) {
        throw new Error('Numéro WhatsApp invalide ou non enregistré');
      }
    }
    if (!targetJid) {
      throw new Error('missing_target_jid');
    }

    const options = { sendSeen: WA_SEND_SEEN };
    if (media && media.data) {
        const { MessageMedia } = require('whatsapp-web.js');
        const msgMedia = new MessageMedia(media.mimetype, media.data, media.filename);
        if (text) {
          options.caption = text;
        }
        return client.sendMessage(targetJid, msgMedia, options);
    }
    return client.sendMessage(targetJid, text, options);
    } catch (e) {
      if (isTransientWaError(e)) {
        isClientReady = false;
        lastState = 'DISCONNECTED';
        e.retryable = true;
        scheduleReinit(1000);
      }
      throw e;
    }
  }
});

async function waitForWaReady() {
  while (!isClientReady || !isWaConnected()) {
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function enqueueWaSend(target, text, meta = {}) {
  const payload = {
    text,
    media: meta.media,
  };

  if (meta.phoneNumber) {
    payload.phoneNumber = meta.phoneNumber;
  } else {
    payload.jid = target;
  }

  return waSendQueue.enqueue(payload, { jid: target || null, phoneNumber: meta.phoneNumber || null, meta });
}

function triggerReconnect() {
  if (reinitTimer) return false;
  if (isClientReady && isWaConnected()) return false;
  scheduleReinit(0);
  return true;
}

// CORS (allow calls from frontend)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Servir les fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

function bindClientEvents() {
client.on('qr', async (qr) => {
  console.log('QR Code généré');
  isClientReady = false;
  lastQr = qr;
  try {
    console.log('Scanne ce QR avec WhatsApp > Appareils liés (Linked devices):');
    qrcodeTerminal.generate(qr, { small: true });
  } catch (e) {
    console.warn('Impossible d\'afficher le QR en ASCII:', e?.message);
  }
  
  try {
      const qrDataUrl = await QRCodeLib.toDataURL(qr);
      io.emit('qr', { qr, qrDataUrl });
  } catch(e) {
      io.emit('qr', { qr });
  }
});

client.on('ready', () => {
  console.log('Client prêt ✅');
  isClientReady = true;
  lastState = 'CONNECTED';
  lastQr = null;
  connectedWithoutReadySince = null;
  readyRecoveryFailures = 0;
  lastReadyAt = Date.now();
  io.emit('ready');
});

client.on('authenticated', () => {
  console.log('Authentifié ✅');
  io.emit('authenticated');
});

client.on('auth_failure', (msg) => {
  console.error('Erreur d\'authentification :', msg);
  isClientReady = false;
  lastState = 'AUTH_FAILURE';
  io.emit('auth_failure', msg);
  scheduleReinit(5000);
});

client.on('disconnected', (reason) => {
  console.log('Déconnecté :', reason);
  isClientReady = false;
  lastState = 'DISCONNECTED';
  io.emit('disconnected', reason);
  scheduleReinit(3000);
});

client.on('change_state', (state) => {
  lastState = state || lastState;
});

// Gérer les connexions Socket.IO
}

bindClientEvents();

io.on('connection', async (socket) => {
  console.log('Nouveau client connecté');

  // Envoyer l'état actuel du client
  if (isClientReady) {
    socket.emit('ready');
  } else if (lastQr) {
      try {
          const qrDataUrl = await QRCodeLib.toDataURL(lastQr);
          socket.emit('qr', { qr: lastQr, qrDataUrl });
      } catch(e) {}
  }

  socket.on('send_message', async ({ phoneNumber, message, media }) => {
    const { logEESend } = require('./lib/logger');
    try {
      const sendPromise = enqueueWaSend(null, message, { source: 'socket_io', media, phoneNumber });
      socket.emit('message_queued', {
        phoneNumber,
        queued: waSendQueue.stats().queued,
        waitingReconnect: !isClientReady || !isWaConnected(),
      });

      await sendPromise;
      logEESend({ phoneNumber, status: 'success', message, media });
      console.log('Message envoye a', phoneNumber);
      socket.emit('message_success', { phoneNumber });
    } catch (err) {
      logEESend({ phoneNumber, status: 'error', error: err.message || 'send_error', message, media });
      console.error('Erreur envoi message', err);
      socket.emit('message_error', err.message || 'Erreur lors de l\'envoi du message');
    }
  });

  // Batch send: enqueue all numbers at once, report back per number as they send
  socket.on('send_batch', ({ phones, message, media }) => {
    const { logEESend } = require('./lib/logger');
    if (!Array.isArray(phones) || phones.length === 0) {
      return socket.emit('batch_queued', { count: 0 });
    }

    for (const phoneNumber of phones) {
      enqueueWaSend(null, message, { source: 'socket_io_batch', media, phoneNumber })
        .then(() => {
          logEESend({ phoneNumber, status: 'success', message, media });
          socket.emit('message_success', { phoneNumber });
        })
        .catch((err) => {
          logEESend({ phoneNumber, status: 'error', error: err.message || 'send_error', message, media });
          socket.emit('message_error', err.message || 'Erreur lors de l\'envoi');
        });
    }

    socket.emit('batch_queued', {
      count: phones.length,
      queued: waSendQueue.stats().queued,
      waitingReconnect: !isClientReady || !isWaConnected(),
    });
    console.log(`[send_batch] ${phones.length} messages enqueued via socket`);
  });

  socket.on('disconnect', () => {
    console.log('Client déconnecté');
  });
});

// Helpers
function normalizeDigits(p) {
  return (p || '').toString().replace(/\D+/g, '');
}

function normalizePhone(phone) {
  let p = normalizeDigits(phone);
  if (!p) return p;
  if (p.startsWith('00') && p.length > 4) {
    p = p.slice(2);
  }

  const cc = (process.env.DEFAULT_CC || '').replace(/\D+/g, '');
  const looksInternational = p.length >= 8 && p.length <= 15 && !p.startsWith('0');

  // Local number with trunk prefix, for example 06... -> 2126...
  if (p.startsWith('0') && cc) {
    return cc + p.slice(1);
  }

  // Already looks like an international number, keep it as-is.
  if (looksInternational) {
    return p;
  }

  // Fallback for short local values when a default country code is configured.
  if (cc) {
    return cc + p;
  }

  return p;
}

function normalizeToJid(phone) {
  const digits = normalizePhone(phone);
  return `${digits}@c.us`;
}

// Daily reminders
const REMINDER_TZ = process.env.REMINDER_TZ || 'Africa/Casablanca';
const REMINDER_AT = process.env.REMINDER_AT || '08:00';

// Reminder time (HH:mm, 24h). Example: '15:57'
// Lecture depuis .env (REMINDER_AT), sinon par défaut 16:00

// Debug: Log effective configuration
console.log('[config] REMINDER_AT:', REMINDER_AT);
console.log('[config] REMINDER_TZ from env:', process.env.REMINDER_TZ);
console.log('[config] REMINDER_CRON from env (optional override):', process.env.REMINDER_CRON);

function cronFromReminderAt(reminderAt) {
  if (!reminderAt) {
    console.log('[config] cronFromReminderAt: reminderAt is empty/null');
    return null;
  }
  const m = String(reminderAt).trim().match(/^([01]?\d|2[0-3]):([0-5]?\d)$/);
  if (!m) {
    console.log('[config] cronFromReminderAt: invalid format for', reminderAt);
    return null;
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const cron = `${minute} ${hour} * * *`;
  console.log('[config] cronFromReminderAt: converted', reminderAt, 'to', cron);
  return cron;
}

const REMINDER_CRON = process.env.REMINDER_CRON || cronFromReminderAt(REMINDER_AT) || '0 8 * * *';
console.log('[config] Final REMINDER_CRON:', REMINDER_CRON);
const REMINDER_ONLY_ENVOYER_AUTO = (process.env.REMINDER_ONLY_ENVOYER_AUTO || 'true').toLowerCase() !== 'false';
const REMINDER_SEND_DELAY_MS = process.env.REMINDER_SEND_DELAY_MS ? Number(process.env.REMINDER_SEND_DELAY_MS) : 600;
const API_BASE_FOR_REMINDERS = process.env.API_BASE
  ? process.env.API_BASE.replace(/\/$/, '').replace(/\/api$/i, '') + '/api'
  : null;
const REMINDER_API_BASE = process.env.REMINDER_API_BASE || API_BASE_FOR_REMINDERS; // e.g. https://example.com/api
const REMINDER_API_KEY = process.env.REMINDER_API_KEY || process.env.TEMPLATE_API_KEY || null;

function isWaConnected() {
  return lastState === 'CONNECTED' || lastGetState === 'CONNECTED';
}

if (REMINDER_SOURCE === 'api') {
  if (!REMINDER_API_BASE) {
    console.warn('[reminders] REMINDER_SOURCE=api but REMINDER_API_BASE is missing; reminders disabled');
  } else {
    if (!REMINDER_API_KEY) {
      console.warn('[reminders] REMINDER_SOURCE=api but REMINDER_API_KEY is missing; backend may return 401');
    } else {
      console.log(`[reminders] api auth configured (keyLen=${String(REMINDER_API_KEY).length})`);
    }
    cron.schedule(
      REMINDER_CRON,
      async () => {
        try {
          const result = await runDailyTaskRemindersViaApi({
            client,
            apiBase: REMINDER_API_BASE,
            apiKey: REMINDER_API_KEY,
            normalizeToJid,
            isWaConnected,
            tz: REMINDER_TZ,
            onlyEnvoyerAuto: REMINDER_ONLY_ENVOYER_AUTO,
            sendMessage: enqueueWaSend,
            sendDelayMs: 0,
            logger: console,
          });
          console.log('[reminders] done', result);
        } catch (e) {
          console.error('[reminders] job error', e);
        }
      },
      { timezone: REMINDER_TZ }
    );
    console.log(`[reminders] scheduled cron="${REMINDER_CRON}" tz="${REMINDER_TZ}" source=api onlyEnvoyerAuto=${REMINDER_ONLY_ENVOYER_AUTO}`);
  }
} else if (dbPool) {
  cron.schedule(
    REMINDER_CRON,
    async () => {
      try {
        const result = await runDailyTaskReminders({
          client,
          pool: dbPool,
          normalizeToJid,
          isWaConnected,
          tz: REMINDER_TZ,
          onlyEnvoyerAuto: REMINDER_ONLY_ENVOYER_AUTO,
          sendMessage: enqueueWaSend,
          sendDelayMs: 0,
          logger: console,
        });
        console.log('[reminders] done', result);
      } catch (e) {
        console.error('[reminders] job error', e);
      }
    },
    { timezone: REMINDER_TZ }
  );
  console.log(`[reminders] scheduled cron="${REMINDER_CRON}" tz="${REMINDER_TZ}" source=db onlyEnvoyerAuto=${REMINDER_ONLY_ENVOYER_AUTO}`);
}

// REST endpoints
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/status', async (_req, res) => {
  let state = lastState;
  const refreshed = await refreshClientState();
  if (refreshed) state = refreshed;
  res.json({
    ready: isClientReady && (state === 'CONNECTED' || lastState === 'CONNECTED'),
    state,
    lastState,
    sendQueue: waSendQueue.stats(),
    hasQr: !!lastQr,
    lastReadyAt,
    lastGetState,
    lastGetStateAt,
    now: Date.now()
  });
});

app.post('/reconnect', (_req, res) => {
  const scheduled = triggerReconnect();
  res.json({
    ok: true,
    scheduled,
    ready: isClientReady,
    state: lastState,
    sendQueue: waSendQueue.stats(),
  });
});

app.get('/qr', (_req, res) => {
  if (!lastQr) return res.status(404).json({ error: 'no_qr' });
  res.json({ qr: lastQr });
});

// Send plain text
app.post('/send-text', requireApiKey, async (req, res) => {
  try {
    const { phone, text } = req.body || {};
    let state = lastState;
    try { state = await client.getState(); } catch (_) {}
    const connected = isClientReady && (state === 'CONNECTED' || lastState === 'CONNECTED');
    if (!connected) {
      return res.status(503).json({ ok: false, error: 'wa_not_ready', state, lastState, isClientReady });
    }
    if (!phone || !text) return res.status(400).json({ ok: false, error: 'phone_and_text_required' });
    const jid = normalizeToJid(phone);
    const msg = await enqueueWaSend(jid, text, { source: 'manual_api', endpoint: '/send-text' });
    
    // Logger le message envoyé
    logReminder({
      type: 'reminder_success',
      date: new Date().toISOString().split('T')[0],
      request: { tel: phone, message: text, source: 'manual_api', endpoint: '/send-text' },
      response: { success: true, jid, messageId: msg.id?._serialized }
    });
    
    res.json({ ok: true, id: msg.id?._serialized });
  } catch (e) {
    console.error('send-text error', e);
    
    // Logger l'erreur
    logReminder({
      type: 'reminder_error',
      date: new Date().toISOString().split('T')[0],
      request: { tel: req.body?.phone, message: req.body?.text, source: 'manual_api', endpoint: '/send-text' },
      response: { success: false },
      error: e?.message || 'unknown'
    });
    
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Send plain text in batches (bypasses waSendQueue rate-limit)
// Body example:
// {
//   "items": [{"phone":"+2126...","text":"..."}],
//   "batchSize": 10,
//   "minDelaySec": 3,
//   "maxDelaySec": 10,
//   "batchPauseSec": 60
// }
app.post('/send-text-batch', requireApiKey, async (req, res) => {
  try {
    let state = lastState;
    try { state = await client.getState(); } catch (_) {}
    const connected = isClientReady && (state === 'CONNECTED' || lastState === 'CONNECTED');
    if (!connected) {
      return res.status(503).json({ ok: false, error: 'wa_not_ready', state, lastState, isClientReady });
    }

    const body = req.body || {};
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0) return res.status(400).json({ ok: false, error: 'items_required' });
    if (rawItems.length > 2000) return res.status(400).json({ ok: false, error: 'too_many_items', max: 2000 });

    const batchSize = clampInt(body.batchSize, { min: 1, max: 50, fallback: 10 });
    const batchPauseMs = clampInt(body.batchPauseSec, { min: 0, max: 3600, fallback: 60 }) * 1000;

    const items = rawItems.map((it, idx) => {
      const phone = it?.phone ?? it?.to ?? it?.tel ?? it?.recipient;
      const text = it?.text ?? it?.message;
      return { idx, phone, text };
    });

    const startedAt = Date.now();
    let invalid = 0;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      for (const item of batch) {
        const phone = item.phone;
        const text = item.text;
        if (!phone || !text) {
          invalid++;
          continue;
        }

        const jid = normalizeToJid(phone);
        enqueueWaSend(jid, text, {
          source: 'manual_api',
          endpoint: '/send-text-batch',
          index: item.idx,
          phoneNumber: phone,
        }).catch((e) => {
          logReminder({
            type: 'reminder_error',
            date: new Date().toISOString().split('T')[0],
            request: { tel: phone, message: text, source: 'manual_api', endpoint: '/send-text-batch' },
            response: { success: false, jid },
            error: e?.message || 'unknown'
          });
        });
      }

      // If more batches remain, optionally pause before adding next batch
      const hasMore = i + batchSize < items.length;
      if (hasMore && batchPauseMs > 0) {
        await sleep(batchPauseMs);
      }
    }

    const durationMs = Date.now() - startedAt;
    res.json({
      ok: true,
      requested: items.length,
      queued: items.length - invalid,
      invalid,
      nowQueued: waSendQueue.stats().queued,
      durationMs,
    });
  } catch (e) {
    console.error('send-text-batch error', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Send template rendered by Laravel API
app.post('/send-template', requireApiKey, async (req, res) => {
  try {
    const { phone, templateKey, params } = req.body || {};
    let state = lastState;
    try { state = await client.getState(); } catch (_) {}
    const connected = isClientReady && (state === 'CONNECTED' || lastState === 'CONNECTED');
    if (!connected) {
      return res.status(503).json({ ok: false, error: 'wa_not_ready', state, lastState, isClientReady });
    }
    if (!phone || !templateKey) return res.status(400).json({ ok: false, error: 'phone_and_templateKey_required' });

    const apiBase = process.env.API_BASE || 'http://localhost';
    const url = `${apiBase.replace(/\/$/, '')}/api/templates/render`;
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.TEMPLATE_API_KEY;
    if (apiKey) headers['X-Api-Key'] = apiKey;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: templateKey, params: params || {} })
    });
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`API render failed ${resp.status} ${t}`);
    }
    const data = await resp.json();
    const text = data?.text || '';
    if (!text) throw new Error('Rendered text empty');

    const jid = normalizeToJid(phone);
  const msg = await enqueueWaSend(jid, text, { source: 'manual_api', endpoint: '/send-template', templateKey });
    
    // Logger le message envoyé
    logReminder({
      type: 'reminder_success',
      date: new Date().toISOString().split('T')[0],
      request: { tel: phone, message: text, source: 'manual_api', endpoint: '/send-template', templateKey },
      response: { success: true, jid, messageId: msg.id?._serialized }
    });
    
    res.json({ ok: true, id: msg.id?._serialized });
  } catch (e) {
    console.error('send-template error', e);
    
    // Logger l'erreur
    logReminder({
      type: 'reminder_error',
      date: new Date().toISOString().split('T')[0],
      request: { tel: req.body?.phone, source: 'manual_api', endpoint: '/send-template', templateKey: req.body?.templateKey },
      response: { success: false },
      error: e?.message || 'unknown'
    });
    
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Endpoints pour les logs (nouveaux messages JSON uniquement)
app.get('/api/logs', async (req, res) => {
  try {
    const { limit, type, date, tel, exclude } = req.query;
    const options = {};
    
    if (limit) options.limit = parseInt(limit);
    if (type) options.type = type;
    if (date) options.date = date;

    // Liste des numéros à exclure (uniquement via query param)
    const defaultExcluded = [];
    const excludedNumbers = exclude ? [...defaultExcluded, ...exclude.split(',').map(n => n.trim())] : defaultExcluded;

    // Fonction pour normaliser et vérifier si un numéro est exclu
    const isExcluded = (phone) => {
      const normalized = normalizeDigits(phone);
      return excludedNumbers.some(ex => {
        const exNorm = normalizeDigits(ex);
        return normalized === exNorm || normalized.endsWith(exNorm) || exNorm.endsWith(normalized);
      });
    };

    // Récupérer tous les logs pour les erreurs
    const allLogs = getLogs({ date: options.date });
    
    // Séparer les erreurs et les succès, puis filtrer
    let errors = allLogs.filter(log => log.type === 'reminder_error' || log.type === 'error');
    let messages = getSentMessages({ limit: options.limit || 1000, date: options.date });

    // Filtrer par numéro de téléphone si spécifié
    if (tel) {
      const telNorm = normalizeDigits(tel);
      messages = messages.filter(msg => {
        const msgTel = normalizeDigits(msg.tel || '');
        return msgTel.includes(telNorm) || telNorm.includes(msgTel);
      });
      errors = errors.filter(err => {
        const errTel = normalizeDigits(err.request?.tel || '');
        return errTel.includes(telNorm) || telNorm.includes(errTel);
      });
    }

    // Exclure les numéros de la liste d'exclusion
    messages = messages.filter(msg => !isExcluded(msg.tel));
    errors = errors.filter(err => !isExcluded(err.request?.tel));

    // Calculer les statistiques (uniquement messages et erreurs, après filtres)
    const today = new Date().toISOString().split('T')[0];
    const todayMessages = messages.filter(msg => msg.timestamp && msg.timestamp.startsWith(today));
    const todayErrors = errors.filter(err => err.timestamp && err.timestamp.startsWith(today));

    const stats = {
      totalMessages: messages.length,
      totalErrors: errors.length,
      todayMessages: todayMessages.length,
      todayErrors: todayErrors.length,
      total: messages.length + errors.length,
      today: todayMessages.length + todayErrors.length
    };

    // Limiter les résultats après calcul des stats
    const limitedMessages = limit ? messages.slice(0, parseInt(limit)) : messages.slice(0, 100);
    const limitedErrors = errors.slice(0, 20);

    res.json({ 
      ok: true, 
      errors: limitedErrors,
      messages: limitedMessages, 
      stats,
      filters: {
        date: date || null,
        tel: tel || null,
        excluded: excludedNumbers,
        limit: limit || 100
      }
    });
  } catch (e) {
    console.error('[logs] Error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

app.get('/api/logs/messages', async (req, res) => {
  try {
    const { limit, date } = req.query;
    const options = {};
    
    if (limit) options.limit = parseInt(limit);
    if (date) options.date = date;

    const messages = getSentMessages(options);

    res.json({ ok: true, messages, total: messages.length });
  } catch (e) {
    console.error('[logs] Error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Endpoint statistiques désactivé - travail uniquement avec nouveaux messages JSON
// app.get('/api/logs/stats', ...);

// Endpoint backfill désactivé - travail uniquement avec JSON
// app.post('/api/logs/backfill-reminders', requireApiKey, async (req, res) => {
//   res.status(410).json({ ok: false, error: 'endpoint_disabled', message: 'Backfill désactivé - travail uniquement avec JSON' });
// });

app.delete('/api/logs', requireApiKey, (req, res) => {
  try {
    const result = clearLogs();
    res.json({ ok: true, cleared: result });
  } catch (e) {
    console.error('[logs] Error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// Test endpoint to manually trigger reminders
app.post('/api/send-reminder-test', requireApiKey, async (req, res) => {
  try {
    let state = 'UNKNOWN';
    try { state = await client.getState(); } catch (_) {}
    if (!isClientReady || state !== 'CONNECTED') {
      return res.status(503).json({ ok: false, error: 'wa_not_ready', state, message: 'WhatsApp client is not ready. Please scan QR code first.' });
    }

    console.log('[reminder-test] Manual reminder trigger started...');
    
    let result;
    if (REMINDER_SOURCE === 'api') {
      if (!REMINDER_API_BASE) {
        return res.status(500).json({ ok: false, error: 'REMINDER_API_BASE not configured' });
      }
      result = await runDailyTaskRemindersViaApi({
        client,
        apiBase: REMINDER_API_BASE,
        apiKey: REMINDER_API_KEY,
        normalizeToJid,
        isWaConnected,
        tz: REMINDER_TZ,
        onlyEnvoyerAuto: REMINDER_ONLY_ENVOYER_AUTO,
        sendMessage: enqueueWaSend,
        sendDelayMs: 0,
        logger: console,
      });
    } else if (dbPool) {
      result = await runDailyTaskReminders({
        client,
        pool: dbPool,
        normalizeToJid,
        isWaConnected,
        tz: REMINDER_TZ,
        onlyEnvoyerAuto: REMINDER_ONLY_ENVOYER_AUTO,
        sendMessage: enqueueWaSend,
        sendDelayMs: 0,
        logger: console,
      });
    } else {
      return res.status(500).json({ ok: false, error: 'no_reminder_source_configured' });
    }

    console.log('[reminder-test] Manual reminder completed:', result);
    res.json({ 
      ok: true, 
      result,
      config: {
        source: REMINDER_SOURCE,
        tz: REMINDER_TZ,
        cron: REMINDER_CRON,
        onlyEnvoyerAuto: REMINDER_ONLY_ENVOYER_AUTO
      }
    });
  } catch (e) {
    console.error('[reminder-test] Error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown', stack: e?.stack });
  }
});

initializeClient('startup');

// Keep state in sync even if events are missed (WhatsApp Web updates can cause that).
setInterval(() => {
  refreshClientState();
}, 15000).unref?.();

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log(`Serveur démarré sur http://${HOST}:${PORT}`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Erreur: le port ${PORT} est déjà utilisé sur ${HOST}.`);
    console.error('Astuce: arrête l\'autre service ou change PORT/HOST.');
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  clearTimeout(reinitTimer);
  try {
    await client.destroy();
  } catch (e) {
    console.warn('[wa] destroy during shutdown failed:', e?.message || e);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref?.();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
