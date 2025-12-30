'use strict';

const { DateTime } = require('luxon');
const { logReminder } = require('../lib/logger');

function getTodayDateString(tz) {
  return DateTime.now().setZone(tz).toISODate(); // YYYY-MM-DD
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeReminderText(row) {
  const assignee = [row.prenom, row.name].filter(Boolean).join(' ').trim() || '—';

  const start = row.effective_start || row.start_date || '—';
  const end = row.effective_end || row.end_date || '—';
  const pct = row.pourcentage ?? 0;
  const label = row.description || row.title || `Tâche #${row.id}`;

  const project = row.project_title || row.projectTitle || '—';
  const list = row.list_title || row.listTitle || '—';
  const type = row.type || '—';
  const status = row.status || '—';

  return [
    `⏰ Rappel de tâche`,
    `📝 ${label}`,
    `📁 Projet: ${project}`,
    `📋 Liste: ${list}`,
    `🏷️ Statut: ${status}`,
    `📌 Type: ${type}`,
    `📊 Progression: ${pct}%`,
    `📅 Début: ${start}`,
    `⏳ Échéance: ${end}`,
    `👥 Assigné à: ${assignee}`,
  ].join('\n');
}

async function fetchTasksToRemindFromApi({ apiBase, apiKey, today, tz, onlyEnvoyerAuto }) {
  const base = (apiBase || '').replace(/\/$/, '');
  if (!base) throw new Error('REMINDER_API_BASE not configured');

  const url = `${base}/reminders/daily-tasks?date=${encodeURIComponent(today)}&tz=${encodeURIComponent(tz)}&onlyEnvoyerAuto=${onlyEnvoyerAuto ? 'true' : 'false'}`;
  const headers = { 'Accept': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;

  const resp = await fetch(url, { method: 'GET', headers });
  if (!resp.ok) {
    const t = await resp.text();
    if (resp.status === 401 || resp.status === 403) {
      const keyInfo = apiKey ? `keyLen=${String(apiKey).length}` : 'keyMissing';
      throw new Error(
        `Reminders API unauthorized (${resp.status}) (${keyInfo}). ` +
          `Check REMINDER_API_KEY matches sirh-back REMINDER_API_KEY and header "X-Api-Key" is allowed. Body=${t}`
      );
    }
    throw new Error(`Reminders API failed ${resp.status} ${t}`);
  }
  const data = await resp.json();
  return Array.isArray(data?.items) ? data.items : [];
}

async function fetchTasksToRemind(pool, today, { onlyEnvoyerAuto }) {
  // In this codebase, envoyer_auto is used as "already sent" for auto reminders.
  // When filtering is enabled, keep tasks that are NOT marked as sent.
  const whereAuto = onlyEnvoyerAuto ? 'AND (t.envoyer_auto IS NULL OR t.envoyer_auto = 0)' : '';

  const sql = `
    SELECT
      t.id,
      t.description,
      t.status,
      t.pourcentage,
      t.type,
      t.start_date,
      t.end_date,
      COALESCE(t.start_date, t.date_debut_prevu) AS effective_start,
      COALESCE(t.end_date, t.date_fin_prevu) AS effective_end,
      l.title AS list_title,
      p.titre AS project_title,
      u.name,
      u.prenom,
      u.tel
    FROM todo_tasks t
    LEFT JOIN todo_lists l ON l.id = t.todo_list_id
    LEFT JOIN projects p ON p.id = l.project_id
    JOIN users u ON u.id = t.assigned_to
    WHERE
      t.assigned_to IS NOT NULL
      AND u.tel IS NOT NULL
      AND TRIM(u.tel) <> ''
      AND COALESCE(t.start_date, t.date_debut_prevu) IS NOT NULL
      AND COALESCE(t.end_date, t.date_fin_prevu) IS NOT NULL
      AND COALESCE(t.start_date, t.date_debut_prevu) <= ?
      AND COALESCE(t.end_date, t.date_fin_prevu) >= ?
      AND t.status <> 'Terminée'
      AND (t.pourcentage IS NULL OR t.pourcentage < 100)
      ${whereAuto}
    ORDER BY u.id, t.id
  `;

  const [rows] = await pool.query(sql, [today, today]);
  return rows;
}

async function runDailyTaskReminders({
  client,
  pool,
  normalizeToJid,
  isWaConnected,
  tz,
  onlyEnvoyerAuto,
  sendDelayMs,
  logger = console,
}) {
  const today = getTodayDateString(tz);

  // Log début du reminder
  logReminder({
    type: 'reminder_start',
    date: today,
    request: { source: 'db', tz, onlyEnvoyerAuto }
  });

  if (!isWaConnected()) {
    logger.warn(`[reminders] WA not connected; skip (today=${today})`);
    const errorResult = { ok: false, skipped: true, reason: 'wa_not_connected', today };
    logReminder({
      type: 'reminder_error',
      date: today,
      request: { source: 'db', tz, onlyEnvoyerAuto },
      response: errorResult,
      error: 'WhatsApp non connecté'
    });
    return errorResult;
  }

  const tasks = await fetchTasksToRemind(pool, today, { onlyEnvoyerAuto });
  logger.log(`[reminders] tasks to remind=${tasks.length} (today=${today})`);

  // Log les tâches trouvées
  logReminder({
    type: 'reminder_tasks_found',
    date: today,
    request: { source: 'db', tz, onlyEnvoyerAuto, tasksCount: tasks.length },
    response: { tasks: tasks.map(t => ({ id: t.id, tel: t.tel, description: t.description })) }
  });

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const row of tasks) {
    try {
      const jid = normalizeToJid(row.tel);
      const text = makeReminderText(row);
      await client.sendMessage(jid, text);
      sent++;
      
      // Log succès d'envoi
      logReminder({
        type: 'reminder_success',
        date: today,
        request: { taskId: row.id, tel: row.tel, message: text },
        response: { success: true, jid }
      });
      
      if (sendDelayMs) await sleep(sendDelayMs);
    } catch (e) {
      failed++;
      const errorMsg = e?.message || e;
      errors.push({ taskId: row.id, tel: row.tel, error: errorMsg });
      logger.error(`[reminders] send failed taskId=${row.id} userTel=${row.tel} err=${errorMsg}`);
      
      // Log erreur d'envoi
      logReminder({
        type: 'reminder_error',
        date: today,
        request: { taskId: row.id, tel: row.tel },
        response: { success: false },
        error: errorMsg
      });
    }
  }

  const result = { ok: true, today, total: tasks.length, sent, failed, errors };
  
  // Log complétion
  logReminder({
    type: 'reminder_complete',
    date: today,
    request: { source: 'db', tz, onlyEnvoyerAuto },
    response: result
  });

  return result;
}

async function runDailyTaskRemindersViaApi({
  client,
  apiBase,
  apiKey,
  normalizeToJid,
  isWaConnected,
  tz,
  onlyEnvoyerAuto,
  sendDelayMs,
  logger = console,
}) {
  const today = getTodayDateString(tz);

  // Log début du reminder
  logReminder({
    type: 'reminder_start',
    date: today,
    request: { source: 'api', apiBase, tz, onlyEnvoyerAuto }
  });

  if (!isWaConnected()) {
    logger.warn(`[reminders] WA not connected; skip (today=${today})`);
    const errorResult = { ok: false, skipped: true, reason: 'wa_not_connected', today };
    logReminder({
      type: 'reminder_error',
      date: today,
      request: { source: 'api', apiBase, tz, onlyEnvoyerAuto },
      response: errorResult,
      error: 'WhatsApp non connecté'
    });
    return errorResult;
  }

  const tasks = await fetchTasksToRemindFromApi({ apiBase, apiKey, today, tz, onlyEnvoyerAuto });
  logger.log(`[reminders] tasks to remind=${tasks.length} (today=${today}) [source=api]`);

  // Log les tâches trouvées
  logReminder({
    type: 'reminder_tasks_found',
    date: today,
    request: { source: 'api', apiBase, tz, onlyEnvoyerAuto, tasksCount: tasks.length },
    response: { tasks: tasks.map(t => ({ id: t.id, tel: t.tel, description: t.description })) }
  });

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const row of tasks) {
    try {
      const jid = normalizeToJid(row.tel);
      const text = makeReminderText(row);
      await client.sendMessage(jid, text);
      sent++;
      
      // Log succès d'envoi
      logReminder({
        type: 'reminder_success',
        date: today,
        request: { taskId: row.id, tel: row.tel, message: text },
        response: { success: true, jid }
      });
      
      if (sendDelayMs) await sleep(sendDelayMs);
    } catch (e) {
      failed++;
      const errorMsg = e?.message || e;
      errors.push({ taskId: row.id, tel: row.tel, error: errorMsg });
      logger.error(`[reminders] send failed taskId=${row.id} userTel=${row.tel} err=${errorMsg}`);
      
      // Log erreur d'envoi
      logReminder({
        type: 'reminder_error',
        date: today,
        request: { taskId: row.id, tel: row.tel },
        response: { success: false },
        error: errorMsg
      });
    }
  }

  const result = { ok: true, today, total: tasks.length, sent, failed, errors, source: 'api' };
  
  // Log complétion
  logReminder({
    type: 'reminder_complete',
    date: today,
    request: { source: 'api', apiBase, tz, onlyEnvoyerAuto },
    response: result
  });

  return result;
}

module.exports = { runDailyTaskReminders, runDailyTaskRemindersViaApi };
