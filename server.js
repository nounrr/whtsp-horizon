const path = require('path');

// Load environment variables from .env (use absolute path so it works under PM2/systemd)
const dotenvResult = require('dotenv').config({ path: path.join(__dirname, '.env') });
if (dotenvResult?.error) {
  console.warn('[config] .env not loaded:', dotenvResult.error.message);
}

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const qrcodeTerminal = require('qrcode-terminal');
const cron = require('node-cron');
const multer = require('multer');
const fs = require('fs');

const { createPoolFromEnv } = require('./lib/db');
// const { runDailyTaskReminders, runDailyTaskRemindersViaApi } = require('./reminders/dailyTaskReminders');
const { getLogs, getSentMessages, clearLogs, logReminder } = require('./lib/logger');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Security: simple API key protection for send endpoints
const API_KEY = process.env.WA_API_KEY || null;

function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ ok: false, error: 'api_key_not_configured' });
  const provided = req.get('x-api-key');
  if (!provided || provided !== API_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    // If Chrome is installed locally, you can set CHROME_PATH env to its executable
    executablePath: process.env.CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote']
  }
});

// REMINDERS DÉSACTIVÉS
// const REMINDER_SOURCE = (process.env.REMINDER_SOURCE || 'db').toLowerCase(); // 'db' | 'api'

// DB pool (SIRH back database)
// let dbPool = null;
// if (REMINDER_SOURCE !== 'api') {
//   try {
//     dbPool = createPoolFromEnv();
//     console.log('[db] MySQL pool created');
//   } catch (e) {
//     console.warn('[db] Not configured, reminders disabled until DB_* env vars are set:', e?.message);
//   }
// }

let isClientReady = false;
let lastQr = null;
let lastState = 'INIT';
let lastReadyAt = null;
let reinitTimer = null;
function scheduleReinit(delayMs = 3000) {
  if (reinitTimer) return;
  reinitTimer = setTimeout(() => {
    reinitTimer = null;
    try {
      console.log('Reinitialisation du client WhatsApp...');
      client.initialize();
    } catch (e) {
      console.warn('Erreur lors de la réinitialisation:', e?.message);
    }
  }, delayMs);
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
app.use(express.json({ limit: '10mb' }));

// Configuration multer pour l'upload de fichiers
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB max
  }
});

client.on('qr', (qr) => {
  console.log('QR Code généré');
  isClientReady = false;
  lastQr = qr;
  try {
    console.log('Scanne ce QR avec WhatsApp > Appareils liés (Linked devices):');
    qrcodeTerminal.generate(qr, { small: true });
  } catch (e) {
    console.warn('Impossible d\'afficher le QR en ASCII:', e?.message);
  }
  io.emit('qr', qr);
});

client.on('ready', () => {
  console.log('Client prêt ✅');
  isClientReady = true;
  lastState = 'CONNECTED';
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
io.on('connection', (socket) => {
  console.log('Nouveau client connecté');

  // Envoyer l'état actuel du client
  if (isClientReady) {
    socket.emit('ready');
  }

  socket.on('send_message', async ({ phoneNumber, message }) => {
    try {
      // Vérifier que le client est prêt
      if (!isClientReady) {
        socket.emit('message_error', 'Le client WhatsApp n\'est pas encore prêt. Veuillez scanner le QR code.');
        return;
      }

      const chatId = normalizeToJid(phoneNumber);
      
      // Vérifier que le numéro est valide
      const numberId = await client.getNumberId(chatId.replace('@c.us',''));
      if (!numberId) {
        socket.emit('message_error', 'Numéro WhatsApp invalide ou non enregistré');
        return;
      }

      await client.sendMessage(chatId, message);
      console.log('Message envoyé à', phoneNumber);
      socket.emit('message_success', { phoneNumber });
    } catch (err) {
      console.error('Erreur envoi message ❌', err);
      socket.emit('message_error', err.message || 'Erreur lors de l\'envoi du message');
    }
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
  // If starts with 0 and DEFAULT_CC is provided, use it (e.g. 212)
  if (p.startsWith('0') && process.env.DEFAULT_CC) {
    p = process.env.DEFAULT_CC.replace(/\D+/g, '') + p.slice(1);
  }
  // If no country code, default to 212 if provided via env or fallback to 212
  if (!p.startsWith('212') && process.env.DEFAULT_CC) {
    const cc = process.env.DEFAULT_CC.replace(/\D+/g, '');
    if (cc && !p.startsWith(cc)) p = cc + p;
  }
  return p;
}

function normalizeToJid(phone) {
  const digits = normalizePhone(phone);
  return `${digits}@c.us`;
}

// Daily reminders - DÉSACTIVÉS
// const REMINDER_TZ = process.env.REMINDER_TZ || 'Africa/Casablanca';
// const REMINDER_AT = '16:00';
// const REMINDER_CRON = process.env.REMINDER_CRON || cronFromReminderAt(REMINDER_AT) || '0 8 * * *';
// const REMINDER_ONLY_ENVOYER_AUTO = (process.env.REMINDER_ONLY_ENVOYER_AUTO || 'true').toLowerCase() !== 'false';
// const REMINDER_SEND_DELAY_MS = process.env.REMINDER_SEND_DELAY_MS ? Number(process.env.REMINDER_SEND_DELAY_MS) : 600;
// const REMINDER_API_BASE = process.env.REMINDER_API_BASE || null;
// const REMINDER_API_KEY = process.env.REMINDER_API_KEY || process.env.TEMPLATE_API_KEY || null;

console.log('[config] Reminders automatiques désactivés');

// REST endpoints
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/status', async (_req, res) => {
  let state = lastState;
  try {
    state = await client.getState();
  } catch (e) {
    // keep lastState
  }
  res.json({
    ready: isClientReady && (state === 'CONNECTED' || lastState === 'CONNECTED'),
    state,
    lastState,
    hasQr: !!lastQr,
    lastReadyAt,
    now: Date.now()
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
    const msg = await client.sendMessage(jid, text);
    
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
    const msg = await client.sendMessage(jid, text);
    
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

// Test endpoint to manually trigger reminders - DÉSACTIVÉ
// app.post('/api/send-reminder-test', requireApiKey, async (req, res) => {
//   res.status(410).json({ ok: false, error: 'reminders_disabled', message: 'Les reminders automatiques sont désactivés' });
// });

// Endpoint pour l'envoi en masse avec support image/document
app.post('/api/send-bulk', upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'document', maxCount: 1 }
]), async (req, res) => {
  try {
    // Vérifier l'état de WhatsApp
    let state = 'UNKNOWN';
    try { state = await client.getState(); } catch (_) {}
    const connected = isClientReady && (state === 'CONNECTED' || lastState === 'CONNECTED');
    
    if (!connected) {
      return res.status(503).json({ 
        ok: false, 
        error: 'wa_not_ready', 
        state, 
        lastState, 
        isClientReady,
        message: 'WhatsApp client is not ready. Please scan QR code first.' 
      });
    }

    // Récupérer les données
    const { message, phones } = req.body;
    
    if (!message || !phones) {
      return res.status(400).json({ ok: false, error: 'message_and_phones_required' });
    }

    // Parser les numéros de téléphone
    let phoneList;
    try {
      phoneList = JSON.parse(phones);
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'invalid_phones_format', message: 'phones must be a JSON array' });
    }

    if (!Array.isArray(phoneList) || phoneList.length === 0) {
      return res.status(400).json({ ok: false, error: 'phones_must_be_array' });
    }

    console.log(`[bulk-send] Starting bulk send to ${phoneList.length} numbers...`);

    // Préparer les fichiers média si présents
    let imageMedia = null;
    let documentMedia = null;

    if (req.files && req.files['image'] && req.files['image'][0]) {
      const imageFile = req.files['image'][0];
      // Créer MessageMedia avec mimetype explicite pour images
      imageMedia = new MessageMedia(
        imageFile.mimetype,
        fs.readFileSync(imageFile.path, { encoding: 'base64' }),
        imageFile.originalname
      );
      console.log(`[bulk-send] Image attached: ${imageFile.originalname} (${imageFile.mimetype})`);
    }

    if (req.files && req.files['document'] && req.files['document'][0]) {
      const documentFile = req.files['document'][0];
      documentMedia = new MessageMedia(
        documentFile.mimetype,
        fs.readFileSync(documentFile.path, { encoding: 'base64' }),
        documentFile.originalname
      );
      console.log(`[bulk-send] Document attached: ${documentFile.originalname}`);
    }

    // Envoyer les messages
    const results = {
      sent: 0,
      failed: 0,
      errors: []
    };

    for (const phone of phoneList) {
      try {
        const jid = normalizeToJid(phone);
        
        // Vérifier que le numéro existe sur WhatsApp
        try {
          const numberId = await client.getNumberId(jid.replace('@c.us', ''));
          if (!numberId) {
            throw new Error('Number not registered on WhatsApp');
          }
        } catch (checkError) {
          console.warn(`[bulk-send] Invalid number ${phone}:`, checkError.message);
          results.failed++;
          results.errors.push({ phone, error: 'not_on_whatsapp' });
          continue;
        }

        // Envoyer le message texte
        const sentMsg = await client.sendMessage(jid, message);
        
        // Envoyer l'image comme média (séparé)
        if (imageMedia) {
          await client.sendMessage(jid, imageMedia);
        }
        
        // Envoyer le document si présent
        if (documentMedia) {
          await client.sendMessage(jid, documentMedia, { caption: 'Document joint' });
        }

        results.sent++;
        if ((process.env.BULK_VERBOSE_LOGS || 'false').toLowerCase() === 'true') {
          console.log(`[bulk-send] Sent to ${phone}`);
        }

        // Logger le succès
        logReminder({
          type: 'reminder_success',
          date: new Date().toISOString().split('T')[0],
          request: { 
            tel: phone, 
            message: message, 
            source: 'bulk_send',
            hasImage: !!imageMedia,
            hasDocument: !!documentMedia
          },
          response: { success: true, jid, messageId: sentMsg?.id?._serialized }
        });

        // Petit délai pour éviter de surcharger WhatsApp
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error(`[bulk-send] Failed to send to ${phone}:`, error.message);
        results.failed++;
        results.errors.push({ phone, error: error.message });

        // Logger l'erreur
        logReminder({
          type: 'reminder_error',
          date: new Date().toISOString().split('T')[0],
          request: { 
            tel: phone, 
            message: message, 
            source: 'bulk_send' 
          },
          response: { success: false },
          error: error.message
        });
      }
    }

    // Nettoyer les fichiers temporaires
    if (req.files) {
      if (req.files['image'] && req.files['image'][0]) {
        fs.unlinkSync(req.files['image'][0].path);
      }
      if (req.files['document'] && req.files['document'][0]) {
        fs.unlinkSync(req.files['document'][0].path);
      }
    }

    console.log(`[bulk-send] Completed: ${results.sent} sent, ${results.failed} failed`);

    res.json({
      ok: true,
      sent: results.sent,
      failed: results.failed,
      total: phoneList.length,
      errors: results.errors
    });

  } catch (e) {
    console.error('[bulk-send] Error:', e);
    
    // Nettoyer les fichiers temporaires en cas d'erreur
    if (req.files) {
      if (req.files['image'] && req.files['image'][0]) {
        try { fs.unlinkSync(req.files['image'][0].path); } catch (_) {}
      }
      if (req.files['document'] && req.files['document'][0]) {
        try { fs.unlinkSync(req.files['document'][0].path); } catch (_) {}
      }
    }
    
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

client.initialize();

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
