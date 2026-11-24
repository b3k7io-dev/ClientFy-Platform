# ClientFy REST API

Базовый префикс: `/api`

## Системные эндпоинты
- `GET /api/health` — проверка состояния БД, YouTube API, MTProto и статуса Telegram-бота.
- `GET /api/download/source` — скачивание чистого исходного кода проекта (`.tar.gz`, без секретов `.env`, `data/`, `autosend/`, `node_modules/`).

## Авторизация (`/api/auth/*`, rate-limit 30 req/min на IP)
- `GET /api/auth/status` — проверка конфигурации сервера и текущей сессии (`Bearer`).
- `POST /api/auth/telegram-webapp` — вход через Telegram Mini App с проверкой HMAC `initData` по `TELEGRAM_BOT_TOKEN`.
- `POST /api/auth/telegram-phone/send-code` — отправка кода подтверждения на номер Telegram (`{ phone }`).
- `POST /api/auth/telegram-phone/verify-code` — проверка кода (`{ loginId, code }`), возвращает либо `step: "password"` (2FA), либо `{ token, user }`.
- `POST /api/auth/telegram-phone/verify-password` — подтверждение 2FA-пароля (`{ loginId, password }`).
- `POST /api/auth/login` / `POST /api/auth/register` — резервный вход по логину/паролю.

## Поиск каналов и история
- `POST /api/youtube/search` — поиск каналов по фильтрам (`query`, `days`, `count`, `minSubs`, `maxSubs`, `lang`, `requireChannelLink`, `requireRecentLink`). Списание квоты атомарно на сервере.
- `GET /api/history` — список поисков текущего пользователя.
- `GET /api/history/:id` — полная сохранённая выборка.

## Авторассылка и база контактов (`/api/outreach/*`)
- `GET /api/outreach` — контакты, шаблоны, состояние кампании, журнал отправок и статус подключённого Telegram-аккаунта.
- `POST /api/outreach/telegram/send-code` | `verify-code` | `verify-password` | `disconnect` — подключение личного Telegram-аккаунта (общая зашифрованная сессия с ботом).
- `POST /api/outreach/collect` — сбор Telegram-контактов по темам.
- `POST /api/outreach/contacts` | `PATCH /api/outreach/contacts/:id` | `DELETE /api/outreach/contacts/:id`
- `POST /api/outreach/templates` | `DELETE /api/outreach/templates/:id`
- `POST /api/outreach/campaigns/start` | `stop` | `generate`

## Тарифы, промокоды и оплата (только через Telegram-бота)
- `GET /api/plans` — актуальные тарифы и лимиты из единой БД.
- `POST /api/payments/stars/create` — идемпотентное создание заказа для оплаты в боте (`deepLink` в `@demov2clientfybot` + `invoiceLink` для `WebApp.openInvoice`).
- `GET /api/payments/stars/:orderId` — проверка статуса оплаты заказа.
- `GET /api/payments/my` — история оплат пользователя.
- `POST /api/promo/redeem` — активация промокода (`{ code }`).

## Админ-панель (`/api/admin/*`, строго `OWNER_ID`)
Все эндпоинты проверяют `telegramId === OWNER_ID` на сервере (HTTP `403` для всех остальных пользователей):
- `GET /api/admin/overview` — сводная статистика.
- `GET /api/admin/users` | `PATCH /api/admin/users/:id` — управление пользователями, тарифами, бонусами и блокировками.
- `GET /api/admin/payments` | `POST /api/admin/payments/:id/review` — модерация заявок на оплату.
- `GET /api/admin/promos` | `POST /api/admin/promos` | `DELETE /api/admin/promos/:code` — управление промокодами.
- `POST /api/admin/broadcast` — рассылка сообщения всем пользователям бота (`{ text }`).
- `GET /api/admin/settings` | `PATCH /api/admin/settings` — редактирование цен, лимитов и реквизитов.
