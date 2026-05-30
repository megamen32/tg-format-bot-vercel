import MarkdownIt from 'markdown-it';
import { parseDocument } from 'htmlparser2';
import { getChildren, isText, isTag } from 'domutils';

const BOT_TOKEN = process.env.BOT_TOKEN;
const SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN || '';
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

const DEFAULT_SETTINGS = {
  mode: 'auto', // auto | html | tgmd | md
  replaceBad: true
};

const memorySettings = new Map();

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false
});

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function decodeBasicEntities(value = '') {
  return String(value)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
}

function stripControlChars(text = '') {
  return String(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n');
}

function normalizeLLMMarkdown(text = '', replaceBad = true) {
  let s = stripControlChars(text).trim();

  // Normalize separators often emitted by LLMs.
  s = s.replace(/^[—–-]{3,}\s*$/gm, '\n---\n');

  if (!replaceBad) return s;

  // Telegram HTML has no headings, tables, task lists or math renderer.
  // We keep the meaning and convert unsupported visual markers into readable Markdown first.
  s = s.replace(/^#{1,6}\s+(.+)$/gm, (_, title) => `**${title.trim()}**`);
  s = s.replace(/^\s*[-*+]\s+\[(x|X)\]\s+/gm, '☑ ');
  s = s.replace(/^\s*[-*+]\s+\[ \]\s+/gm, '☐ ');
  s = s.replace(/^\s*([*_-]){3,}\s*$/gm, '────────');
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, expr) => `\n\`\`\`text\n${expr.trim()}\n\`\`\`\n`);
  s = s.replace(/\$([^\n$]+)\$/g, (_, expr) => `\`${expr.trim()}\``);
  s = s.replace(/^\[\s*$/gm, '```text');
  s = s.replace(/^\]\s*$/gm, '```');
  return s;
}

function looksLikeHtml(text = '') {
  return /<\/?(?:b|strong|i|em|u|ins|s|strike|del|a|code|pre|blockquote|p|br|hr|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|div|span)\b[^>]*>/i.test(text);
}

function looksLikeMarkdown(text = '') {
  return /(^|\n)#{1,6}\s+|\*\*[^*]+\*\*|__[^_]+__|(^|\n)>\s+|(^|\n)\s*[-*+]\s+|(^|\n)\s*\d+\.\s+|```|`[^`]+`|\[[^\]]+\]\([^)]+\)|(^|\n)\|.+\|/m.test(text);
}

function getAttr(node, name) {
  return node?.attribs?.[name];
}

function textContent(node) {
  if (isText(node)) return node.data || '';
  return (getChildren(node) || []).map(textContent).join('');
}

function tableToText(tableNode) {
  const rows = [];
  const walk = (node) => {
    if (isTag(node) && node.name === 'tr') {
      const cells = (getChildren(node) || [])
        .filter((c) => isTag(c) && ['td', 'th'].includes(c.name))
        .map((c) => textContent(c).replace(/\s+/g, ' ').trim());
      if (cells.length) rows.push(cells);
    }
    for (const child of getChildren(node) || []) walk(child);
  };
  walk(tableNode);
  if (!rows.length) return '';
  const widths = [];
  for (const row of rows) row.forEach((cell, i) => widths[i] = Math.max(widths[i] || 0, cell.length));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i] || 0)).join(' | ')).join('\n');
}

function renderChildren(node, ctx = {}) {
  return (getChildren(node) || []).map((child) => renderNode(child, ctx)).join('');
}

function renderNode(node, ctx = {}) {
  if (isText(node)) return escapeHtml(stripControlChars(node.data || ''));
  if (!isTag(node)) return renderChildren(node, ctx);

  const name = node.name.toLowerCase();
  const inner = () => renderChildren(node, ctx);
  const block = (content) => content.trim() ? `${content.trim()}\n\n` : '';

  switch (name) {
    case 'b':
    case 'strong': return `<b>${inner()}</b>`;
    case 'i':
    case 'em': return `<i>${inner()}</i>`;
    case 'u':
    case 'ins': return `<u>${inner()}</u>`;
    case 's':
    case 'strike':
    case 'del': return `<s>${inner()}</s>`;
    case 'tg-spoiler': return `<tg-spoiler>${inner()}</tg-spoiler>`;
    case 'span': {
      const cls = getAttr(node, 'class') || '';
      if (/tg-spoiler/i.test(cls)) return `<tg-spoiler>${inner()}</tg-spoiler>`;
      return inner();
    }
    case 'a': {
      const href = getAttr(node, 'href') || '';
      if (/^(https?:\/\/|tg:\/\/user\?id=)/i.test(href)) {
        return `<a href="${escapeHtml(href)}">${inner()}</a>`;
      }
      return inner();
    }
    case 'code': return `<code>${escapeHtml(decodeBasicEntities(textContent(node)))}</code>`;
    case 'pre': return `<pre>${escapeHtml(decodeBasicEntities(textContent(node)).replace(/^\n+|\n+$/g, ''))}</pre>\n\n`;
    case 'blockquote': return block(`<blockquote>${inner().trim()}</blockquote>`);
    case 'br': return '\n';
    case 'hr': return '────────\n\n';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': return block(`<b>${inner().trim()}</b>`);
    case 'p':
    case 'div':
    case 'section':
    case 'article': return block(inner());
    case 'ul': return `${renderChildren(node, { ...ctx, list: 'ul', depth: (ctx.depth || 0) + 1 })}\n`;
    case 'ol': return `${renderChildren(node, { ...ctx, list: 'ol', index: 1, depth: (ctx.depth || 0) + 1 })}\n`;
    case 'li': {
      const depth = Math.max((ctx.depth || 1) - 1, 0);
      const prefix = ctx.list === 'ol' ? `${ctx.index || 1}. ` : '• ';
      if (ctx.list === 'ol') ctx.index = (ctx.index || 1) + 1;
      return `${'  '.repeat(depth)}${prefix}${inner().trim()}\n`;
    }
    case 'table': return `<pre>${escapeHtml(tableToText(node))}</pre>\n\n`;
    case 'thead':
    case 'tbody':
    case 'tr':
    case 'td':
    case 'th': return inner();
    case 'img': {
      const alt = getAttr(node, 'alt');
      const src = getAttr(node, 'src');
      if (alt) return escapeHtml(alt);
      if (src) return escapeHtml(src);
      return '';
    }
    default: return inner();
  }
}

function compactTelegramHtml(html = '') {
  return html
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToTelegramHtml(html = '') {
  const doc = parseDocument(stripControlChars(html), { decodeEntities: true });
  return compactTelegramHtml(renderChildren(doc));
}

function markdownToTelegramHtml(text = '', replaceBad = true) {
  const normalized = normalizeLLMMarkdown(text, replaceBad);
  const rendered = md.render(normalized);
  return htmlToTelegramHtml(rendered);
}

function markdownV2EscapePlain(text = '') {
  return stripControlChars(text).replace(/([_\*\[\]\(\)~`>#+\-=|{}.!\\])/g, '\\$1');
}

function chooseMode(text, settings) {
  if (settings.mode !== 'auto') return settings.mode;
  if (looksLikeHtml(text)) return 'html';
  if (looksLikeMarkdown(text)) return 'md';
  return 'md';
}

function convertMessage(text, settings) {
  const mode = chooseMode(text, settings);
  if (mode === 'html') return { text: htmlToTelegramHtml(text), parse_mode: 'HTML' };
  if (mode === 'tgmd') return { text: stripControlChars(text).trim(), parse_mode: 'MarkdownV2' };
  return { text: markdownToTelegramHtml(text, settings.replaceBad), parse_mode: 'HTML' };
}

function plainTextFromHtmlish(text = '') {
  const doc = parseDocument(text, { decodeEntities: true });
  return compactTelegramHtml(textContent(doc) || text);
}

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.description || `Telegram ${method} failed`);
  return data.result;
}

function splitMessage(text, limit = 3900) {
  const chunks = [];
  let s = text;
  while (s.length > limit) {
    let cut = s.lastIndexOf('\n\n', limit);
    if (cut < 1000) cut = s.lastIndexOf('\n', limit);
    if (cut < 1000) cut = limit;
    chunks.push(s.slice(0, cut));
    s = s.slice(cut).trimStart();
  }
  if (s) chunks.push(s);
  return chunks;
}

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  const data = await res.json().catch(() => null);
  if (!data?.result) return null;
  try { return JSON.parse(data.result); } catch { return data.result; }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  await fetch(`${KV_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  return true;
}

async function getSettings(chatId) {
  const key = `settings:${chatId}`;
  const stored = await kvGet(key);
  if (stored) return { ...DEFAULT_SETTINGS, ...stored };
  return { ...DEFAULT_SETTINGS, ...(memorySettings.get(key) || {}) };
}

async function saveSettings(chatId, settings) {
  const key = `settings:${chatId}`;
  memorySettings.set(key, settings);
  await kvSet(key, settings).catch(() => false);
}

function helpText(settings) {
  return [
    '<b>Бот форматирования</b>',
    '',
    'Пришли текст в Markdown или HTML. Я верну его как красиво отформатированное Telegram-сообщение.',
    '',
    '<b>Текущие настройки</b>',
    `Режим: <code>${settings.mode}</code>`,
    `Автозамены: <code>${settings.replaceBad ? 'on' : 'off'}</code>`,
    '',
    '<b>Команды</b>',
    '<code>/mode auto</code> — автоопределение',
    '<code>/mode html</code> — вход как HTML',
    '<code>/mode md</code> — обычный Markdown от ChatGPT/DeepSeek/Z.ai',
    '<code>/mode tgmd</code> — Telegram MarkdownV2 без конвертации',
    '<code>/replace on</code> — чинить заголовки, hr, чеклисты, LaTeX',
    '<code>/replace off</code> — не чинить',
    '<code>/settings</code> — показать настройки',
    '',
    '<b>Лучший режим по умолчанию</b>: <code>auto</code> + <code>replace on</code>.'
  ].join('\n');
}

async function handleCommand(chatId, text) {
  const settings = await getSettings(chatId);
  const [commandRaw, argRaw] = text.trim().split(/\s+/, 2);
  const command = commandRaw.split('@')[0].toLowerCase();
  const arg = (argRaw || '').toLowerCase();

  if (command === '/start' || command === '/help' || command === '/settings') {
    await tg('sendMessage', { chat_id: chatId, text: helpText(settings), parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  }

  if (command === '/mode') {
    const aliases = { markdown: 'md', telegrammarkdown: 'tgmd', telegram: 'tgmd', html: 'html', auto: 'auto', md: 'md', tgmd: 'tgmd' };
    const mode = aliases[arg];
    if (!mode) {
      await tg('sendMessage', { chat_id: chatId, text: 'Режимы: <code>auto</code>, <code>html</code>, <code>md</code>, <code>tgmd</code>.', parse_mode: 'HTML' });
      return true;
    }
    const next = { ...settings, mode };
    await saveSettings(chatId, next);
    await tg('sendMessage', { chat_id: chatId, text: `Готово. Режим: <code>${mode}</code>.`, parse_mode: 'HTML' });
    return true;
  }

  if (command === '/replace') {
    const value = ['on', 'yes', 'true', '1', 'да'].includes(arg) ? true : ['off', 'no', 'false', '0', 'нет'].includes(arg) ? false : null;
    if (value === null) {
      await tg('sendMessage', { chat_id: chatId, text: 'Используй <code>/replace on</code> или <code>/replace off</code>.', parse_mode: 'HTML' });
      return true;
    }
    const next = { ...settings, replaceBad: value };
    await saveSettings(chatId, next);
    await tg('sendMessage', { chat_id: chatId, text: `Готово. Автозамены: <code>${value ? 'on' : 'off'}</code>.`, parse_mode: 'HTML' });
    return true;
  }

  return false;
}

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg?.chat?.id) return;

  const chatId = msg.chat.id;
  const input = msg.text || msg.caption || '';
  if (!input.trim()) return;

  if (input.startsWith('/') && await handleCommand(chatId, input)) return;

  const settings = await getSettings(chatId);
  const converted = convertMessage(input, settings);

  for (const chunk of splitMessage(converted.text || '')) {
    try {
      await tg('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: converted.parse_mode,
        disable_web_page_preview: true,
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true
      });
    } catch (e) {
      const fallback = plainTextFromHtmlish(chunk);
      await tg('sendMessage', {
        chat_id: chatId,
        text: fallback.slice(0, 3900) || 'Не удалось отрендерить: Telegram отклонил разметку.',
        reply_to_message_id: msg.message_id,
        allow_sending_without_reply: true
      });
    }
  }
}

export default async function handler(req, res) {
  if (!BOT_TOKEN) return res.status(500).send('BOT_TOKEN is not set');

  if (req.method === 'GET') return res.status(200).send('OK');
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  if (SECRET_TOKEN && req.headers['x-telegram-bot-api-secret-token'] !== SECRET_TOKEN) {
    return res.status(403).send('Forbidden');
  }

  try {
    await handleUpdate(req.body);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(200).json({ ok: false });
  }
}
