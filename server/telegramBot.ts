import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {autoRetry} from '@grammyjs/auto-retry';
import {run, type RunnerHandle} from '@grammyjs/runner';
import {Bot, InlineKeyboard, InputFile, webhookCallback} from 'grammy';
import type express from 'express';
import {getOwnerIds, isBotOwner} from './security.ts';
import {
  activateSubscriptionDays,
  findOrCreateTelegramUser,
  getPlans,
  mutateDb,
  readDb,
} from './storage.ts';
import type {PaymentApplication, PaymentMethod, PromoCodeRecord} from './types.ts';
import {
  disconnectUserbot,
  getUserbotStatus,
  sendUserbotAuthCode,
  verifyUserbotAuthCode,
  verifyUserbotAuthPassword,
} from './userbot.ts';

export {getOwnerIds, isBotOwner};

export interface BotRuntimeStatus {
  running: boolean;
  username: string | null;
  mode: 'polling' | 'webhook' | 'idle';
  lastError: string | null;
}

export interface BroadcastResult {
  totalRecipients: number;
  sent: number;
  failed: number;
}

const DEFAULT_PUBLIC_WEBAPP_URL =
  'https://ais-pre-fsb7usr5hyy6bejqcpjcro-993614277555.asia-east1.run.app';
const DEFAULT_SUPPORT_URL = 'https://t.me/ClienFy_Support';
const REQUIRED_CHANNEL_USERNAME = 'Client_Fy';
const REQUIRED_CHANNEL_URL = 'https://t.me/Client_Fy';

async function isRequiredChannelMember(bot: Bot, userId: number): Promise<boolean> {
  try {
    const member = await bot.api.getChatMember(`@${REQUIRED_CHANNEL_USERNAME}`, userId);
    return (
      member.status === 'creator' ||
      member.status === 'administrator' ||
      member.status === 'member' ||
      (member.status === 'restricted' && Boolean((member as {is_member?: boolean}).is_member))
    );
  } catch (err) {
    console.error('[ClientFy Bot] Failed to check channel subscription:', err);
    return false;
  }
}
const status: BotRuntimeStatus = {
  running: false,
  username:
    process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '') || 'demov2clientfybot',
  mode: 'idle',
  lastError: null,
};

let botInstance: Bot | null = null;
let runnerHandle: RunnerHandle | null = null;

export function resolveBotToken(): string {
  return (
    process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.BOT_TOKEN?.trim() ||
    process.env.TG_BOT_TOKEN?.trim() ||
    ''
  );
}

export function getWebAppUrl(): string {
  const candidates = [process.env.WEBAPP_URL?.trim(), process.env.APP_URL?.trim()];
  for (const raw of candidates) {
    if (raw && raw !== 'MY_APP_URL' && raw.startsWith('https://')) {
      return raw.replace(/\/$/, '');
    }
  }
  return DEFAULT_PUBLIC_WEBAPP_URL;
}

function resolveSupportUrl(raw?: string | null): string {
  const trimmed = (raw || '').trim();
  if (trimmed.startsWith('https://t.me/') || trimmed.startsWith('http://t.me/')) {
    return trimmed;
  }
  if (trimmed.startsWith('@') && trimmed.length > 2) {
    return `https://t.me/${trimmed.slice(1)}`;
  }
  return DEFAULT_SUPPORT_URL;
}

export function getBotStatus(): BotRuntimeStatus {
  return {...status};
}

function escapeHtml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function mainMenuKb(tgUserId: string, supportUrl = DEFAULT_SUPPORT_URL): InlineKeyboard {
  const kb = new InlineKeyboard()
    .webApp('🌐 Открыть веб-апп', getWebAppUrl())
    .url('💬 Поддержка', resolveSupportUrl(supportUrl));

  if (isBotOwner(tgUserId)) {
    kb.row().text('⚙︎ Админ-панель', 'adm:panel');
  }
  return kb;
}

function adminPanelKb(pendingCount: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(`🧾 Заявки (${pendingCount})`, 'adm:payments')
    .text('⌘ Промокоды', 'adm:promos')
    .row()
    .text('📢 Рассылка всем', 'adm:broadcast')
    .row()
    .text('💲 Цены и лимиты', 'adm:prices')
    .text('💳 Реквизиты', 'adm:requisites')
    .row()
    .text('⬅️ В меню', 'menu:home');
}

function adminPricesKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Pro ($)', 'adm:edit:proPriceUsd')
    .text('Pro (⭐)', 'adm:edit:proPriceStars')
    .row()
    .text('Max ($)', 'adm:edit:maxPriceUsd')
    .text('Max (⭐)', 'adm:edit:maxPriceStars')
    .row()
    .text('Лимит Free', 'adm:edit:freeDailyLimit')
    .text('Лимит Pro', 'adm:edit:proDailyLimit')
    .text('Лимит Max', 'adm:edit:maxDailyLimit')
    .row()
    .text('⬅️ В админку', 'adm:panel');
}

function adminRequisitesKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text('💳 Карта / Visa', 'adm:edit:visaCardDetails')
    .row()
    .text('💎 TON кошелёк', 'adm:edit:tonWalletAddress')
    .text('🪙 GRAM кошелёк', 'adm:edit:gramWalletAddress')
    .row()
    .text('💬 Поддержка URL', 'adm:edit:supportContact')
    .row()
    .text('⬅️ В админку', 'adm:panel');
}

const EDIT_FIELD_LABELS: Record<string, string> = {
  proPriceUsd: 'цена Pro в USD (число)',
  proPriceStars: 'цена Pro в Stars (целое число)',
  maxPriceUsd: 'цена Max в USD (число)',
  maxPriceStars: 'цена Max в Stars (целое число)',
  freeDailyLimit: 'лимит Free в день (число)',
  proDailyLimit: 'лимит Pro в день (число)',
  maxDailyLimit: 'лимит Max в день (число)',
  visaCardDetails: 'реквизиты карты / Visa',
  tonWalletAddress: 'TON / USDT кошелёк',
  gramWalletAddress: 'GRAM кошелёк',
  supportContact: 'ссылка поддержки (https://t.me/...)',
};

async function buildAdminPanelSummaryText(): Promise<{text: string; pendingCount: number}> {
  const db = await readDb();
  const s = db.settings;
  const pendingCount = db.paymentApps.filter((p) => p.status === 'pending').length;
  const activePromos = Object.values(db.promoCodes).filter((p) => p.active).length;
  const tgUsersCount = Object.values(db.users).filter((u) => Boolean(u.telegramId)).length;

  const text =
    `⚙︎ <b>Админ-панель ClientFy</b>\n\n` +
    `• Пользователей с Telegram: <b>${tgUsersCount}</b>\n` +
    `• Заявок на проверке: <b>${pendingCount}</b>\n` +
    `• Активных промокодов: <b>${activePromos}</b>\n\n` +
    `<b>Цены и лимиты:</b>\n` +
    `• Free: <b>${s.freeDailyLimit}</b> кан./день\n` +
    `• Pro: <b>$${s.proPriceUsd}</b> / <b>${s.proPriceStars} ⭐</b> (${s.proDailyLimit} кан./день)\n` +
    `• Max: <b>$${s.maxPriceUsd}</b> / <b>${s.maxPriceStars} ⭐</b> (${s.maxDailyLimit} кан./день)\n\n` +
    `<b>Реквизиты:</b>\n` +
    `• Visa: <code>${escapeHtml(s.visaCardDetails)}</code>\n` +
    `• TON: <code>${escapeHtml(s.tonWalletAddress)}</code>\n` +
    `• GRAM: <code>${escapeHtml(s.gramWalletAddress)}</code>\n` +
    `• Поддержка: <code>${escapeHtml(s.supportContact)}</code>`;

  return {text, pendingCount};
}

function checkoutMethodKeyboard(
  planId: 'pro' | 'max',
  starsAmount: number,
  priceUsd: number,
  orderId = '',
): InlineKeyboard {
  const suffix = orderId ? `:${orderId}` : '';
  return new InlineKeyboard()
    .text(`⭐ Оплатить ${starsAmount} Stars`, `pay:stars:${planId}${suffix}`)
    .row()
    .text(`💳 Visa ($${priceUsd})`, `pay:manual:visa:${planId}${suffix}`)
    .text(`💎 TON ($${priceUsd})`, `pay:manual:ton:${planId}${suffix}`)
    .text(`🪙 GRAM ($${priceUsd})`, `pay:manual:gram:${planId}${suffix}`)
    .row()
    .text('⬅️ В меню', 'menu:home');
}

async function sendWelcomeMessage(
  bot: Bot,
  chatId: number,
  tgUserId: string,
  caption: string,
  supportUrl: string,
) {
  const kb = mainMenuKb(tgUserId, supportUrl);
  const videoPath = path.resolve(process.cwd(), 'public/assets/aistudio/animation_18d57451.mp4');
  if (fs.existsSync(videoPath)) {
    try {
      await bot.api.sendAnimation(chatId, new InputFile(videoPath), {
        caption,
        reply_markup: kb,
      });
      return;
    } catch {
      try {
        await bot.api.sendVideo(chatId, new InputFile(videoPath), {
          caption,
          reply_markup: kb,
        });
        return;
      } catch {
        // fallback to text message
      }
    }
  }
  await bot.api.sendMessage(chatId, caption, {
    reply_markup: kb,
    link_preview_options: {is_disabled: true},
  });
}

async function sendStarsInvoiceForOrder(
  bot: Bot,
  chatId: number,
  planId: 'pro' | 'max',
  starsAmount: number,
  payload: string,
  orderTitle: string,
) {
  const title = `ClientFy — Тариф ${planId.toUpperCase()} (30 дней)`;
  const description =
    planId === 'max'
      ? 'Доступ к поиску каналов и авторассылке на 30 дней'
      : 'Расширенный доступ к поиску YouTube-каналов на 30 дней';

  await bot.api.sendInvoice(chatId, title, `${orderTitle}\n${description}`, payload, 'XTR', [
    {label: `Тариф ${planId.toUpperCase()}`, amount: starsAmount},
  ]);
}

export async function createStarsInvoiceLink(
  planId: 'pro' | 'max',
  starsAmount: number,
  payload: string,
  orderTitle: string,
): Promise<string | null> {
  if (!botInstance) return null;
  const title = `ClientFy — Тариф ${planId.toUpperCase()} (30 дней)`;
  const description =
    planId === 'max'
      ? 'Доступ к поиску каналов и авторассылке на 30 дней'
      : 'Расширенный доступ к поиску YouTube-каналов на 30 дней';
  try {
    return await botInstance.api.createInvoiceLink(
      title,
      `${orderTitle} · ${description}`,
      payload,
      '',
      'XTR',
      [{label: `Тариф ${planId.toUpperCase()}`, amount: starsAmount}],
    );
  } catch {
    return null;
  }
}

export async function broadcastToAllTelegramUsers(rawText: string): Promise<BroadcastResult> {
  if (!botInstance || !status.running) {
    throw new Error('Telegram-бот сейчас не запущен');
  }
  const text = rawText.trim();
  if (!text) {
    throw new Error('Текст рассылки не может быть пустым');
  }

  const db = await readDb();
  const recipientIds = Array.from(
    new Set(
      Object.values(db.users)
        .filter((u) => !u.blocked && u.telegramId && /^\d+$/.test(u.telegramId))
        .map((u) => String(u.telegramId)),
    ),
  );

  let sent = 0;
  let failed = 0;

  for (const chatId of recipientIds) {
    try {
      await botInstance.api.sendMessage(chatId, escapeHtml(text), {
        link_preview_options: {is_disabled: true},
      });
      sent += 1;
    } catch {
      failed += 1;
    }
    // Gentle pacing to avoid Telegram flood limits
    await new Promise((r) => setTimeout(r, 45));
  }

  return {
    totalRecipients: recipientIds.length,
    sent,
    failed,
  };
}

export async function notifyOwnersAboutPayment(app: PaymentApplication): Promise<void> {
  if (!botInstance || !status.running) return;
  const text =
    `🧾 <b>Новая заявка на оплату</b>\n\n` +
    `• ID: <code>${escapeHtml(app.id)}</code>\n` +
    `• Пользователь: <b>${escapeHtml(app.username)}</b>\n` +
    `• Тариф: <b>${app.planId.toUpperCase()}</b>\n` +
    `• Способ: <b>${app.method.toUpperCase()}</b> · ${escapeHtml(app.amountLabel)}\n` +
    (app.comment ? `• Комментарий: ${escapeHtml(app.comment)}\n` : '');

  const kb = new InlineKeyboard()
    .text('✅ Подтвердить', `adm:approve:${app.id}`)
    .text('❌ Отклонить', `adm:reject:${app.id}`);

  let webPhotoBuffer: Buffer | null = null;
  if (!app.receiptFileId && app.receiptDataUrl) {
    const match = app.receiptDataUrl.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
    if (match?.[2]) {
      try {
        webPhotoBuffer = Buffer.from(match[2], 'base64');
      } catch {
        webPhotoBuffer = null;
      }
    }
  }

  for (const ownerId of getOwnerIds()) {
    try {
      if (app.receiptFileId) {
        try {
          await botInstance.api.sendPhoto(ownerId, app.receiptFileId, {
            caption: text,
            reply_markup: kb,
          });
          continue;
        } catch {
          try {
            await botInstance.api.sendDocument(ownerId, app.receiptFileId, {
              caption: text,
              reply_markup: kb,
            });
            continue;
          } catch {
            // fallback to text
          }
        }
      } else if (webPhotoBuffer) {
        try {
          await botInstance.api.sendPhoto(
            ownerId,
            new InputFile(webPhotoBuffer, app.receiptName || 'receipt.png'),
            {
              caption: text,
              reply_markup: kb,
            },
          );
          continue;
        } catch {
          // fallback to text
        }
      }
      await botInstance.api.sendMessage(ownerId, text, {
        reply_markup: kb,
        link_preview_options: {is_disabled: true},
      });
    } catch {
      // ignore unreachable owner chat
    }
  }
}

export async function notifyTelegramUserPaymentResult(
  app: PaymentApplication,
  decision: 'approved' | 'rejected',
): Promise<void> {
  if (!botInstance || !status.running || !app.telegramUserId) return;
  const text =
    decision === 'approved'
      ? `✅ <b>Оплата подтверждена!</b>\nТариф <b>${app.planId.toUpperCase()}</b> активирован на 30 дней.`
      : `❌ Заявка на оплату <code>${escapeHtml(app.id)}</code> отклонена администратором.` +
        (app.adminNote ? `\nПричина: ${escapeHtml(app.adminNote)}` : '');
  await botInstance.api
    .sendMessage(app.telegramUserId, text, {link_preview_options: {is_disabled: true}})
    .catch(() => {});
}

export async function notifyOwnersAboutStarsSuccess(
  username: string,
  planId: string,
  starsAmount: number,
  chargeId: string,
): Promise<void> {
  if (!botInstance || !status.running) return;
  const text =
    `⭐ <b>Оплата Telegram Stars подтверждена</b>\n\n` +
    `• Пользователь: <b>${escapeHtml(username)}</b>\n` +
    `• Тариф: <b>${planId.toUpperCase()}</b> (30 дн.)\n` +
    `• Сумма: <b>${starsAmount} ⭐</b>\n` +
    `• Чек: <code>${escapeHtml(chargeId)}</code>`;

  for (const ownerId of getOwnerIds()) {
    try {
      await botInstance.api.sendMessage(ownerId, text, {
        link_preview_options: {is_disabled: true},
      });
    } catch {
      // ignore
    }
  }
}

async function sendPromosList(ctx: {reply: Bot['api']['sendMessage'] extends never ? never : (text: string, opts?: Record<string, unknown>) => Promise<unknown>}) {
  const db = await readDb();
  const promos = Object.values(db.promoCodes).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );

  const kb = new InlineKeyboard().text('➕ Создать промокод', 'adm:promo_new').row();
  let lines = '';

  if (promos.length === 0) {
    lines = 'Промокоды пока не созданы.';
  } else {
    for (const p of promos.slice(0, 12)) {
      const desc =
        p.type === 'requests'
          ? `+${p.value} запр.`
          : `${(p.plan || 'max').toUpperCase()} на ${p.value} дн.`;
      const stateIcon = p.active ? '🟢' : '⚪️';
      lines += `${stateIcon} <code>${escapeHtml(p.code)}</code> — ${desc} (${p.usedBy.length}/${p.maxUses})\n`;
      if (p.active) {
        kb.copyText(`📋 ${p.code}`, p.code)
          .text(`🚫 ${p.code}`, `adm:promo_off:${p.code}`)
          .row();
      }
    }
  }
  kb.text('⬅️ В админку', 'adm:panel');

  await ctx.reply(`⌘ <b>Промокоды</b>\n\n${lines}`, {
    reply_markup: kb,
    link_preview_options: {is_disabled: true},
  });
}

function configureBotHandlers(bot: Bot): void {
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();
    if (isBotOwner(String(userId))) return next();

    const joinKeyboard = new InlineKeyboard()
      .url('📢 Подписаться на канал', REQUIRED_CHANNEL_URL)
      .row()
      .text('✅ Я подписался', 'sub:check');

    if (ctx.callbackQuery?.data === 'sub:check') {
      const subscribed = await isRequiredChannelMember(bot, userId);
      await ctx.answerCallbackQuery({
        text: subscribed ? 'Подписка подтверждена ✅' : 'Вы пока не подписаны',
        show_alert: true,
      }).catch(() => {});
      if (subscribed) {
        await ctx.reply('✅ Доступ открыт. Нажмите /start или /menu.', {
          reply_markup: mainMenuKb(String(userId), DEFAULT_SUPPORT_URL),
        }).catch(() => {});
      } else {
        await ctx.reply(
          '🔒 <b>Доступ к боту закрыт</b>\n\nДля использования ClientFy подпишитесь на канал, затем нажмите «Я подписался».',
          {reply_markup: joinKeyboard},
        ).catch(() => {});
      }
      return;
    }

    const subscribed = await isRequiredChannelMember(bot, userId);
    if (subscribed) return next();

    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: 'Сначала подпишитесь на канал',
        show_alert: true,
      }).catch(() => {});
    }

    await ctx.reply(
      '🔒 <b>Доступ к боту закрыт</b>\n\nДля использования ClientFy подпишитесь на наш канал, затем нажмите «Я подписался».',
      {reply_markup: joinKeyboard},
    ).catch(() => {});
    return;
  });

  bot.catch((err) => {
    status.lastError = err.message;
    console.error('[ClientFy Bot] Error:', err.error);
  });

  bot.command(['start', 'menu'], async (ctx) => {
    const tgId = String(ctx.from?.id || '');
    if (!tgId) return;
    const payload = ctx.match?.trim() || '';

    await mutateDb((d) => {
      if (d.botState[tgId]) {
        d.botState[tgId] = {awaiting: null};
      }
    });

    // Deep-link: /start link_<code>
    if (payload.startsWith('link_')) {
      const code = payload.slice('link_'.length);
      const linked = await mutateDb((db) => {
        const tokenRec = db.telegramLinks[code];
        if (!tokenRec) {
          return {
            ok: false as const,
            error: 'Ссылка привязки не найдена или истекла.',
            supportUrl: db.settings.supportContact,
          };
        }
        const webUser = db.users[tokenRec.userId];
        if (!webUser) {
          return {
            ok: false as const,
            error: 'Веб-аккаунт не найден.',
            supportUrl: db.settings.supportContact,
          };
        }
        if (webUser.blocked) {
          return {
            ok: false as const,
            error: 'Аккаунт заблокирован администратором.',
            supportUrl: db.settings.supportContact,
          };
        }

        webUser.telegramId = tgId;
        webUser.telegramUsername = ctx.from?.username || webUser.telegramUsername || null;
        delete db.telegramLinks[code];
        return {
          ok: true as const,
          username: webUser.username,
          supportUrl: db.settings.supportContact,
        };
      });

      if (!linked.ok) {
        await ctx.reply(`❌ ${linked.error}`, {
          reply_markup: mainMenuKb(tgId, linked.supportUrl),
        });
        return;
      }
      await ctx.reply(
        `✅ <b>Telegram привязан к аккаунту ${escapeHtml(linked.username)}!</b>`,
        {reply_markup: mainMenuKb(tgId, linked.supportUrl)},
      );
      return;
    }

    const user = await mutateDb((db) =>
      findOrCreateTelegramUser(db, tgId, ctx.from?.username, ctx.from?.first_name),
    );

    if (user.blocked) {
      await ctx.reply('⛔ Ваш аккаунт заблокирован администратором.');
      return;
    }

    const dbSnapshot = await readDb();
    const supportUrl = dbSnapshot.settings.supportContact;
    const plans = getPlans(dbSnapshot.settings);

    // Deep-link from WebApp checkout: /start pay_<orderId>
    if (payload.startsWith('pay_')) {
      const orderId = payload.slice('pay_'.length);
      const order = dbSnapshot.starOrders[orderId];
      if (!order) {
        await ctx.reply('❌ Заказ не найден. Выберите тариф заново в веб-аппе.', {
          reply_markup: mainMenuKb(tgId, supportUrl),
        });
        return;
      }
      if (order.status === 'paid') {
        await ctx.reply('✅ Этот заказ уже оплачен и тариф активирован!', {
          reply_markup: mainMenuKb(tgId, supportUrl),
        });
        return;
      }

      const plan = plans.find((p) => p.id === order.planId)!;
      await ctx.reply(
        `💳 <b>Оплата тарифа ${plan.name} (30 дней)</b>\n\n` +
          `• Заказ: <code>${escapeHtml(order.id)}</code>\n` +
          `• Telegram Stars: <b>${order.starsAmount} ⭐</b> (мгновенная активация)\n` +
          `• Visa / TON / GRAM: <b>$${plan.priceUsd}</b> (проверка чека администратором)\n\n` +
          `Выберите удобный способ оплаты:`,
        {
          reply_markup: checkoutMethodKeyboard(
            order.planId,
            order.starsAmount,
            plan.priceUsd,
            order.id,
          ),
        },
      );
      return;
    }

    // Deep-link: /start buy_pro or /start buy_max
    if (payload === 'buy_pro' || payload === 'buy_max') {
      const planId = payload === 'buy_max' ? 'max' : 'pro';
      const plan = plans.find((p) => p.id === planId)!;
      await ctx.reply(
        `💳 <b>Оплата тарифа ${plan.name} (30 дней)</b>\n\n` +
          `• Telegram Stars: <b>${plan.priceStars} ⭐</b>\n` +
          `• Visa / TON / GRAM: <b>$${plan.priceUsd}</b>\n\n` +
          `Выберите способ оплаты:`,
        {
          reply_markup: checkoutMethodKeyboard(planId, plan.priceStars, plan.priceUsd),
        },
      );
      return;
    }

    const welcome =
      `<b>ClientFy</b>\n\n` +
      `Поиск YouTube-каналов, база контактов, рассылка, подписки и личный кабинет — в веб-аппе по кнопке ниже.\n\n` +
      `• Быстрая оплата тарифов: /pay\n` +
      `• Подключение аккаунта для рассылки: /login`;

    await sendWelcomeMessage(bot, ctx.chat.id, tgId, welcome, supportUrl);
  });

  bot.command('pay', async (ctx) => {
    const tgId = String(ctx.from?.id || '');
    if (!tgId) return;
    const db = await readDb();
    const plans = getPlans(db.settings);
    const pro = plans.find((p) => p.id === 'pro')!;
    const max = plans.find((p) => p.id === 'max')!;

    const kb = new InlineKeyboard()
      .text(`Pro — ${pro.priceStars} ⭐ / $${pro.priceUsd}`, 'pay:choose:pro')
      .row()
      .text(`Max — ${max.priceStars} ⭐ / $${max.priceUsd}`, 'pay:choose:max')
      .row()
      .text('⬅️ В меню', 'menu:home');

    await ctx.reply(
      `💳 <b>Оплата подписки ClientFy</b>\n\n` +
        `• <b>Pro</b> (${pro.dailyLimit} кан./день): <b>${pro.priceStars} ⭐</b> или <b>$${pro.priceUsd}</b>\n` +
        `• <b>Max</b> (${max.dailyLimit} кан./день + рассылка): <b>${max.priceStars} ⭐</b> или <b>$${max.priceUsd}</b>\n\n` +
        `Выберите тариф:`,
      {reply_markup: kb},
    );
  });

  // Shared Telegram Phone + Code + 2FA Auth inside the bot (identical to WebApp)
  bot.command('login', async (ctx) => {
    const tgId = String(ctx.from?.id || '');
    if (!tgId) return;
    const user = await mutateDb((db) =>
      findOrCreateTelegramUser(db, tgId, ctx.from?.username, ctx.from?.first_name),
    );
    if (user.blocked) {
      await ctx.reply('⛔ Ваш аккаунт заблокирован.');
      return;
    }

    const st = await getUserbotStatus(user.id);
    if (st.connected) {
      const kb = new InlineKeyboard()
        .text('🔌 Отключить аккаунт', 'tgauth:disconnect')
        .row()
        .webApp('🌐 Открыть веб-апп', getWebAppUrl());
      await ctx.reply(
        `✅ <b>Telegram-аккаунт уже подключён</b>\n\n` +
          `• Профиль: <b>${escapeHtml(st.displayName || 'Telegram')}</b>\n` +
          `• Телефон: <code>${escapeHtml(st.phoneMasked || '')}</code>\n` +
          `Эта сессия автоматически активна и в веб-аппе.`,
        {reply_markup: kb},
      );
      return;
    }

    await mutateDb((d) => {
      d.botState[tgId] = {awaiting: 'tg_phone'};
    });

    await ctx.reply(
      `📱 <b>Вход в Telegram-аккаунт для рассылки</b>\n\n` +
        `Отправьте ваш номер телефона в международном формате (например, <code>+79991234567</code>).\n` +
        `После входа аккаунт синхронизируется с веб-аппом.`,
      {reply_markup: new InlineKeyboard().text('⬅️ Отмена', 'menu:home')},
    );
  });

  bot.command('admin', async (ctx) => {
    const tgId = String(ctx.from?.id || '');
    if (!isBotOwner(tgId)) {
      await ctx.reply('⛔ Доступ разрешён только администратору.');
      return;
    }
    await mutateDb((d) => {
      if (d.botState[tgId]) d.botState[tgId] = {awaiting: null};
    });
    const summary = await buildAdminPanelSummaryText();
    await ctx.reply(summary.text, {
      reply_markup: adminPanelKb(summary.pendingCount),
      link_preview_options: {is_disabled: true},
    });
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const tgId = String(ctx.from?.id || '');
    await ctx.answerCallbackQuery().catch(() => {});

    const dbSnapshot = await readDb();
    const supportUrl = dbSnapshot.settings.supportContact;

    if (data === 'menu:home') {
      await mutateDb((d) => {
        if (d.botState[tgId]) d.botState[tgId] = {awaiting: null};
      });
      await ctx.reply(
        `<b>ClientFy</b>\n\nОткройте веб-апп или напишите в поддержку по кнопкам ниже.`,
        {reply_markup: mainMenuKb(tgId, supportUrl)},
      );
      return;
    }

    if (data === 'tgauth:disconnect') {
      const user = await mutateDb((db) =>
        findOrCreateTelegramUser(db, tgId, ctx.from?.username, ctx.from?.first_name),
      );
      await disconnectUserbot(user.id);
      await ctx.reply('🔌 Telegram-аккаунт отключён.', {
        reply_markup: mainMenuKb(tgId, supportUrl),
      });
      return;
    }

    // ---- Payment Callbacks (Bot-Only Checkout) ----
    if (data === 'pay:choose:pro' || data === 'pay:choose:max') {
      const planId = data.endsWith('max') ? 'max' : 'pro';
      const plans = getPlans(dbSnapshot.settings);
      const plan = plans.find((p) => p.id === planId)!;
      await ctx.reply(
        `💳 <b>Оплата тарифа ${plan.name} (30 дней)</b>\n\n` +
          `• Telegram Stars: <b>${plan.priceStars} ⭐</b>\n` +
          `• Visa / TON / GRAM: <b>$${plan.priceUsd}</b>\n\n` +
          `Выберите способ оплаты:`,
        {
          reply_markup: checkoutMethodKeyboard(planId, plan.priceStars, plan.priceUsd),
        },
      );
      return;
    }

    if (data.startsWith('pay:stars:')) {
      const [, , planRaw, orderIdRaw] = data.split(':');
      const planId: 'pro' | 'max' = planRaw === 'max' ? 'max' : 'pro';
      const plans = getPlans(dbSnapshot.settings);
      const plan = plans.find((p) => p.id === planId)!;

      let payload = `tg_plan:${planId}`;
      let starsAmount = plan.priceStars;
      let orderTitle = `Подписка ${plan.name}`;

      if (orderIdRaw) {
        const order = dbSnapshot.starOrders[orderIdRaw];
        if (!order) {
          await ctx.reply('❌ Заказ не найден. Попробуйте выбрать тариф заново через /pay.');
          return;
        }
        if (order.status === 'paid') {
          await ctx.reply('✅ Этот заказ уже оплачен!', {
            reply_markup: mainMenuKb(tgId, supportUrl),
          });
          return;
        }
        payload = `web_order:${order.id}`;
        starsAmount = order.starsAmount;
        orderTitle = `Оплата для ${order.username}`;
      }

      await sendStarsInvoiceForOrder(
        bot,
        ctx.chat!.id,
        planId,
        starsAmount,
        payload,
        orderTitle,
      );
      return;
    }

    if (data.startsWith('pay:manual:')) {
      const [, , methodRaw, planRaw] = data.split(':');
      const method: PaymentMethod =
        methodRaw === 'visa' || methodRaw === 'ton' || methodRaw === 'gram'
          ? methodRaw
          : 'ton';
      const planId: 'pro' | 'max' = planRaw === 'max' ? 'max' : 'pro';
      const plans = getPlans(dbSnapshot.settings);
      const plan = plans.find((p) => p.id === planId)!;

      const requisites =
        method === 'visa'
          ? dbSnapshot.settings.visaCardDetails
          : method === 'ton'
            ? dbSnapshot.settings.tonWalletAddress
            : dbSnapshot.settings.gramWalletAddress;

      const methodTitle =
        method === 'visa' ? 'Карта / Visa' : method === 'ton' ? 'TON / USDT (TON)' : 'GRAM';

      await mutateDb((d) => {
        d.botState[tgId] = {
          awaiting: 'pay_receipt',
          payPlanId: planId,
          payMethod: method,
          payAmountLabel: `$${plan.priceUsd} (${method.toUpperCase()})`,
        };
      });

      const kb = new InlineKeyboard()
        .copyText('📋 Скопировать реквизиты', requisites)
        .row()
        .text('⬅️ Отмена', 'menu:home');

      await ctx.reply(
        `💳 <b>Оплата: ${methodTitle}</b>\n\n` +
          `• Тариф: <b>${plan.name}</b> (30 дней)\n` +
          `• Сумма к переводу: <b>$${plan.priceUsd}</b>\n` +
          `• Реквизиты:\n<code>${escapeHtml(requisites)}</code>\n\n` +
          `📸 После перевода <b>отправьте сюда скриншот чека</b> (фото/файл) или хэш транзакции текстом.`,
        {reply_markup: kb, link_preview_options: {is_disabled: true}},
      );
      return;
    }

    // ---- Admin Panel Callbacks ----
    if (data === 'adm:panel') {
      if (!isBotOwner(tgId)) {
        await ctx.reply('⛔ Нет прав администратора.');
        return;
      }
      await mutateDb((d) => {
        if (d.botState[tgId]) d.botState[tgId] = {awaiting: null};
      });
      const summary = await buildAdminPanelSummaryText();
      await ctx.reply(summary.text, {
        reply_markup: adminPanelKb(summary.pendingCount),
        link_preview_options: {is_disabled: true},
      });
      return;
    }

    if (data === 'adm:promos') {
      if (!isBotOwner(tgId)) return;
      await sendPromosList(ctx as never);
      return;
    }

    if (data === 'adm:promo_new') {
      if (!isBotOwner(tgId)) return;
      await mutateDb((d) => {
        d.botState[tgId] = {awaiting: 'promo_code'};
      });
      await ctx.reply(
        `⌘ <b>Создание промокода (шаг 1/4)</b>\n\n` +
          `Отправьте код промокода (латиница, цифры, _ или -, например <code>START50</code>):`,
        {reply_markup: new InlineKeyboard().text('⬅️ Отмена', 'adm:promos')},
      );
      return;
    }

    if (data.startsWith('adm:promo_type:')) {
      if (!isBotOwner(tgId)) return;
      const choice = data.split(':')[2];
      const promoType = choice === 'requests' ? 'requests' : 'subscription';
      const promoPlan = choice === 'pro' ? 'pro' : 'max';

      await mutateDb((d) => {
        d.botState[tgId] = {
          ...(d.botState[tgId] || {}),
          awaiting: 'promo_value',
          promoType,
          promoPlan,
        };
      });

      const prompt =
        promoType === 'requests'
          ? 'Сколько бонусных запросов начислить (число)?'
          : `На сколько дней выдать подписку ${promoPlan.toUpperCase()} (число)?`;

      await ctx.reply(`⌘ <b>Шаг 3/4</b>\n\n${prompt}`, {
        reply_markup: new InlineKeyboard().text('⬅️ Отмена', 'adm:promos'),
      });
      return;
    }

    if (data.startsWith('adm:promo_off:')) {
      if (!isBotOwner(tgId)) return;
      const code = data.slice('adm:promo_off:'.length).toUpperCase();
      await mutateDb((d) => {
        if (d.promoCodes[code]) d.promoCodes[code].active = false;
      });
      await sendPromosList(ctx as never);
      return;
    }

    if (data === 'adm:broadcast') {
      if (!isBotOwner(tgId)) return;
      const tgUsers = Object.values(dbSnapshot.users).filter(
        (u) => !u.blocked && u.telegramId && /^\d+$/.test(u.telegramId),
      ).length;
      await mutateDb((d) => {
        d.botState[tgId] = {awaiting: 'broadcast_text'};
      });
      await ctx.reply(
        `📢 <b>Рассылка всем пользователям бота</b>\n\n` +
          `Получателей в базе: <b>${tgUsers}</b>\n` +
          `Отправьте текст сообщения для рассылки:`,
        {reply_markup: new InlineKeyboard().text('⬅️ Отмена', 'adm:panel')},
      );
      return;
    }

    if (data === 'adm:broadcast_send') {
      if (!isBotOwner(tgId)) return;
      const draft = String(dbSnapshot.botState[tgId]?.broadcastDraft || '').trim();
      await mutateDb((d) => {
        d.botState[tgId] = {awaiting: null};
      });
      if (!draft) {
        await ctx.reply('⚠️ Черновик рассылки пуст.', {
          reply_markup: new InlineKeyboard().text('⬅️ В админку', 'adm:panel'),
        });
        return;
      }
      await ctx.reply('⏳ Выполняю рассылку...');
      try {
        const res = await broadcastToAllTelegramUsers(draft);
        await ctx.reply(
          `✅ <b>Рассылка завершена</b>\n\n` +
            `• Всего получателей: <b>${res.totalRecipients}</b>\n` +
            `• Отправлено: <b>${res.sent}</b>\n` +
            `• Ошибок (бот заблокирован/недоступен): <b>${res.failed}</b>`,
          {reply_markup: new InlineKeyboard().text('⬅️ В админку', 'adm:panel')},
        );
      } catch (err) {
        await ctx.reply(
          `⚠️ Ошибка рассылки: ${escapeHtml(err instanceof Error ? err.message : String(err))}`,
          {reply_markup: new InlineKeyboard().text('⬅️ В админку', 'adm:panel')},
        );
      }
      return;
    }

    if (data === 'adm:prices') {
      if (!isBotOwner(tgId)) return;
      await ctx.reply('💲 <b>Выберите цену или лимит для изменения:</b>', {
        reply_markup: adminPricesKb(),
      });
      return;
    }

    if (data === 'adm:requisites') {
      if (!isBotOwner(tgId)) return;
      await ctx.reply('💳 <b>Выберите реквизиты для изменения:</b>', {
        reply_markup: adminRequisitesKb(),
      });
      return;
    }

    if (data.startsWith('adm:edit:')) {
      if (!isBotOwner(tgId)) return;
      const field = data.slice('adm:edit:'.length);
      if (!(field in EDIT_FIELD_LABELS)) return;

      const currentVal = String(
        (dbSnapshot.settings as unknown as Record<string, unknown>)[field] ?? '',
      );
      await mutateDb((d) => {
        d.botState[tgId] = {
          ...(d.botState[tgId] || {}),
          awaiting: 'adm_edit',
          editField: field,
        };
      });

      await ctx.reply(
        `✏️ Отправьте новое значение для <b>${escapeHtml(EDIT_FIELD_LABELS[field])}</b>\n` +
          `Текущее значение: <code>${escapeHtml(currentVal)}</code>`,
        {reply_markup: new InlineKeyboard().text('⬅️ Отмена', 'adm:panel')},
      );
      return;
    }

    if (data === 'adm:payments') {
      if (!isBotOwner(tgId)) return;
      const pending = dbSnapshot.paymentApps.filter((p) => p.status === 'pending');
      if (pending.length === 0) {
        await ctx.reply('🧾 Ожидающих заявок на оплату нет.', {
          reply_markup: new InlineKeyboard().text('⬅️ В админку', 'adm:panel'),
        });
        return;
      }
      for (const app of pending.slice(0, 10)) {
        const kb = new InlineKeyboard()
          .text('✅ Подтвердить', `adm:approve:${app.id}`)
          .text('❌ Отклонить', `adm:reject:${app.id}`);
        await ctx.reply(
          `🧾 Заявка <code>${escapeHtml(app.id)}</code>\n` +
            `Пользователь: <b>${escapeHtml(app.username)}</b>\n` +
            `Тариф: <b>${app.planId.toUpperCase()}</b> · ${escapeHtml(app.amountLabel)}\n` +
            (app.comment ? `Комментарий: ${escapeHtml(app.comment)}` : ''),
          {reply_markup: kb},
        );
      }
      return;
    }

    if (data.startsWith('adm:approve:') || data.startsWith('adm:reject:')) {
      if (!isBotOwner(tgId)) {
        await ctx.reply('⛔ Нет прав администратора.');
        return;
      }
      const isApprove = data.startsWith('adm:approve:');
      const appId = data.split(':')[2];
      const review = await mutateDb((db) => {
        const app = db.paymentApps.find((p) => p.id === appId);
        if (!app) return {error: 'Заявка не найдена'};
        if (app.status !== 'pending') return {error: `Заявка уже обработана (${app.status})`};

        app.status = isApprove ? 'approved' : 'rejected';
        app.reviewedAt = new Date().toISOString();
        app.reviewedBy = `tg:${tgId}`;

        if (isApprove) {
          const u = db.users[app.userId];
          if (u && (app.planId === 'pro' || app.planId === 'max')) {
            activateSubscriptionDays(u, app.planId, 30);
          }
        }
        return {app};
      });

      if ('error' in review) {
        await ctx.reply(`⚠️ ${review.error}`);
        return;
      }

      const app = review.app;
      await ctx.editMessageReplyMarkup({reply_markup: undefined}).catch(() => {});
      await ctx.reply(
        isApprove
          ? `✅ Заявка <code>${escapeHtml(app.id)}</code> подтверждена. Тариф ${app.planId.toUpperCase()} активирован.`
          : `❌ Заявка <code>${escapeHtml(app.id)}</code> отклонена.`,
      );

      if (app.telegramUserId) {
        await bot.api
          .sendMessage(
            app.telegramUserId,
            isApprove
              ? `✅ <b>Оплата подтверждена!</b>\nТариф <b>${app.planId.toUpperCase()}</b> активирован на 30 дней.`
              : `❌ Заявка <code>${escapeHtml(app.id)}</code> отклонена администратором.`,
          )
          .catch(() => {});
      }
    }
  });

  // Photo or document receipt handler for bot-only Visa / TON / GRAM payments
  bot.on(['message:photo', 'message:document'], async (ctx) => {
    const tgId = String(ctx.from?.id || '');
    if (!tgId) return;
    const db = await readDb();
    const state = db.botState[tgId] || {};
    if (state.awaiting !== 'pay_receipt') return;

    const planId: 'pro' | 'max' = state.payPlanId === 'max' ? 'max' : 'pro';
    const methodRaw = String(state.payMethod || 'ton');
    const method: PaymentMethod =
      methodRaw === 'visa' || methodRaw === 'ton' || methodRaw === 'gram' ? methodRaw : 'ton';
    const amountLabel = String(state.payAmountLabel || method.toUpperCase());
    const caption = String(ctx.message.caption || '').trim().slice(0, 500);

    const fileId = ctx.message.photo
      ? ctx.message.photo[ctx.message.photo.length - 1].file_id
      : ctx.message.document?.file_id || null;

    const appRecord = await mutateDb((d) => {
      const user = findOrCreateTelegramUser(d, tgId, ctx.from?.username, ctx.from?.first_name);
      const record: PaymentApplication = {
        id: `pay_${crypto.randomBytes(6).toString('hex')}`,
        userId: user.id,
        username: user.username,
        planId,
        method,
        amountLabel,
        comment: caption || `Оплата через бота (${method.toUpperCase()})`,
        receiptDataUrl: null,
        receiptName: null,
        receiptFileId: fileId,
        telegramUserId: tgId,
        telegramMessageId: ctx.message.message_id,
        status: 'pending',
        adminNote: '',
        createdAt: new Date().toISOString(),
        reviewedAt: null,
        reviewedBy: null,
      };
      d.paymentApps.unshift(record);
      d.botState[tgId] = {awaiting: null};
      return record;
    });

    await notifyOwnersAboutPayment(appRecord);
    await ctx.reply(
      `✅ <b>Чек получен!</b>\n\n` +
        `Заявка <code>${escapeHtml(appRecord.id)}</code> отправлена на проверку.\n` +
        `Как только администратор подтвердит оплату, тариф <b>${planId.toUpperCase()}</b> активируется автоматически.`,
      {reply_markup: mainMenuKb(tgId, db.settings.supportContact)},
    );
  });

  // Text handler for: (1) bot payment hash/comment, (2) bot TG phone/code/2FA login, (3) owner admin wizards
  bot.on('message:text', async (ctx) => {
    const tgId = String(ctx.from?.id || '');
    const text = ctx.message.text.trim();
    if (!tgId || text.startsWith('/')) return;

    const db = await readDb();
    const state = db.botState[tgId] || {};
    const awaiting = String(state.awaiting || '');
    const supportUrl = db.settings.supportContact;

    // 1. Receipt hash / comment submitted as text
    if (awaiting === 'pay_receipt') {
      const planId: 'pro' | 'max' = state.payPlanId === 'max' ? 'max' : 'pro';
      const methodRaw = String(state.payMethod || 'ton');
      const method: PaymentMethod =
        methodRaw === 'visa' || methodRaw === 'ton' || methodRaw === 'gram' ? methodRaw : 'ton';
      const amountLabel = String(state.payAmountLabel || method.toUpperCase());

      const appRecord = await mutateDb((d) => {
        const user = findOrCreateTelegramUser(d, tgId, ctx.from?.username, ctx.from?.first_name);
        const record: PaymentApplication = {
          id: `pay_${crypto.randomBytes(6).toString('hex')}`,
          userId: user.id,
          username: user.username,
          planId,
          method,
          amountLabel,
          comment: text.slice(0, 500),
          receiptDataUrl: null,
          receiptName: null,
          telegramUserId: tgId,
          telegramMessageId: ctx.message.message_id,
          status: 'pending',
          adminNote: '',
          createdAt: new Date().toISOString(),
          reviewedAt: null,
          reviewedBy: null,
        };
        d.paymentApps.unshift(record);
        d.botState[tgId] = {awaiting: null};
        return record;
      });

      await notifyOwnersAboutPayment(appRecord);
      await ctx.reply(
        `✅ <b>Заявка <code>${escapeHtml(appRecord.id)}</code> отправлена на проверку!</b>`,
        {reply_markup: mainMenuKb(tgId, supportUrl)},
      );
      return;
    }

    // 2. Shared Phone -> Code -> 2FA Login in Bot
    if (awaiting === 'tg_phone') {
      const user = await mutateDb((d) =>
        findOrCreateTelegramUser(d, tgId, ctx.from?.username, ctx.from?.first_name),
      );
      const outcome = await sendUserbotAuthCode(user.id, text);
      if (!outcome.ok) {
        await ctx.reply(`⚠️ ${escapeHtml(outcome.error)}`);
        return;
      }
      await mutateDb((d) => {
        d.botState[tgId] = {awaiting: 'tg_code'};
      });
      await ctx.reply(
        `🔐 Код отправлен в Telegram на <code>${escapeHtml(outcome.phoneMasked)}</code>.\n` +
          `Отправьте полученный цифровой код сюда:`,
        {reply_markup: new InlineKeyboard().text('⬅️ Отмена', 'menu:home')},
      );
      return;
    }

    if (awaiting === 'tg_code') {
      const user = await mutateDb((d) =>
        findOrCreateTelegramUser(d, tgId, ctx.from?.username, ctx.from?.first_name),
      );
      const outcome = await verifyUserbotAuthCode(user.id, text);
      if (!outcome.ok) {
        await ctx.reply(`⚠️ ${escapeHtml(outcome.error)}`);
        return;
      }
      if (outcome.step === 'password') {
        await mutateDb((d) => {
          d.botState[tgId] = {awaiting: 'tg_2fa'};
        });
        await ctx.reply('🔑 Введите ваш облачный пароль Telegram (2FA):');
        return;
      }
      await mutateDb((d) => {
        d.botState[tgId] = {awaiting: null};
      });
      await ctx.reply(
        `✅ <b>Аккаунт Telegram успешно подключён!</b>\n` +
          `Теперь он доступен в веб-аппе для рассылки.`,
        {reply_markup: mainMenuKb(tgId, supportUrl)},
      );
      return;
    }

    if (awaiting === 'tg_2fa') {
      const user = await mutateDb((d) =>
        findOrCreateTelegramUser(d, tgId, ctx.from?.username, ctx.from?.first_name),
      );
      const outcome = await verifyUserbotAuthPassword(user.id, text);
      if (!outcome.ok) {
        await ctx.reply(`⚠️ ${escapeHtml(outcome.error)}`);
        return;
      }
      await mutateDb((d) => {
        d.botState[tgId] = {awaiting: null};
      });
      await ctx.reply(
        `✅ <b>Аккаунт Telegram успешно подключён!</b>\n` +
          `Сессия сохранена и синхронизирована с веб-аппом.`,
        {reply_markup: mainMenuKb(tgId, supportUrl)},
      );
      return;
    }

    // 3. Owner-only Admin Wizards
    if (!isBotOwner(tgId)) return;

    if (awaiting === 'promo_code') {
      const code = text.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      if (code.length < 3 || code.length > 32) {
        await ctx.reply('⚠️ Код должен быть 3–32 символа (латиница, цифры, _ или -):');
        return;
      }
      await mutateDb((d) => {
        d.botState[tgId] = {
          awaiting: 'promo_type_wait',
          promoCode: code,
        };
      });
      const kb = new InlineKeyboard()
        .text('🎁 Бонус запросов', 'adm:promo_type:requests')
        .row()
        .text('⭐ Подписка Pro', 'adm:promo_type:pro')
        .text('👑 Подписка Max', 'adm:promo_type:max')
        .row()
        .text('⬅️ Отмена', 'adm:promos');
      await ctx.reply(
        `⌘ <b>Шаг 2/4</b> — Код <code>${escapeHtml(code)}</code>\nВыберите тип промокода:`,
        {reply_markup: kb},
      );
      return;
    }

    if (awaiting === 'promo_value') {
      const val = Math.trunc(Number(text));
      if (!Number.isFinite(val) || val < 1 || val > 3650) {
        await ctx.reply('⚠️ Введите целое число от 1 до 3650:');
        return;
      }
      await mutateDb((d) => {
        d.botState[tgId] = {
          ...(d.botState[tgId] || {}),
          awaiting: 'promo_max_uses',
          promoValue: val,
        };
      });
      await ctx.reply('⌘ <b>Шаг 4/4</b>\nСколько максимум активаций разрешить (число, например 50)?');
      return;
    }

    if (awaiting === 'promo_max_uses') {
      const maxUses = Math.trunc(Number(text));
      if (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 100000) {
        await ctx.reply('⚠️ Введите целое число от 1 до 100000:');
        return;
      }

      const created = await mutateDb((d) => {
        const st = d.botState[tgId] || {};
        const code = String(st.promoCode || '').toUpperCase();
        const type = st.promoType === 'subscription' ? 'subscription' : 'requests';
        const plan = st.promoPlan === 'pro' ? 'pro' : 'max';
        const value = Math.max(1, Number(st.promoValue) || 1);

        const record: PromoCodeRecord = {
          code,
          type,
          value,
          plan,
          maxUses,
          usedBy: [],
          active: true,
          createdAt: new Date().toISOString(),
        };
        d.promoCodes[code] = record;
        d.botState[tgId] = {awaiting: null};
        return record;
      });

      const kb = new InlineKeyboard()
        .copyText(`📋 Скопировать ${created.code}`, created.code)
        .row()
        .text('⌘ Все промокоды', 'adm:promos')
        .text('⬅️ В админку', 'adm:panel');

      await ctx.reply(
        `✅ <b>Промокод <code>${escapeHtml(created.code)}</code> создан!</b>\n` +
          `• Тип: ${
            created.type === 'requests'
              ? `+${created.value} запросов`
              : `${created.plan.toUpperCase()} на ${created.value} дн.`
          }\n` +
          `• Лимит использований: <b>${created.maxUses}</b>`,
        {reply_markup: kb},
      );
      return;
    }

    if (awaiting === 'broadcast_text') {
      const draft = text.slice(0, 4000);
      const tgUsersCount = Object.values(db.users).filter(
        (u) => !u.blocked && u.telegramId && /^\d+$/.test(u.telegramId),
      ).length;

      await mutateDb((d) => {
        d.botState[tgId] = {
          awaiting: null,
          broadcastDraft: draft,
        };
      });

      const kb = new InlineKeyboard()
        .text(`✅ Отправить всем (${tgUsersCount})`, 'adm:broadcast_send')
        .row()
        .text('❌ Отмена', 'adm:panel');

      await ctx.reply(
        `📢 <b>Предпросмотр рассылки</b>\n\n` +
          `${escapeHtml(draft)}\n\n` +
          `Получателей: <b>${tgUsersCount}</b>. Отправляем?`,
        {reply_markup: kb, link_preview_options: {is_disabled: true}},
      );
      return;
    }

    if (awaiting === 'adm_edit') {
      const field = String(state.editField || '');
      const numericFields = new Set([
        'proPriceUsd',
        'proPriceStars',
        'maxPriceUsd',
        'maxPriceStars',
        'freeDailyLimit',
        'proDailyLimit',
        'maxDailyLimit',
      ]);
      const textFields = new Set([
        'visaCardDetails',
        'tonWalletAddress',
        'gramWalletAddress',
        'supportContact',
      ]);

      if (numericFields.has(field)) {
        const parsed = Number(text.replace(',', '.'));
        if (!Number.isFinite(parsed) || parsed < 1) {
          await ctx.reply('⚠️ Введите корректное число больше 0:');
          return;
        }
        const val = field.endsWith('Usd')
          ? Math.min(10000, Math.round(parsed * 100) / 100)
          : Math.min(1000000, Math.trunc(parsed));

        await mutateDb((d) => {
          (d.settings as unknown as Record<string, unknown>)[field] = val;
          d.botState[tgId] = {awaiting: null};
        });
      } else if (textFields.has(field)) {
        const cleaned = text.slice(0, 300);
        await mutateDb((d) => {
          (d.settings as unknown as Record<string, unknown>)[field] = cleaned;
          d.botState[tgId] = {awaiting: null};
        });
      } else {
        await mutateDb((d) => {
          d.botState[tgId] = {awaiting: null};
        });
        return;
      }

      const summary = await buildAdminPanelSummaryText();
      await ctx.reply(`✅ Сохранено!\n\n${summary.text}`, {
        reply_markup: adminPanelKb(summary.pendingCount),
        link_preview_options: {is_disabled: true},
      });
    }
  });

  // Telegram Stars Pre-Checkout Query
  bot.on('pre_checkout_query', async (ctx) => {
    const query = ctx.preCheckoutQuery;
    const payload = query.invoice_payload || '';
    const db = await readDb();

    if (payload.startsWith('web_order:')) {
      const orderId = payload.slice('web_order:'.length);
      const order = db.starOrders[orderId];
      if (!order) {
        await ctx.answerPreCheckoutQuery(false, {
          error_message: 'Заказ не найден. Создайте новый счёт в веб-аппе.',
        });
        return;
      }
      if (order.status === 'paid') {
        await ctx.answerPreCheckoutQuery(false, {
          error_message: 'Этот заказ уже оплачен.',
        });
        return;
      }
      if (query.total_amount !== order.starsAmount || query.currency !== 'XTR') {
        await ctx.answerPreCheckoutQuery(false, {
          error_message: 'Сумма счёта не совпадает.',
        });
        return;
      }
      await ctx.answerPreCheckoutQuery(true);
      return;
    }

    if (payload.startsWith('tg_plan:')) {
      const [, planIdRaw] = payload.split(':');
      const plans = getPlans(db.settings);
      const plan = plans.find((p) => p.id === planIdRaw);
      if (!plan || plan.priceStars <= 0 || query.total_amount !== plan.priceStars) {
        await ctx.answerPreCheckoutQuery(false, {
          error_message: 'Выбранный тариф недоступен.',
        });
        return;
      }
      await ctx.answerPreCheckoutQuery(true);
      return;
    }

    await ctx.answerPreCheckoutQuery(false, {
      error_message: 'Некорректные данные платежа.',
    });
  });

  // Telegram Stars Successful Payment Confirmation (with strict idempotency)
  bot.on('message:successful_payment', async (ctx) => {
    const sp = ctx.message.successful_payment;
    const tgId = String(ctx.from?.id || '');
    const payload = sp.invoice_payload || '';
    const chargeId = sp.telegram_payment_charge_id;

    const outcome = await mutateDb((db) => {
      const alreadyLogged = db.paymentApps.find((p) => p.telegramChargeId === chargeId);
      if (alreadyLogged) {
        return {
          alreadyProcessed: true as const,
          planId: alreadyLogged.planId,
          username: alreadyLogged.username,
          supportUrl: db.settings.supportContact,
        };
      }

      const nowIso = new Date().toISOString();

      if (payload.startsWith('web_order:')) {
        const orderId = payload.slice('web_order:'.length);
        const order = db.starOrders[orderId];
        if (!order) {
          return {error: 'Заказ не найден в базе'};
        }
        if (order.status === 'paid') {
          return {
            alreadyProcessed: true as const,
            planId: order.planId,
            username: order.username,
            supportUrl: db.settings.supportContact,
          };
        }

        order.status = 'paid';
        order.telegramUserId = tgId;
        order.telegramChargeId = chargeId;
        order.paidAt = nowIso;

        const webUser = db.users[order.userId];
        if (webUser) {
          activateSubscriptionDays(webUser, order.planId, 30);
          if (!webUser.telegramId) {
            webUser.telegramId = tgId;
            webUser.telegramUsername = ctx.from?.username || webUser.telegramUsername || null;
          }
        }

        db.paymentApps.unshift({
          id: `pay_${crypto.randomBytes(6).toString('hex')}`,
          userId: order.userId,
          username: order.username,
          planId: order.planId,
          method: 'stars',
          amountLabel: `${sp.total_amount} ⭐`,
          comment: `Web Stars Order ${order.id}`,
          receiptDataUrl: null,
          receiptName: null,
          telegramUserId: tgId,
          telegramChargeId: chargeId,
          status: 'approved',
          adminNote: 'Автоматическое подтверждение Telegram Stars',
          createdAt: nowIso,
          reviewedAt: nowIso,
          reviewedBy: 'telegram_stars',
        });

        return {
          alreadyProcessed: false as const,
          planId: order.planId,
          username: order.username,
          stars: sp.total_amount,
          supportUrl: db.settings.supportContact,
        };
      }

      const [, planIdRaw] = payload.split(':');
      const planId: 'pro' | 'max' = planIdRaw === 'max' ? 'max' : 'pro';
      const user = findOrCreateTelegramUser(db, tgId, ctx.from?.username, ctx.from?.first_name);
      activateSubscriptionDays(user, planId, 30);

      db.paymentApps.unshift({
        id: `pay_${crypto.randomBytes(6).toString('hex')}`,
        userId: user.id,
        username: user.username,
        planId,
        method: 'stars',
        amountLabel: `${sp.total_amount} ⭐`,
        comment: 'Оплата Telegram Stars',
        receiptDataUrl: null,
        receiptName: null,
        telegramUserId: tgId,
        telegramChargeId: chargeId,
        status: 'approved',
        adminNote: 'Автоматическое подтверждение Telegram Stars',
        createdAt: nowIso,
        reviewedAt: nowIso,
        reviewedBy: 'telegram_stars',
      });

      return {
        alreadyProcessed: false as const,
        planId,
        username: user.username,
        stars: sp.total_amount,
        supportUrl: db.settings.supportContact,
      };
    });

    if ('error' in outcome) {
      await ctx.reply(`⚠️ Платёж получен, но возникла ошибка: ${outcome.error}`);
      return;
    }

    await ctx.reply(
      `✅ <b>Оплата Telegram Stars подтверждена!</b>\n\n` +
        `Аккаунт: <b>${escapeHtml(outcome.username)}</b>\n` +
        `Тариф: <b>${outcome.planId.toUpperCase()}</b> активирован на 30 дней.\n` +
        `ID транзакции: <code>${escapeHtml(chargeId)}</code>`,
      {reply_markup: mainMenuKb(tgId, outcome.supportUrl)},
    );

    if (!outcome.alreadyProcessed) {
      await notifyOwnersAboutStarsSuccess(
        outcome.username,
        outcome.planId,
        outcome.stars,
        chargeId,
      );
    }
  });
}

export async function startTelegramBot(app?: express.Express): Promise<BotRuntimeStatus> {
  const token = resolveBotToken();
  if (!token) {
    status.running = false;
    status.mode = 'idle';
    status.lastError = null;
    console.log('[ClientFy Bot] TELEGRAM_BOT_TOKEN не задан — бот в режиме ожидания');
    return getBotStatus();
  }

  try {
    const bot = new Bot(token);
    bot.api.config.use(autoRetry());
    bot.api.config.use((prev, method, payload, signal) => {
      const htmlMethods = new Set([
        'sendMessage',
        'sendPhoto',
        'sendVideo',
        'sendAnimation',
        'sendDocument',
        'editMessageText',
        'editMessageCaption',
      ]);
      if (htmlMethods.has(method) && payload && !('parse_mode' in payload)) {
        return prev(method, {...payload, parse_mode: 'HTML'} as typeof payload, signal);
      }
      return prev(method, payload, signal);
    });
    configureBotHandlers(bot);

    const me = await bot.api.getMe();
    botInstance = bot;
    status.username = me.username ?? status.username;
    status.lastError = null;

    if (process.env.SKIP_BOT_POLLING === 'true') {
      status.mode = 'idle';
      status.running = false;
      console.log(`[ClientFy Bot] @${me.username} API инициализирован (SKIP_BOT_POLLING=true)`);
      return getBotStatus();
    }

    const mode = process.env.BOT_MODE?.trim().toLowerCase() === 'webhook' ? 'webhook' : 'polling';
    status.mode = mode;

    if (mode === 'webhook' && app) {
      app.post('/api/telegram/webhook', webhookCallback(bot, 'express'));
      const appUrl = getWebAppUrl();
      const webhookUrl = `${appUrl.replace(/\/$/, '')}/api/telegram/webhook`;
      await bot.api.setWebhook(webhookUrl);
      status.running = true;
      console.log(`[ClientFy Bot] @${me.username} запущен (webhook)`);
    } else {
      await bot.api.deleteWebhook({drop_pending_updates: false}).catch(() => {});
      runnerHandle = run(bot);
      status.running = true;
      console.log(`[ClientFy Bot] @${me.username} запущен (long polling)`);
    }
  } catch (err) {
    status.running = false;
    status.mode = 'idle';
    status.lastError = err instanceof Error ? err.message : String(err);
    console.error('[ClientFy Bot] Не удалось запустить бота:', status.lastError);
  }

  return getBotStatus();
}

export async function stopTelegramBot(): Promise<void> {
  if (runnerHandle && runnerHandle.isRunning()) {
    await runnerHandle.stop();
  }
}
