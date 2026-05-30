/* ============================================================
   netlify/functions/track.js
   Reçoit n'importe quel événement du front et le relaie
   au webhook Google Sheets.
   Variables d'environnement Netlify requises :
     WEBHOOK_GS_URL  — URL du webhook Google Sheets
     ALLOWED_ORIGIN  — domaine autorisé (ex: https://amoressence.netlify.app)
============================================================ */

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

function corsHeaders(requestOrigin) {
  const origin = requestOrigin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : '';
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/* ================================
   Rate limiting — 30 req / min / IP
   Partiel : se remet à zéro au cold start.
================================ */
const ipWindows = new Map();
const RL_MAX    = 30;
const RL_MS     = 60_000;

function isRateLimited(ip) {
  const now   = Date.now();
  const entry = ipWindows.get(ip) || { count: 0, resetAt: now + RL_MS };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RL_MS; }
  entry.count++;
  ipWindows.set(ip, entry);
  return entry.count > RL_MAX;
}

exports.handler = async function (event) {
  const headers = corsHeaders(event.headers.origin || '');

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  const ip = event.headers['x-nf-client-connection-ip']
          || event.headers['x-forwarded-for']?.split(',')[0].trim()
          || 'unknown';

  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ error: 'Too many requests' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON invalide' }) };
  }

  const ALLOWED_FIELDS = ['timestamp', 'prenom', 'email', 'choix',
                          'type_choix', 'message_libre', 'reponse_gpt', 'page', 'evenement'];
  const MAX_LEN = 500;

  const safePayload = {};
  for (const key of ALLOWED_FIELDS) {
    if (payload[key] !== undefined) {
      const val = String(payload[key]).slice(0, MAX_LEN);
      // Neutralise les formules Google Sheets (=, +, -, @)
      safePayload[key] = /^[=+\-@]/.test(val) ? "'" + val : val;
    }
  }
  safePayload.timestamp = safePayload.timestamp || new Date().toISOString();

  try {
    await fetch(process.env.WEBHOOK_GS_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(safePayload)
    });
  } catch (err) {
    console.error('[track] webhook GS exception:', err.constructor.name);
    return {
      statusCode: 200,
      headers:    { ...headers, 'Content-Type': 'application/json' },
      body:       JSON.stringify({ success: false })
    };
  }

  return {
    statusCode: 200,
    headers:    { ...headers, 'Content-Type': 'application/json' },
    body:       JSON.stringify({ success: true })
  };
};
