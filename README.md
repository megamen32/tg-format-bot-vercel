# Telegram Formatting Bot for Vercel

Бот принимает текст в Markdown / HTML / Telegram MarkdownV2 и отправляет обратно отрендеренное Telegram-сообщение.

По умолчанию:

- режим: `auto`
- автозамены невозможных/неподдерживаемых конструкций: `on`

## Что умеет

- Markdown от ChatGPT / DeepSeek / Z.ai → Telegram HTML
- HTML → безопасный Telegram HTML
- Telegram MarkdownV2 → отправка как есть
- заголовки `#`, `##`, `###` → жирные заголовки
- списки → аккуратные списки
- таблицы → моноширинный блок
- блоки кода → `<pre>`
- inline code → `<code>`
- цитаты → `<blockquote>`
- чеклисты → `☑` / `☐`
- LaTeX `$...$` / `$$...$$` → моноширинный текст, потому что Telegram не рендерит LaTeX
- удаление неподдерживаемого HTML

## Команды бота

```text
/start
/help
/settings
/mode auto
/mode html
/mode md
/mode tgmd
/replace on
/replace off
```

Режимы:

- `auto` — сам определяет HTML или Markdown
- `html` — вход считается HTML
- `md` — вход считается обычным Markdown
- `tgmd` — вход считается Telegram MarkdownV2

## Установка

```bash
npm install
```

## Деплой на Vercel

1. Создай бота через [@BotFather](https://t.me/BotFather).
2. Залей проект в GitHub.
3. Импортируй репозиторий в Vercel.
4. В Vercel добавь переменные окружения:

```text
BOT_TOKEN=123456:telegram_token_here
TELEGRAM_SECRET_TOKEN=любая_длинная_строка_по_желанию
```

`TELEGRAM_SECRET_TOKEN` необязателен, но лучше включить.

## Webhook

После деплоя выполни:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://YOUR_PROJECT.vercel.app/api/bot",
    "secret_token": "YOUR_TELEGRAM_SECRET_TOKEN"
  }'
```

Если не используешь `TELEGRAM_SECRET_TOKEN`, убери поле `secret_token`:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://YOUR_PROJECT.vercel.app/api/bot"}'
```

Проверить webhook:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Удалить webhook:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/deleteWebhook"
```

## Сохранение настроек

Без базы настройки хранятся в памяти serverless-функции и могут сбрасываться.

Для нормального сохранения подключи Upstash Redis или Vercel KV и добавь переменные:

```text
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
```

Также поддерживаются имена:

```text
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

## Важное ограничение Telegram

Telegram поддерживает не весь Markdown/HTML. Например, он не умеет настоящие Markdown-заголовки, таблицы, MathJax/KaTeX и произвольные `<div style="...">`. Поэтому бот конвертирует их в ближайший нормальный вид для Telegram.
