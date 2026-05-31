const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME_ENV = process.env.BOT_USERNAME || process.env.NEXT_PUBLIC_BOT_USERNAME || '';
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

let cachedBotUsername = '';

function stripControlChars(text = '') {
  return String(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function makeShortToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
}

function toBase64Url(value = '') {
  return Buffer.from(String(value), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  const res = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!res.ok) throw new Error(`KV set failed: ${res.status}`);
  return true;
}

async function tg(method, payload = {}) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN is not set');
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

async function getBotUsername() {
  if (BOT_USERNAME_ENV) return BOT_USERNAME_ENV.replace(/^@/, '');
  if (cachedBotUsername) return cachedBotUsername;
  const me = await tg('getMe');
  cachedBotUsername = me?.username || '';
  return cachedBotUsername;
}

async function createDeepLink(text, { mode = null } = {}) {
  const username = await getBotUsername();
  if (!username) throw new Error('BOT_USERNAME is not set and getMe did not return username');

  const cleanText = stripControlChars(text);
  if (!cleanText) throw new Error('Text is empty');

  const safeMode = ['auto', 'html', 'md', 'tgmd'].includes(mode) ? mode : null;
  const prefix = safeMode ? ({ auto: 'a64_', html: 'h64_', md: 'm64_', tgmd: 't64_' }[safeMode]) : 'b64_';
  const shortPayload = `${prefix}${toBase64Url(cleanText)}`;

  if (shortPayload.length <= 64) {
    return {
      ok: true,
      url: `https://t.me/${username}?start=${shortPayload}`,
      payload: shortPayload,
      storage: 'inline',
      requiresKv: false
    };
  }

  if (!KV_URL || !KV_TOKEN) {
    const error = new Error('Long deep links require KV_REST_API_URL and KV_REST_API_TOKEN');
    error.status = 413;
    throw error;
  }

  const token = makeShortToken();
  const payload = `fmt_${token}`;
  await kvSet(`deeplink:${token}`, {
    text: cleanText,
    mode: safeMode,
    createdAt: Date.now(),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
  });

  return {
    ok: true,
    url: `https://t.me/${username}?start=${payload}`,
    payload,
    storage: 'kv',
    requiresKv: true
  };
}

async function readBody(req) {
  if (req.method === 'GET') return req.query || {};
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return { text: req.body }; }
  }
  return req.body;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const body = await readBody(req);
    const text = body.text || body.t || '';
    const mode = body.mode || null;
    const redirect = body.redirect === '1' || body.redirect === 'true';
    const link = await createDeepLink(text, { mode });

    if (redirect) {
      res.setHeader('Location', link.url);
      return res.status(302).end();
    }

    return res.status(200).json(link);
  } catch (error) {
    return res.status(error.status || 500).json({
      ok: false,
      error: error.message || 'Unknown error',
      hint: 'For long texts connect Vercel KV / Upstash or use a shorter text so it fits into the 64-char Telegram start payload.'
    });
  }
}
