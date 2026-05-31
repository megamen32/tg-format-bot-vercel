# TG Format Bot for Vercel

Telegram-бот для красивого рендера Markdown/HTML/Telegram MarkdownV2 в Telegram HTML.

Версия: `v7-deeplink-web-app`.

## Что умеет

- принимает Markdown от ChatGPT, DeepSeek, Z.ai и похожих сервисов;
- конвертирует заголовки, списки, цитаты, код, таблицы, чеклисты и LaTeX в Telegram-совместимый вид;
- умеет режимы `auto`, `html`, `md`, `tgmd`;
- умеет merge исходного Telegram-форматирования из `message.entities` / `caption_entities`;
- убирает типичные ИИ-разделители между абзацами: `—`, `---`, `___`, `***`;
- `/settings` открывает личные настройки inline-кнопками;
- если бот добавлен админом в канал или группу, он получает `my_chat_member`, запоминает чат и даёт управлять настройками в личке через `/channels`;
- настройки каналов и групп хранятся отдельно от личных настроек;
- проверка прав админа кэшируется на 1 час, а повторные нажатия не запускают пачку одинаковых `getChatMember`;
- бот отвечает на inline-кнопку сразу, потом делает проверку и обновляет сообщение;
- может автоматически редактировать посты канала, если в них найдено явное форматирование;
- после каждого автоисправленного поста присылает администраторам в личку ссылку на пост, кнопку `Открыть пост` и кнопку `Откатить форматирование`;
- автоматически регистрирует меню команд Telegram через `setMyCommands`;
- умеет открываться по Telegram deep link с текстом: `https://t.me/<bot_username>?start=<payload>`;
- содержит статический веб-конвертер на `/`, который создаёт ссылку открытия бота с нужным текстом;
- endpoint `/api/link` создаёт deep link: короткий текст кладётся прямо в `start`, длинный текст сохраняется в KV и передаётся коротким токеном.

## Структура

```text
api/
  bot.js      # webhook Telegram
  link.js     # создание deep link с текстом
public/
  index.html  # простой фронт-конвертер
package.json
vercel.json
VERSION.txt
README.md
```

## Переменные окружения Vercel

Обязательные:

```env
BOT_TOKEN=123456:ABC...
TELEGRAM_SECRET_TOKEN=long-random-secret
```

Желательные:

```env
BOT_USERNAME=paste_with_format_bot
PUBLIC_APP_URL=https://YOUR_PROJECT.vercel.app
```

`BOT_USERNAME` нужен, чтобы `/api/link` мог сразу собрать ссылку вида `https://t.me/paste_with_format_bot?start=...`. Если не указать, сервер попробует получить username через `getMe`.

`PUBLIC_APP_URL` нужен для кнопки `Открыть веб-конвертер` в `/start`, `/help`, `/app` и для Telegram menu button. Если не указать, бот попробует использовать домен текущего Vercel deployment.

Очень желательно для постоянных настроек, списка каналов, кэша прав, отката и длинных deep links:

```env
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
```

Также поддерживаются старые имена Upstash:

```env
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

Без KV:

- короткие deep links всё равно работают, если payload помещается в 64 символа;
- длинные deep links через `/api/link` работать не будут;
- настройки, список каналов и откаты могут сбрасываться между serverless-инстансами.

## Webhook

После деплоя поставь webhook с нужными `allowed_updates`:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://YOUR_PROJECT.vercel.app/api/bot","secret_token":"<TELEGRAM_SECRET_TOKEN>","allowed_updates":["message","edited_message","callback_query","channel_post","edited_channel_post","my_chat_member"]}'
```

Проверка:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

## Команды

```text
/start
/help
/settings
/channels
/app
/link <text>
/set_commands
/mode auto
/mode html
/mode md
/mode tgmd
/replace on|off
/merge on|off
/separators on|off
/channel_edit on|off
```

`/settings` меняет личные настройки пользователя.

`/channels` показывает каналы и группы, где бот был добавлен/повышен админом. Настройки выбранного чата меняются в личке и сохраняются по ключу `settings:chat:<channel_id>`.

`/app` отправляет ссылку на веб-конвертер.

`/link <text>` создаёт ссылку, которая откроет бота с этим текстом. Для короткого текста KV не нужен. Для длинного текста нужен KV/Upstash.

`/set_commands` вручную обновляет меню команд Telegram. Обычно это не нужно: бот сам вызывает `setMyCommands` при обработке webhook-запроса после холодного старта.

## Deep links с текстом

Telegram поддерживает deep links вида:

```text
https://t.me/<bot_username>?start=<payload>
```

Когда пользователь открывает ссылку, бот получает сообщение:

```text
/start <payload>
```

У `payload` есть ограничение: только `A-Z`, `a-z`, `0-9`, `_`, `-`, максимум 64 символа. Поэтому нельзя надёжно сделать такую ссылку:

```text
https://t.me/paste_with_format_bot/start?text_to_format=<b>bold</b>
```

Правильная схема в этой версии:

### Короткий текст

`/api/link` кодирует текст в `base64url` и кладёт прямо в start payload. Префикс также может хранить режим парсинга:

```text
https://t.me/paste_with_format_bot?start=h64_PGI-Ym9sZDwvYj4
```

Префиксы коротких payload:

```text
b64_  # текст, режим берётся из личных настроек пользователя
a64_  # режим auto
h64_  # режим html
m64_  # режим md
t64_  # режим tgmd
```

### Длинный текст

`/api/link` сохраняет текст в KV и создаёт короткий токен:

```text
https://t.me/paste_with_format_bot?start=fmt_mabc123xyz
```

Бот получает `/start fmt_mabc123xyz`, достаёт текст из KV, форматирует и отправляет результат.

## API: создание ссылки

GET:

```bash
curl "https://YOUR_PROJECT.vercel.app/api/link?text=%3Cb%3Ebold%3C%2Fb%3E"
```

POST:

```bash
curl -X POST "https://YOUR_PROJECT.vercel.app/api/link" \
  -H "Content-Type: application/json" \
  -d '{"text":"<b>bold</b>","mode":"html"}'
```

Ответ:

```json
{
  "ok": true,
  "url": "https://t.me/paste_with_format_bot?start=h64_PGI-Ym9sZDwvYj4",
  "payload": "h64_PGI-Ym9sZDwvYj4",
  "storage": "inline",
  "requiresKv": false
}
```

Можно сразу редиректить в Telegram:

```text
https://YOUR_PROJECT.vercel.app/api/link?redirect=1&text=%3Cb%3Ebold%3C%2Fb%3E
```

## Веб-конвертер

Статический frontend лежит в `public/index.html` и открывается на корне проекта:

```text
https://YOUR_PROJECT.vercel.app/
```

Он умеет:

- принять текст из textarea;
- принять текст из query-параметра `?text=...`;
- выбрать режим `auto/html/md/tgmd`;
- вызвать `/api/link`;
- открыть Telegram-бота с созданной ссылкой;
- скопировать ссылку.

Пример ссылки на веб-конвертер с предзаполненным текстом:

```text
https://YOUR_PROJECT.vercel.app/?text=%3Cb%3Ebold%3C%2Fb%3E&mode=html
```

## Каналы и группы

1. Пользователь открывает бота в личке хотя бы один раз через `/start`, чтобы бот мог писать ему.
2. Пользователь добавляет бота админом в канал или группу.
3. Webhook получает `my_chat_member`.
4. Бот запоминает чат за пользователем, который выполнил действие.
5. Пользователь пишет боту `/channels` в личке.
6. Бот показывает список чатов и настройки inline-кнопками.
7. При открытии/изменении настроек бот отвечает на кнопку сразу, затем проверяет права через `getChatMember`.
8. Результат проверки кэшируется на 1 час по паре `channelId:userId`.

Для автоисправления постов в канале у бота должно быть право редактировать сообщения.

## Откат автоисправления

Когда бот изменил пост канала, он сохраняет исходный текст, исходные `entities`, ссылку на пост и отправляет известным администраторам в личку уведомление:

```text
Пост исправлен

Канал: Название канала
Пост: https://t.me/...

Можно откатить исходное форматирование в течение 24 часов.
```

Под уведомлением две кнопки:

```text
Открыть пост
Откатить форматирование
```

Для публичных каналов ссылка будет вида `https://t.me/channel/123`. Для приватных каналов и супергрупп — `https://t.me/c/1234567890/123`; она откроется только у тех, у кого есть доступ к чату.

После успешного отката бот тоже оставляет кнопку `Открыть пост`, чтобы сразу проверить результат.

Откат хранится 24 часа. Чтобы кнопка работала после перезапусков serverless-функций, подключи KV/Upstash.

## Важные ограничения Telegram

- Бот не может первым написать пользователю, если пользователь раньше не нажимал `/start` в личке.
- В `channel_post` обычно нет автора-админа, поэтому к постам применяются настройки канала, а не личные настройки конкретного админа.
- Если webhook был установлен без `my_chat_member`, бот не узнает о добавлении в канал. Переустанови webhook командой выше.
- Для отката бот должен всё ещё иметь право редактировать соответствующий пост.
- Deep link `start` не подходит для прямой передачи длинного текста. Для этого нужен KV-токен через `/api/link`.
