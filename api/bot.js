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
  removeAiSeparators: true,
  autoEditChannelPosts: true
};

const memorySettings = new Map();
const memoryJson = new Map();
const memoryLocks = new Map();
let commandsWereSet = false;

const PERMISSION_CACHE_TTL_MS = 60 * 60 * 1000;
const UNDO_TTL_MS = 24 * 60 * 60 * 1000;

function userScope(userId) { return `user:${userId}`; }
function chatScope(chatId) { return `chat:${chatId}`; }

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

async function jsonGet(key) {
  const stored = await kvGet(key);
  if (stored !== null && stored !== undefined) return stored;
  return memoryJson.get(key) || null;
}

async function jsonSet(key, value) {
  memoryJson.set(key, value);
  await kvSet(key, value).catch(() => false);
}


async function getPermissionCache(channelId, userId) {
  return await jsonGet(`perm:${channelId}:${userId}`);
}

async function setPermissionCache(channelId, userId, allowed) {
  const value = { allowed: Boolean(allowed), checkedAt: Date.now() };
  await jsonSet(`perm:${channelId}:${userId}`, value);
  return value;
}

async function checkUserCanManageChannelCached(channelId, userId, { force = false } = {}) {
  if (!channelId || !userId) return { allowed: false, cached: false };
  const cached = await getPermissionCache(channelId, userId);
  if (!force && cached && Date.now() - Number(cached.checkedAt || 0) < PERMISSION_CACHE_TTL_MS) {
    return { allowed: Boolean(cached.allowed), cached: true };
  }

  const lockKey = `perm:${channelId}:${userId}`;
  if (memoryLocks.has(lockKey)) return await memoryLocks.get(lockKey);

  const promise = (async () => {
    const allowed = await checkUserCanManageChannel(channelId, userId);
    const fresh = await setPermissionCache(channelId, userId, allowed);
    if (allowed) await rememberChannelManager(channelId, userId);
    return { allowed, cached: false, checkedAt: fresh.checkedAt };
  })().finally(() => memoryLocks.delete(lockKey));

  memoryLocks.set(lockKey, promise);
  return await promise;
}

async function rememberChannelManager(channelId, userId) {
  if (!channelId || !userId) return;
  const key = `channelManagers:${channelId}`;
  const list = await jsonGet(key) || [];
  const next = [...new Set([...list.map(String), String(userId)])];
  await jsonSet(key, next);
}

async function getChannelManagers(channelId) {
  const list = await jsonGet(`channelManagers:${channelId}`) || [];
  const channel = await jsonGet(`channel:${channelId}`);
  if (channel?.addedBy) list.push(String(channel.addedBy));
  return [...new Set(list.map(String).filter(Boolean))];
}

function makeToken() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function storeUndo(data) {
  const token = makeToken();
  await jsonSet(`undo:${token}`, { ...data, createdAt: Date.now() });
  return token;
}

async function notifyChannelEdit(channelId, text, replyMarkup) {
  const managers = await getChannelManagers(channelId);
  for (const managerId of managers) {
    await tg('sendMessage', {
      chat_id: managerId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: replyMarkup
    }).catch(() => null);
  }
}

async function setupBotCommands() {
  const commands = [
    { command: 'start', description: 'Что умеет бот' },
    { command: 'settings', description: 'Личные настройки форматирования' },
    { command: 'channels', description: 'Каналы и группы с автоисправлением' },
    { command: 'mode', description: 'Режим парсинга: auto/html/md/tgmd' },
    { command: 'replace', description: 'Автозамены несовместимого on/off' },
    { command: 'merge', description: 'Merge исходного форматирования on/off' },
    { command: 'separators', description: 'Убирать ИИ-разделители on/off' },
    { command: 'channel_edit', description: 'Автоисправление постов каналов on/off' },
    { command: 'help', description: 'Помощь' }
  ];
  await tg('setMyCommands', { commands, scope: { type: 'default' } });
}

async function ensureBotCommands() {
  if (commandsWereSet) return;
  commandsWereSet = true;
  await setupBotCommands().catch((error) => {
    commandsWereSet = false;
    console.error('setMyCommands failed', error);
  });
}

async function rememberChannelForUser(userId, channel) {
  if (!userId || !channel?.id) return;
  const key = `channels:${userId}`;
  const list = await jsonGet(key) || [];
  const map = new Map(list.map((item) => [String(item.id), item]));
  map.set(String(channel.id), { ...map.get(String(channel.id)), ...channel, updatedAt: Date.now() });
  await jsonSet(key, [...map.values()]);
  await jsonSet(`channel:${channel.id}`, { ...channel, updatedAt: Date.now() });
  await rememberChannelManager(channel.id, userId);
}

async function getUserChannels(userId) {
  return await jsonGet(`channels:${userId}`) || [];
}

async function checkUserCanManageChannel(channelId, userId) {
  try {
    const member = await tg('getChatMember', { chat_id: channelId, user_id: userId });
    return ['creator', 'administrator'].includes(member.status);
  } catch {
    return false;
  }
}

async function getSettings(scope) {
  const key = `settings:${scope}`;
  const stored = await kvGet(key);
  if (stored) return { ...DEFAULT_SETTINGS, ...stored };

  // Compatibility with older v1-v3 keys: settings:<numeric chat id>.
  const legacyId = String(scope).replace(/^(user|chat):/, '');
  const legacy = await kvGet(`settings:${legacyId}`);
  if (legacy) return { ...DEFAULT_SETTINGS, ...legacy };

  return { ...DEFAULT_SETTINGS, ...(memorySettings.get(key) || {}) };
}

async function saveSettings(scope, settings) {
  const key = `settings:${scope}`;
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

function settingsText(settings, title = 'Настройки форматирования') {
  return [
    `<b>${escapeHtml(title)}</b>`,
    '',
    `Парсить как: <b>${escapeHtml(modeLabel(settings.mode))}</b>`,
    `Автозамены несовместимого: <b>${onOff(settings.replaceBad)}</b>`,
    `Merge исходного Telegram-форматирования: <b>${onOff(settings.mergeEntities)}</b>`,
    `Убирать разделители ИИ: <b>${onOff(settings.removeAiSeparators)}</b>`,
    `Автоисправлять посты каналов: <b>${onOff(settings.autoEditChannelPosts)}</b>`,
    '',
    '<i>Пришли текст — я верну его уже отформатированным для Telegram.</i>'
  ].join('\n');
}

function settingsKeyboard(settings, scope = 'u') {
  const prefix = scope.startsWith('chat:') ? `s|c|${scope.slice(5)}` : 's|u';
  return {
    inline_keyboard: [
      [
        { text: mark('Авто', settings.mode === 'auto'), callback_data: `${prefix}|mode|auto` },
        { text: mark('HTML', settings.mode === 'html'), callback_data: `${prefix}|mode|html` }
      ],
      [
        { text: mark('Markdown', settings.mode === 'md'), callback_data: `${prefix}|mode|md` },
        { text: mark('TelegramMarkdown', settings.mode === 'tgmd'), callback_data: `${prefix}|mode|tgmd` }
      ],
      [
        { text: `${settings.replaceBad ? '✓' : '×'} Автозамены`, callback_data: `${prefix}|toggle|replaceBad` }
      ],
      [
        { text: `${settings.mergeEntities ? '✓' : '×'} Merge Telegram-форматирования`, callback_data: `${prefix}|toggle|mergeEntities` }
      ],
      [
        { text: `${settings.removeAiSeparators ? '✓' : '×'} Убирать разделители ИИ`, callback_data: `${prefix}|toggle|removeAiSeparators` }
      ],
      [
        { text: `${settings.autoEditChannelPosts ? '✓' : '×'} Автоисправлять посты каналов`, callback_data: `${prefix}|toggle|autoEditChannelPosts` }
      ],
      ...(scope.startsWith('chat:') ? [[{ text: '← К списку каналов', callback_data: 'ch|list' }]] : [])
    ]
  };
}

async function sendSettings(chatId) {
  const scope = userScope(chatId);
  const settings = await getSettings(scope);
  await tg('sendMessage', {
    chat_id: chatId,
    text: settingsText(settings, 'Личные настройки'),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: settingsKeyboard(settings, scope)
  });
}

function channelDisplayName(channel) {
  return channel.username ? `@${channel.username}` : (channel.title || String(channel.id));
}

function getPostUrl(chat, messageId) {
  if (!chat?.id || !messageId) return null;
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;

  const rawId = String(chat.id);
  if (rawId.startsWith('-100')) {
    return `https://t.me/c/${rawId.slice(4)}/${messageId}`;
  }

  return null;
}

function postLinkLine(postUrl) {
  return postUrl
    ? `Пост: ${escapeHtml(postUrl)}`
    : 'Ссылка на пост недоступна.';
}

async function sendChannels(chatId, editMessageId = null) {
  const channels = await getUserChannels(chatId);
  const rows = [];
  for (const channel of channels) {
    rows.push([{ text: channelDisplayName(channel), callback_data: `ch|open|${channel.id}` }]);
  }
  const text = channels.length
    ? '<b>Каналы</b>\n\nВыбери канал для настройки. Проверка прав кэшируется на час, кнопки отвечают сразу.'
    : '<b>Каналы не найдены</b>\n\nДобавь бота админом в канал. Бот запомнит канал через <code>my_chat_member</code>. После этого вернись сюда и нажми /channels.';
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: rows.length ? rows : [[{ text: 'Обновить', callback_data: 'ch|list' }]] }
  };
  if (editMessageId) {
    await tg('editMessageText', { ...payload, message_id: editMessageId }).catch(async (error) => {
      if (!/message is not modified/i.test(error.message)) throw error;
    });
  } else {
    await tg('sendMessage', payload);
  }
}

function helpText(settings) {
  return [
    '<b>Бот форматирования</b>',
    '',
    'Пришли текст в Markdown, HTML или Telegram MarkdownV2. Я верну его как красиво отформатированное Telegram-сообщение.',
    '',
    'Можешь добавить меня админом в канал или группу с правом редактировать сообщения — я буду автоматически исправлять видимую Markdown/HTML-разметку в новых постах.',
    '',
    '<b>Текущие настройки</b>',
    `Режим: <code>${escapeHtml(settings.mode)}</code>`,
    `Автозамены: <code>${onOff(settings.replaceBad)}</code>`,
    `Merge Telegram-форматирования: <code>${onOff(settings.mergeEntities)}</code>`,
    `Убирать разделители ИИ: <code>${onOff(settings.removeAiSeparators)}</code>`,
    `Автоисправлять посты каналов: <code>${onOff(settings.autoEditChannelPosts)}</code>`,
    '',
    '<b>Команды</b>',
    '<code>/settings</code> — личные настройки кнопками',
    '<code>/channels</code> — каналы, где бот был добавлен админом',
    '<code>/mode auto</code> — автоопределение',
    '<code>/mode html</code> — вход как HTML',
    '<code>/mode md</code> — обычный Markdown от ChatGPT/DeepSeek/Z.ai',
    '<code>/mode tgmd</code> — Telegram MarkdownV2 без конвертации',
    '<code>/replace on</code> / <code>off</code> — чинить заголовки, hr, чеклисты, LaTeX',
    '<code>/merge on</code> / <code>off</code> — сохранять исходное форматирование Telegram',
    '<code>/separators on</code> / <code>off</code> — убирать разделители ИИ',
    '<code>/channel_edit on</code> / <code>off</code> — автоматически редактировать посты каналов',
    '',
    '<b>Лучший режим по умолчанию</b>: <code>auto</code>, <code>replace on</code>, <code>merge on</code>, <code>separators on</code>, <code>channel_edit on</code>.'
  ].join('\n');
}

function parseBooleanArg(arg = '') {
  if (['on', 'yes', 'true', '1', 'да'].includes(arg)) return true;
  if (['off', 'no', 'false', '0', 'нет'].includes(arg)) return false;
  return null;
}

async function handleCommand(chatId, text) {
  const scope = userScope(chatId);
  const settings = await getSettings(scope);
  const [commandRaw, argRaw] = text.trim().split(/\s+/, 2);
  const command = commandRaw.split('@')[0].toLowerCase();
  const arg = (argRaw || '').toLowerCase();

  if (command === '/settings') {
    await sendSettings(chatId);
    return true;
  }

  if (command === '/channels') {
    await sendChannels(chatId);
    return true;
  }

  if (command === '/start' || command === '/help') {
    await tg('sendMessage', { chat_id: chatId, text: helpText(settings), parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  }

  if (command === '/set_commands') {
    await setupBotCommands();
    await tg('sendMessage', { chat_id: chatId, text: 'Команды бота обновлены в меню Telegram.' });
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
    await saveSettings(scope, next);
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
    await saveSettings(scope, next);
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
    await saveSettings(scope, next);
    await tg('sendMessage', { chat_id: chatId, text: `Готово. Merge Telegram-форматирования: <code>${onOff(value)}</code>.`, parse_mode: 'HTML' });
    return true;
  }

  if (command === '/channel_edit') {
    const value = parseBooleanArg(arg);
    if (value === null) {
      await tg('sendMessage', { chat_id: chatId, text: 'Используй <code>/channel_edit on</code> или <code>/channel_edit off</code>.', parse_mode: 'HTML' });
      return true;
    }
    const next = { ...settings, autoEditChannelPosts: value };
    await saveSettings(scope, next);
    await tg('sendMessage', { chat_id: chatId, text: `Готово. Автоисправление постов каналов: <code>${onOff(value)}</code>.`, parse_mode: 'HTML' });
    return true;
  }

  if (command === '/separators') {
    const value = parseBooleanArg(arg);
    if (value === null) {
      await tg('sendMessage', { chat_id: chatId, text: 'Используй <code>/separators on</code> или <code>/separators off</code>.', parse_mode: 'HTML' });
      return true;
    }
    const next = { ...settings, removeAiSeparators: value };
    await saveSettings(scope, next);
    await tg('sendMessage', { chat_id: chatId, text: `Готово. Убирать разделители ИИ: <code>${onOff(value)}</code>.`, parse_mode: 'HTML' });
    return true;
  }

  return false;
}

async function handleCallbackQuery(query) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const userId = query.from?.id;
  if (!chatId || !messageId || !query.data) return;

  if (query.data === 'ch|list') {
    await tg('answerCallbackQuery', { callback_query_id: query.id });
    await sendChannels(chatId, messageId);
    return;
  }

  if (query.data.startsWith('undo|')) {
    await handleUndo(query, query.data.split('|')[1]);
    return;
  }

  if (query.data.startsWith('ch|open|')) {
    const channelId = query.data.split('|')[2];
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Открываю настройки…' });
    const permission = await checkUserCanManageChannelCached(channelId, userId);
    if (!permission.allowed) {
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: 'Нет прав администратора для этого канала или бот не может проверить права.',
        reply_markup: { inline_keyboard: [[{ text: '← К списку каналов', callback_data: 'ch|list' }]] }
      }).catch(() => null);
      return;
    }
    const channel = await jsonGet(`channel:${channelId}`) || { id: channelId, title: channelId };
    const scope = chatScope(channelId);
    const settings = await getSettings(scope);
    await tg('answerCallbackQuery', { callback_query_id: query.id });
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: settingsText(settings, `Настройки канала ${channelDisplayName(channel)}`),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: settingsKeyboard(settings, scope)
    }).catch((error) => {
      if (!/message is not modified/i.test(error.message)) throw error;
    });
    return;
  }

  if (!query.data.startsWith('s|')) return;

  const parts = query.data.split('|');
  let scope;
  let action;
  let value;

  if (parts[1] === 'u') {
    scope = userScope(userId || chatId);
    action = parts[2];
    value = parts[3];
  } else if (parts[1] === 'c') {
    const channelId = parts[2];
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Сохраняю…' });
    const permission = await checkUserCanManageChannelCached(channelId, userId);
    if (!permission.allowed) {
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: 'Нет прав администратора для этого канала или бот не может проверить права.',
        reply_markup: { inline_keyboard: [[{ text: '← К списку каналов', callback_data: 'ch|list' }]] }
      }).catch(() => null);
      return;
    }
    scope = chatScope(channelId);
    action = parts[3];
    value = parts[4];
  } else {
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Неизвестная настройка' });
    return;
  }

  const settings = await getSettings(scope);
  const next = { ...settings };

  if (action === 'mode' && ['auto', 'html', 'md', 'tgmd'].includes(value)) {
    next.mode = value;
  } else if (action === 'toggle' && ['replaceBad', 'mergeEntities', 'removeAiSeparators', 'autoEditChannelPosts'].includes(value)) {
    next[value] = !next[value];
  } else {
    await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Неизвестная настройка' });
    return;
  }

  await saveSettings(scope, next);
  await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Сохранено' }).catch(() => null);

  const title = scope.startsWith('chat:')
    ? `Настройки канала ${channelDisplayName(await jsonGet(`channel:${scope.slice(5)}`) || { id: scope.slice(5) })}`
    : 'Личные настройки';

  await tg('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: settingsText(next, title),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: settingsKeyboard(next, scope)
  }).catch((error) => {
    if (!/message is not modified/i.test(error.message)) throw error;
  });
}

async function handleMyChatMember(update) {
  const chat = update.chat;
  const actor = update.from;
  const next = update.new_chat_member;
  if (!chat?.id || !actor?.id || !next?.status) return;
  if (!['channel', 'supergroup', 'group'].includes(chat.type)) return;

  const isActive = ['member', 'administrator'].includes(next.status);
  const isAdmin = next.status === 'administrator';
  const channel = {
    id: chat.id,
    type: chat.type,
    title: chat.title || chat.username || String(chat.id),
    username: chat.username || '',
    botStatus: next.status,
    canEditMessages: Boolean(next.can_edit_messages),
    active: isActive,
    addedBy: actor.id
  };

  await rememberChannelForUser(actor.id, channel);

  if (isAdmin) {
    const scope = chatScope(chat.id);
    const settings = await getSettings(scope);
    await saveSettings(scope, settings);
    await tg('sendMessage', {
      chat_id: actor.id,
      text: `<b>Бот добавлен админом в ${escapeHtml(channelDisplayName(channel))}</b>\n\nНастройки канала можно менять здесь, в личке.`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: 'Открыть настройки канала', callback_data: `ch|open|${chat.id}` }]]
      }
    }).catch(() => null);
  }
}


function hasUsefulTelegramEntities(entities = []) {
  const useful = new Set(['bold', 'italic', 'underline', 'strikethrough', 'spoiler', 'code', 'pre', 'text_link', 'text_mention', 'blockquote', 'expandable_blockquote']);
  return (entities || []).some((entity) => useful.has(entity.type));
}

function hasExplicitMarkup(text = '', entities = []) {
  const s = stripControlChars(text || '');
  if (hasUsefulTelegramEntities(entities)) return true;
  if (looksLikeHtml(s) || looksLikeMarkdown(s)) return true;

  // Extra strict checks for common LLM/Telegram-visible markup that MarkdownIt may not catch.
  return /(^|\s)(\*|_){1,3}\S[\s\S]*?\S\2{1,3}(?=\s|$)|~~\S[\s\S]*?\S~~|<\/?(?:b|i|u|s|code|pre|blockquote|strong|em)\b/i.test(s);
}

async function handleChannelPost(msg) {
  const chatId = msg.chat?.id;
  if (!chatId) return;

  const input = msg.text || msg.caption || '';
  const entities = msg.text ? (msg.entities || []) : (msg.caption_entities || []);
  if (!input.trim()) return;

  const settings = await getSettings(chatScope(chatId));
  if (settings.autoEditChannelPosts === false) return;
  if (!hasExplicitMarkup(input, entities)) return;

  const converted = convertMessage(input, settings, entities);
  const payload = {
    chat_id: chatId,
    message_id: msg.message_id,
    parse_mode: converted.parse_mode,
    disable_web_page_preview: true
  };

  const postUrl = getPostUrl(msg.chat, msg.message_id);
  const channelTitle = msg.chat?.title || msg.chat?.username || String(chatId);
  const undoToken = await storeUndo({
    chatId,
    messageId: msg.message_id,
    kind: msg.text ? 'text' : 'caption',
    original: input,
    entities,
    channelTitle,
    postUrl
  });

  try {
    if (msg.text) {
      await tg('editMessageText', { ...payload, text: converted.text });
    } else if (msg.caption) {
      await tg('editMessageCaption', { ...payload, caption: converted.text });
    }

    const keyboard = [];
    if (postUrl) keyboard.push([{ text: 'Открыть пост', url: postUrl }]);
    keyboard.push([{ text: 'Откатить форматирование', callback_data: `undo|${undoToken}` }]);

    await notifyChannelEdit(
      chatId,
      [
        '<b>Пост исправлен</b>',
        '',
        `Канал: <b>${escapeHtml(channelTitle)}</b>`,
        postLinkLine(postUrl),
        '',
        'Можно откатить исходное форматирование в течение 24 часов.'
      ].join('\n'),
      { inline_keyboard: keyboard }
    );
  } catch (error) {
    if (!/message is not modified/i.test(error.message)) throw error;
  }
}

async function handleUndo(query, token) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const userId = query.from?.id;
  await tg('answerCallbackQuery', { callback_query_id: query.id, text: 'Откатываю…' }).catch(() => null);

  const data = await jsonGet(`undo:${token}`);
  if (!data || Date.now() - Number(data.createdAt || 0) > UNDO_TTL_MS) {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: 'Откат недоступен: запись устарела или не найдена.'
    }).catch(() => null);
    return;
  }

  const permission = await checkUserCanManageChannelCached(data.chatId, userId);
  if (!permission.allowed) {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: 'Откат недоступен: нет прав администратора для этого канала.'
    }).catch(() => null);
    return;
  }

  try {
    if (data.kind === 'caption') {
      await tg('editMessageCaption', {
        chat_id: data.chatId,
        message_id: data.messageId,
        caption: data.original,
        caption_entities: data.entities || []
      });
    } else {
      await tg('editMessageText', {
        chat_id: data.chatId,
        message_id: data.messageId,
        text: data.original,
        entities: data.entities || [],
        disable_web_page_preview: true
      });
    }
    const keyboard = data.postUrl
      ? { inline_keyboard: [[{ text: 'Открыть пост', url: data.postUrl }]] }
      : undefined;

    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: [
        '<b>Откат выполнен</b>',
        '',
        `Канал: <b>${escapeHtml(data.channelTitle || String(data.chatId))}</b>`,
        postLinkLine(data.postUrl)
      ].join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard
    }).catch(() => null);
  } catch (error) {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `Не удалось откатить: ${escapeHtml(error.message || 'ошибка Telegram')}`,
      parse_mode: 'HTML'
    }).catch(() => null);
  }
}

async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  if (update.my_chat_member) {
    await handleMyChatMember(update.my_chat_member);
    return;
  }

  const channelPost = update.channel_post || update.edited_channel_post;
  if (channelPost) {
    await handleChannelPost(channelPost);
    return;
  }

  const msg = update.message || update.edited_message;
  if (!msg?.chat?.id) return;

  const chatId = msg.chat.id;
  const input = msg.text || msg.caption || '';
  const entities = msg.text ? (msg.entities || []) : (msg.caption_entities || []);
  if (!input.trim()) return;

  if (input.startsWith('/') && await handleCommand(chatId, input)) return;

  const settings = await getSettings(userScope(chatId));
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
    await ensureBotCommands();
    await handleUpdate(req.body);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(200).json({ ok: false });
  }
}
