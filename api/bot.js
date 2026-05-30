import MarkdownIt from 'markdown-it';
import { parseDocument } from 'htmlparser2';
import { getChildren, isText, isTag } from 'domutils';

const BOT_TOKEN = process.env.BOT_TOKEN;
const SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN || '';
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

const DEFAULT_SETTINGS = {
  mode: 'auto', // auto | html | tgmd | md
  replaceBad: true,
  mergeEntities: true,
  removeAiSeparators: true
};

const memorySettings = new Map();

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false
});

const mdWithHtml = new MarkdownIt({
  html: true,
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

function isFenceLine(line = '') {
  return /^\s*(```|~~~)/.test(line);
}

function isAiSeparatorLine(line = '') {
  return /^\s*(?:-{3,}|[—–]{1,}|_{3,}|\*{3,})\s*$/.test(line);
}

function normalizeAiSeparators(text = '', { removeAiSeparators = true, replaceBad = true } = {}) {
  const lines = String(text).split('\n');
  const out = [];
  let inFence = false;

  for (const line of lines) {
    if (isFenceLine(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }

    if (!inFence && isAiSeparatorLine(line)) {
      if (removeAiSeparators) continue;
      out.push(replaceBad ? '────────' : line);
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

function normalizeLLMMarkdown(text = '', settings = DEFAULT_SETTINGS) {
  const replaceBad = settings.replaceBad !== false;
  let s = stripControlChars(text).trim();

  s = normalizeAiSeparators(s, settings);

  if (!replaceBad) {
    return compactPlainNewlines(s);
  }

  // Telegram HTML has no headings, tables, task lists or math renderer.
  // We keep the meaning and convert unsupported visual markers into readable Markdown first.
  s = s.replace(/^#{1,6}\s+(.+)$/gm, (_, title) => `**${title.trim()}**`);
  s = s.replace(/^\s*[-*+]\s+\[(x|X)\]\s+/gm, '☑ ');
  s = s.replace(/^\s*[-*+]\s+\[ \]\s+/gm, '☐ ');
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, expr) => `\n\`\`\`text\n${expr.trim()}\n\`\`\`\n`);
  s = s.replace(/\$([^\n$]+)\$/g, (_, expr) => `\`${expr.trim()}\``);
  s = s.replace(/^\[\s*$/gm, '```text');
  s = s.replace(/^\]\s*$/gm, '```');
  return compactPlainNewlines(s);
}

function compactPlainNewlines(text = '') {
  return String(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
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
    case 'code': {
      const cls = getAttr(node, 'class') || '';
      const lang = cls.match(/language-([a-z0-9_+-]+)/i)?.[1];
      if (ctx.insidePre && lang) {
        return `<code class="language-${escapeHtml(lang)}">${escapeHtml(decodeBasicEntities(textContent(node)))}</code>`;
      }
      return `<code>${escapeHtml(decodeBasicEntities(textContent(node)))}</code>`;
    }
    case 'pre': {
      const children = getChildren(node) || [];
      const code = children.find((child) => isTag(child) && child.name.toLowerCase() === 'code');
      if (code) return `<pre>${renderNode(code, { ...ctx, insidePre: true })}</pre>\n\n`;
      return `<pre>${escapeHtml(decodeBasicEntities(textContent(node)).replace(/^\n+|\n+$/g, ''))}</pre>\n\n`;
    }
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
  return String(html)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToTelegramHtml(html = '') {
  const doc = parseDocument(stripControlChars(html), { decodeEntities: true });
  return compactTelegramHtml(renderChildren(doc));
}

function entityTags(entity = {}) {
  switch (entity.type) {
    case 'bold': return ['<b>', '</b>'];
    case 'italic': return ['<i>', '</i>'];
    case 'underline': return ['<u>', '</u>'];
    case 'strikethrough': return ['<s>', '</s>'];
    case 'spoiler': return ['<tg-spoiler>', '</tg-spoiler>'];
    case 'code': return ['<code>', '</code>'];
    case 'pre': {
      const lang = entity.language ? ` class="language-${escapeHtml(entity.language)}"` : '';
      return [`<pre><code${lang}>`, '</code></pre>'];
    }
    case 'text_link': {
      if (!entity.url || !/^(https?:\/\/|tg:\/\/user\?id=)/i.test(entity.url)) return null;
      return [`<a href="${escapeHtml(entity.url)}">`, '</a>'];
    }
    case 'text_mention': {
      const id = entity.user?.id;
      if (!id) return null;
      return [`<a href="tg://user?id=${escapeHtml(id)}">`, '</a>'];
    }
    default:
      return null;
  }
}

function applyTelegramEntitiesAsHtml(text = '', entities = []) {
  const cleanText = stripControlChars(text);
  const usable = (entities || [])
    .map((entity, index) => ({ ...entity, index, end: entity.offset + entity.length, tags: entityTags(entity) }))
    .filter((entity) => entity.tags && Number.isFinite(entity.offset) && Number.isFinite(entity.end) && entity.end > entity.offset)
    .sort((a, b) => a.offset - b.offset || b.end - a.end || a.index - b.index);

  if (!usable.length) return cleanText;

  const starts = new Map();
  const ends = new Map();
  for (const entity of usable) {
    if (!starts.has(entity.offset)) starts.set(entity.offset, []);
    if (!ends.has(entity.end)) ends.set(entity.end, []);
    starts.get(entity.offset).push(entity);
    ends.get(entity.end).push(entity);
  }

  for (const value of starts.values()) value.sort((a, b) => b.end - a.end || a.index - b.index);
  for (const value of ends.values()) value.sort((a, b) => b.offset - a.offset || b.index - a.index);

  const points = [...new Set([0, cleanText.length, ...starts.keys(), ...ends.keys()])]
    .filter((point) => point >= 0 && point <= cleanText.length)
    .sort((a, b) => a - b);

  let out = '';
  let active = 0;

  for (let i = 0; i < points.length; i++) {
    const point = points[i];

    for (const entity of ends.get(point) || []) {
      out += entity.tags[1];
      active = Math.max(0, active - 1);
    }

    for (const entity of starts.get(point) || []) {
      out += entity.tags[0];
      active += 1;
    }

    const next = points[i + 1];
    if (next === undefined || next <= point) continue;
    const piece = cleanText.slice(point, next);
    out += active > 0 ? escapeHtml(piece) : piece;
  }

  return out;
}

function markdownToTelegramHtml(text = '', settings = DEFAULT_SETTINGS, entities = []) {
  const canMergeEntities = settings.mergeEntities !== false && Array.isArray(entities) && entities.length > 0;
  const source = canMergeEntities ? applyTelegramEntitiesAsHtml(text, entities) : text;
  const normalized = normalizeLLMMarkdown(source, settings);
  const rendered = canMergeEntities ? mdWithHtml.render(normalized) : md.render(normalized);
  return htmlToTelegramHtml(rendered);
}

function chooseMode(text, settings) {
  if (settings.mode !== 'auto') return settings.mode;
  if (looksLikeHtml(text)) return 'html';
  if (looksLikeMarkdown(text)) return 'md';
  return 'md';
}

function convertMessage(text, settings, entities = []) {
  const mode = chooseMode(text, settings);
  if (mode === 'html') return { text: htmlToTelegramHtml(text), parse_mode: 'HTML' };
  if (mode === 'tgmd') return { text: stripControlChars(text).trim(), parse_mode: 'MarkdownV2' };
  return { text: markdownToTelegramHtml(text, settings, entities), parse_mode: 'HTML' };
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
  const normalized = { ...DEFAULT_SETTINGS, ...settings };
  memorySettings.set(key, normalized);
  await kvSet(key, normalized).catch(() => false);
}

function onOff(value) {
  return value ? 'on' : 'off';
}

function modeLabel(mode) {
  return {
    auto: 'Авто',
    html: 'HTML',
    md: 'Markdown',
    tgmd: 'TelegramMarkdown'
  }[mode] || mode;
}

function mark(label, active) {
  return active ? `✓ ${label}` : label;
}

function settingsText(settings) {
  return [
    '<b>Настройки форматирования</b>',
    '',
    `Парсить как: <b>${escapeHtml(modeLabel(settings.mode))}</b>`,
    `Автозамены несовместимого: <b>${onOff(settings.replaceBad)}</b>`,
    `Merge исходного Telegram-форматирования: <b>${onOff(settings.mergeEntities)}</b>`,
    `Убирать разделители ИИ: <b>${onOff(settings.removeAiSeparators)}</b>`,
    '',
    '<i>Пришли текст — я верну его уже отформатированным для Telegram.</i>'
  ].join('\n');
}

function settingsKeyboard(settings) {
  return {
    inline_keyboard: [
      [
        { text: mark('Авто', settings.mode === 'auto'), callback_data: 's:mode:auto' },
        { text: mark('HTML', settings.mode === 'html'), callback_data: 's:mode:html' }
      ],
      [
        { text: mark('Markdown', settings.mode === 'md'), callback_data: 's:mode:md' },
        { text: mark('TelegramMarkdown', settings.mode === 'tgmd'), callback_data: 's:mode:tgmd' }
      ],
      [
        { text: `${settings.replaceBad ? '✓' : '×'} Автозамены`, callback_data: 's:toggle:replaceBad' }
      ],
      [
        { text: `${settings.mergeEntities ? '✓' : '×'} Merge Telegram-форматирования`, callback_data: 's:toggle:mergeEntities' }
      ],
      [
        { text: `${settings.removeAiSeparators ? '✓' : '×'} Убирать разделители ИИ`, callback_data: 's:toggle:removeAiSeparators' }
      ]
    ]
  };
}

async function sendSettings(chatId) {
  const settings = await getSettings(chatId);
  await tg('sendMessage', {
    chat_id: chatId,
    text: settingsText(settings),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: settingsKeyboard(settings)
  });
}

function helpText(settings) {
  return [
    '<b>Бот форматирования</b>',
    '',
    'Пришли текст в Markdown, HTML или Telegram MarkdownV2. Я верну его как красиво отформатированное Telegram-сообщение.',
    '',
    '<b>Текущие настройки</b>',
    `Режим: <code>${escapeHtml(settings.mode)}</code>`,
    `Автозамены: <code>${onOff(settings.replaceBad)}</code>`,
    `Merge Telegram-форматирования: <code>${onOff(settings.mergeEntities)}</code>`,
    `Убирать разделители ИИ: <code>${onOff(settings.removeAiSeparators)}</code>`,
    '',
    '<b>Команды</b>',
    '<code>/settings</code> — настройки кнопками',
    '<code>/mode auto</code> — автоопределение',
    '<code>/mode html</code> — вход как HTML',
    '<code>/mode md</code> — обычный Markdown от ChatGPT/DeepSeek/Z.ai',
    '<code>/mode tgmd</code> — Telegram MarkdownV2 без конвертации',
    '<code>/replace on</code> / <code>off</code> — чинить заголовки, hr, чеклисты, LaTeX',
    '<code>/merge on</code> / <code>off</code> — сохранять исходное форматирование Telegram',
    '<code>/separators on</code> / <code>off</code> — убирать разделители ИИ',
    '',
    '<b>Лучший режим по умолчанию</b>: <code>auto</code>, <code>replace on</code>, <code>merge on</code>, <code>separators on</code>.'
  ].join('\n');
}

function parseBooleanArg(arg = '') {
  if (['on', 'yes', 'true', '1', 'да'].includes(arg)) return true;
  if (['off', 'no', 'false', '0', 'нет'].includes(arg)) return false;
  return null;
}

async function handleCommand(chatId, text) {
  const settings = await getSettings(chatId);
  const [commandRaw, argRaw] = text.trim().split(/\s+/, 2);
  const command = commandRaw.split('@')[0].toLowerCase();
  const arg = (argRaw || '').toLowerCase();

  if (command === '/settings') {
    await sendSettings(chatId);
    return true;
  }

  if (command === '/start' || command === '/help') {
    await tg('sendMessage', { chat_id: chatId, text: helpText(settings), parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  }

  if (command === '/mode') {
    const aliases = { markdown: 'md', telegrammarkdown: 'tgmd', telegram_markdown: 'tgmd', telegram: 'tgmd', html: 'html', auto: 'auto', md: 'md', tgmd: 'tgmd' };
    const mode = aliases[arg];
    if (!mode) {
      await tg('sendMessage', { chat_id: chatId, text: 'Режимы: <code>auto</code>, <code>html</code>, <code>md</code>, <code>tgmd</code>.', parse_mode: 'HTML' });
      return true;
    }
    const next = { ...settings, mode };
    await saveSettings(chatId, next);
    await tg('sendMessage', { chat_id: chatId, text: `Готово. Режим: <code>${escapeHtml(mode)}</code>.`, parse_mode: 'HTML' });
    return true;
  }

  if (command === '/replace') {
    const value = parseBooleanArg(arg);
    if (value === null) {
      await tg('sendMessage', { chat_id: chatId, text: 'Используй <code>/replace on</code> или <code>/replace off</code>.', parse_mode: 'HTML' });
      return true;
    }
    const next = { ...settings, replaceBad: value };
    await saveSettings(chatId, next);
    await tg('sendMessage', { chat_id: chatId, text: `Готово. Автозамены: <code>${onOff(value)}</code>.`, parse_mode: 'HTML' });
    return true;
  }

  if (command === '/merge') {
    const value = parseBooleanArg(arg);
    if (value === null) {
      await tg('sendMessage', { chat_id: chatId, text: 'Используй <code>/merge on</code> или <code>/merge off</code>.', parse_mode: 'HTML' });
      return true;
    }
    const next = { ...settings, mergeEntities: value };
    await saveSettings(chatId, next);
    await tg('sendMessage', { chat_id: chatId, text: `Готово. Merge Telegram-форматирования: <code>${onOff(value)}</code>.`, parse_mode: 'HTML' });
    return true;
  }

  if (command === '/separators') {
    const value = parseBooleanArg(arg);
    if (value === null) {
      await tg('sendMessage', { chat_id: chatId, text: 'Используй <code>/separators on</code> или <code>/separators off</code>.', parse_mode: 'HTML' });
      return true;
    }
    const next = { ...settings, removeAiSeparators: value };
    await saveSettings(chatId, next);
    await tg('sendMessage', { chat_id: chatId, text: `Готово. Убирать разделители ИИ: <code>${onOff(value)}</code>.`, parse_mode: 'HTML' });
    return true;
  }

  return false;
}

async function handleCallbackQuery(query) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (!chatId || !messageId || !query.data?.startsWith('s:')) return;

  const settings = await getSettings(chatId);
  const [, action, value] = query.data.split(':');
  const next = { ...settings };

  if (action === 'mode' && ['auto', 'html', 'md', 'tgmd'].includes(value)) {
    next.mode = value;
  } else if (action === 'toggle' && ['replaceBad', 'mergeEntities', 'removeAiSeparators'].includes(value)) {
    next[value] = !next[value];
  } else {
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Неизвестная настройка' });
    return;
  }

  await saveSettings(chatId, next);
  await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Сохранено' });

  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: settingsText(next),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: settingsKeyboard(next)
  }).catch((error) => {
    if (!/message is not modified/i.test(error.message)) throw error;
  });
}

async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  const msg = update.message || update.edited_message;
  if (!msg?.chat?.id) return;

  const chatId = msg.chat.id;
  const input = msg.text || msg.caption || '';
  const entities = msg.text ? (msg.entities || []) : (msg.caption_entities || []);
  if (!input.trim()) return;

  if (input.startsWith('/') && await handleCommand(chatId, input)) return;

  const settings = await getSettings(chatId);
  const converted = convertMessage(input, settings, entities);

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
