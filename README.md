# ClientFy — Единая платформа (WebApp + Telegram-бот + Backend)

Единое полнофункциональное решение на Node.js + Express + Vite/React + `grammY` + `telegram` (MTProto):
- **Веб-апп (основа продукта)**: поиск YouTube-каналов (Data API v3), фильтрация и история поисков, база контактов и авторассылка, тарифы, личный кабинет, веб-админка по `OWNER_ID`.
- **Telegram-бот (`@demov2clientfybot`)**: постоянное меню с кнопками **«🌐 Открыть веб-апп»** и **«💬 Поддержка»**, оплата через **Telegram Stars (XTR)** и **Visa / TON / GRAM**, вход в Telegram-аккаунт (`/login`), а также админ-панель (`/admin`) для владельца (`OWNER_ID`).
- **Единый Backend и БД (`data/runtime.json`)**: никаких рассинхронов между ботом и сайтом — общие пользователи, квоты, подписки, промокоды и зашифрованные AES-256-GCM MTProto-сессии.

---

## Переменные окружения (`.env`)

Все секреты передаются **только** через переменные окружения (см. `.env.example`):

| Переменная | Обязательно | Назначение |
| --- | --- | --- |
| `PORT` | Нет (3000) | Порт HTTP-сервера |
| `TELEGRAM_BOT_TOKEN` | Да | Токен бота от `@BotFather` |
| `TELEGRAM_BOT_USERNAME` | Нет | Username бота без `@` (определяется автоматически через `getMe`) |
| `OWNER_ID` | Да | Telegram ID владельца для доступа к админ-панели в боте и в веб-аппе |
| `YOUTUBE_API_KEY` | Да | Ключ YouTube Data API v3 для поиска каналов |
| `TELEGRAM_API_ID` | Да (для входа по номеру и рассылки) | API ID от `my.telegram.org` (используется только на сервере) |
| `TELEGRAM_API_HASH` | Да (для входа по номеру и рассылки) | API Hash от `my.telegram.org` (используется только на сервере) |
| `SESSION_SECRET` | Рекомендуется | Секрет подписи JWT-подобных токенов веб-сессии |
| `SESSION_ENCRYPTION_KEY` | Рекомендуется | Ключ шифрования AES-256-GCM для Telegram-сессий |
| `BOT_MODE` | Нет (`polling`) | `polling` или `webhook` |
| `WEBAPP_URL` / `APP_URL` | Да (HTTPS) | Публичный HTTPS-адрес веб-аппа для кнопки Mini App и webhook |
| `SUPPORT_URL` | Нет | Ссылка на поддержку (по умолчанию `https://t.me/ClienFy_Support`) |

---

## Быстрый запуск с GitHub

```bash
git clone <your-repo-url>
cd clientfy
cp .env.example .env
# Заполните переменные окружения в .env

npm install
npm run build
NODE_ENV=production npm start
```

В режиме разработки:
```bash
npm run dev
```

Проверка состояния сервера:
```bash
curl http://localhost:3000/api/health
```

Подробная документация эндпоинтов: см. `docs/API.md`.
