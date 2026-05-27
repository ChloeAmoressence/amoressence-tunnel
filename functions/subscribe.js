/* ============================================================
   netlify/functions/subscribe.js
   Enregistre chaque lead depuis optin.html vers Google Sheets.
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
   Rate limiting — 5 req / min / IP
================================ */
const ipWindows = new Map();
const RL_MAX    = 5;
const RL_MS     = 60_000;

function isRateLimited(ip) {
  const now   = Date.now();
  const entry = ipWindows.get(ip) || { count: 0, resetAt: now + RL_MS };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RL_MS; }
  entry.count++;
  ipWindows.set(ip, entry);
  return entry.count > RL_MAX;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

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

  const { prenom, email, choix, type_choix, reponse_gpt } = payload;

  if (!email || !EMAIL_RE.test(String(email))) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email invalide' }) };
  }

  const ALLOWED_CHOIX      = new Set(['perdue', 'colere', 'prete', 'autre', '']);
  const ALLOWED_TYPE_CHOIX = new Set(['bouton', 'libre', '']);
  const MAX_LEN = 500;

  function sanitize(val) {
    const s = String(val || '').trim().slice(0, MAX_LEN);
    return /^[=+\-@]/.test(s) ? "'" + s : s;
  }

  const safePayload = {
    timestamp:   new Date().toISOString(),
    prenom:      sanitize(prenom),
    email:       sanitize(email),
    choix:       ALLOWED_CHOIX.has(String(choix))      ? sanitize(choix)      : '',
    type_choix:  ALLOWED_TYPE_CHOIX.has(String(type_choix)) ? sanitize(type_choix) : '',
    reponse_gpt: sanitize(reponse_gpt),
    page:        'optin',
    evenement:   'inscription'
  };

  try {
    await fetch(process.env.WEBHOOK_GS_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(safePayload)
    });
  } catch (err) {
    console.error('[subscribe] webhook GS exception:', err.constructor.name);
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
