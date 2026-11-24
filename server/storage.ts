import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {DateTime} from 'luxon';
import {isBotOwner, resolveSafePath} from './security.ts';
import type {
  AppSettings,
  OutreachContact,
  OutreachTemplate,
  PaymentApplication,
  PlanDefinition,
  PlanId,
  PromoCodeRecord,
  PublicUserProfile,
  QuotaSummary,
  RuntimeDatabase,
  SearchFilters,
  SearchHistoryEntry,
  SentOutreachLog,
  StarOrder,
  UserAutosendData,
  UserRecord,
  YouTubeChannelResult,
} from './types.ts';

const ROOT_DIR = process.cwd();
const DATA_DIR = path.resolve(ROOT_DIR, 'data');
const RUNTIME_FILE = path.resolve(DATA_DIR, 'runtime.json');
const AUTOSEND_DIR = path.resolve(ROOT_DIR, 'autosend');

const PT_ZONE = 'America/Los_Angeles';

class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = this.chain;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

const dbMutex = new AsyncMutex();
const autosendMutex = new AsyncMutex();

export function getPtDateInfo(): {
  ptDate: string;
  resetAtIso: string;
  secondsUntilReset: number;
} {
  const nowPt = DateTime.now().setZone(PT_ZONE);
  const nextMidnightPt = nowPt.plus({days: 1}).startOf('day');
  return {
    ptDate: nowPt.toISODate() || '1970-01-01',
    resetAtIso: nextMidnightPt.toISO() || new Date().toISOString(),
    secondsUntilReset: Math.max(0, Math.floor(nextMidnightPt.diff(nowPt, 'seconds').seconds)),
  };
}

export function getPlans(settings: AppSettings): PlanDefinition[] {
  return [
    {
      id: 'free',
      name: 'Free',
      audience: 'Для знакомства и первых подборок',
      priceUsd: 0,
      priceStars: 0,
      dailyLimit: settings.freeDailyLimit,
      durationDays: 0,
      maxResultsPerSearch: 15,
      outreachEnabled: false,
      exportEnabled: true,
      highlights: [
        `${settings.freeDailyLimit} каналов в день (сброс в полночь PT)`,
        'Фильтры по периоду, подписчикам и языку',
        'Поиск ссылок в описании канала и последних 3 видео',
        'История поисков и экспорт CSV',
      ],
    },
    {
      id: 'pro',
      name: 'Pro',
      audience: 'Для регулярного поиска клиентов и лидгена',
      priceUsd: settings.proPriceUsd,
      priceStars: settings.proPriceStars,
      dailyLimit: settings.proDailyLimit,
      durationDays: 30,
      maxResultsPerSearch: 50,
      outreachEnabled: false,
      exportEnabled: true,
      highlights: [
        `${settings.proDailyLimit} каналов в день на 30 дней`,
        'Выборка до 50 каналов за один поиск',
        'Фильтрация без Shorts и по источникам ссылок',
        'Мгновенная оплата через Telegram Stars',
      ],
    },
    {
      id: 'max',
      name: 'Max',
      audience: 'Для агентств и массового аутрича',
      priceUsd: settings.maxPriceUsd,
      priceStars: settings.maxPriceStars,
      dailyLimit: settings.maxDailyLimit,
      durationDays: 30,
      maxResultsPerSearch: 50,
      outreachEnabled: true,
      exportEnabled: true,
      highlights: [
        `${settings.maxDailyLimit} каналов в день на 30 дней`,
        'Авторассылка и сбор Telegram-личек по темам',
        'Персонализированные шаблоны сообщений ({title}, {url})',
        'Мгновенная оплата Stars и приоритетный доступ',
      ],
    },
  ];
}

function createDefaultDatabase(): RuntimeDatabase {
  return {
    version: 3,
    settings: {
      freeDailyLimit: Number(process.env.FREE_LIMIT || 15) || 15,
      proDailyLimit: Number(process.env.PRO_LIMIT || 50) || 50,
      maxDailyLimit: Number(process.env.MAX_LIMIT || 100) || 100,
      proPriceUsd: Number(process.env.PRO_PRICE_USD || 3) || 3,
      proPriceStars: Number(process.env.PRO_PRICE_STARS || 150) || 150,
      maxPriceUsd: Number(process.env.MAX_PRICE_USD || 6) || 6,
      maxPriceStars: Number(process.env.MAX_PRICE_STARS || 300) || 300,
      visaCardDetails:
        process.env.VISA_CARD_DETAILS?.trim() ||
        'Укажите реквизиты карты в настройках администратора',
      tonWalletAddress:
        process.env.TON_WALLET_ADDRESS?.trim() ||
        process.env.TON_WALLET?.trim() ||
        'UQAdj3eGW_V924Ch3pxMGSYNf_TgoyCtkZl-FmtrB4hSK0Bf',
      gramWalletAddress:
        process.env.GRAM_WALLET_ADDRESS?.trim() ||
        process.env.GRAM_WALLET?.trim() ||
        'UQAdj3eGW_V924Ch3pxMGSYNf_TgoyCtkZl-FmtrB4hSK0Bf',
      supportContact: process.env.SUPPORT_URL || 'https://t.me/ClienFy_Support',
      channelUrl: process.env.TELEGRAM_CHANNEL_URL || 'https://t.me/Client_Fy',
    },
    authBootstrap: {
      claimedAdminHash: null,
      claimedAt: null,
    },
    users: {},
    usage: {},
    searchHistory: [],
    paymentApps: [],
    promoCodes: {},
    starOrders: {},
    telegramLinks: {},
    botState: {},
  };
}

function normalizePlanId(raw: unknown): PlanId {
  if (raw === 'pro') return 'pro';
  if (raw === 'max' || raw === 'business') return 'max';
  return 'free';
}

function ensureDatabaseDefaults(raw: Partial<RuntimeDatabase> | null): RuntimeDatabase {
  const defaults = createDefaultDatabase();
  const db: RuntimeDatabase = {
    version: typeof raw?.version === 'number' ? raw.version : defaults.version,
    settings: {
      ...defaults.settings,
      ...(raw?.settings ?? {}),
    },
    authBootstrap: {
      ...defaults.authBootstrap,
      ...(raw?.authBootstrap ?? {}),
    },
    users: raw?.users && typeof raw.users === 'object' ? raw.users : {},
    usage: raw?.usage && typeof raw.usage === 'object' ? raw.usage : {},
    searchHistory: Array.isArray(raw?.searchHistory) ? raw.searchHistory : [],
    paymentApps: Array.isArray(raw?.paymentApps) ? raw.paymentApps : [],
    promoCodes: raw?.promoCodes && typeof raw.promoCodes === 'object' ? raw.promoCodes : {},
    starOrders: raw?.starOrders && typeof raw.starOrders === 'object' ? raw.starOrders : {},
    telegramLinks:
      raw?.telegramLinks && typeof raw.telegramLinks === 'object' ? raw.telegramLinks : {},
    botState: raw?.botState && typeof raw.botState === 'object' ? raw.botState : {},
  };

  if (
    db.settings.tonWalletAddress === 'Укажите USDT TON-адрес в настройках администратора' ||
    !db.settings.tonWalletAddress.trim()
  ) {
    db.settings.tonWalletAddress = defaults.settings.tonWalletAddress;
  }
  if (
    db.settings.gramWalletAddress === 'Укажите GRAM-адрес в настройках администратора' ||
    !db.settings.gramWalletAddress.trim()
  ) {
    db.settings.gramWalletAddress = defaults.settings.gramWalletAddress;
  }

  if (
    !db.settings.supportContact.trim() ||
    db.settings.supportContact === 'https://t.me/tapaem_durova'
  ) {
    db.settings.supportContact = defaults.settings.supportContact;
  }

  for (const user of Object.values(db.users)) {
    user.planId = normalizePlanId(user.planId);
  }
  for (const p of Object.values(db.promoCodes)) {
    if (!p.plan) p.plan = 'max';
  }
  return db;
}

async function ensureDirectories(): Promise<void> {
  await fs.mkdir(DATA_DIR, {recursive: true});
  await fs.mkdir(AUTOSEND_DIR, {recursive: true});
}

async function readDbUnsafe(): Promise<RuntimeDatabase> {
  await ensureDirectories();
  try {
    const text = await fs.readFile(RUNTIME_FILE, 'utf8');
    const parsed = JSON.parse(text) as Partial<RuntimeDatabase>;
    return ensureDatabaseDefaults(parsed);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      const initial = createDefaultDatabase();
      await writeDbUnsafe(initial);
      return initial;
    }
    throw err;
  }
}

async function writeDbUnsafe(db: RuntimeDatabase): Promise<void> {
  await ensureDirectories();
  const tmpFile = `${RUNTIME_FILE}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(db, null, 2), 'utf8');
  await fs.rename(tmpFile, RUNTIME_FILE);
}

export async function readDb(): Promise<RuntimeDatabase> {
  return dbMutex.run(() => readDbUnsafe());
}

export async function mutateDb<T>(mutator: (db: RuntimeDatabase) => T | Promise<T>): Promise<T> {
  return dbMutex.run(async () => {
    const db = await readDbUnsafe();
    const result = await mutator(db);
    await writeDbUnsafe(db);
    return result;
  });
}

export function resolveEffectivePlan(user: UserRecord): {
  planId: PlanId;
  subscriptionActive: boolean;
} {
  const normalized = normalizePlanId(user.planId);
  if (normalized === 'free') {
    return {planId: 'free', subscriptionActive: false};
  }
  if (!user.subscriptionUntil) {
    return {planId: normalized, subscriptionActive: true};
  }
  const expires = DateTime.fromISO(user.subscriptionUntil);
  if (expires.isValid && expires > DateTime.now()) {
    return {planId: normalized, subscriptionActive: true};
  }
  return {planId: 'free', subscriptionActive: false};
}

export function computeQuotaSummary(db: RuntimeDatabase, user: UserRecord): QuotaSummary {
  const {ptDate, resetAtIso, secondsUntilReset} = getPtDateInfo();
  const {planId, subscriptionActive} = resolveEffectivePlan(user);
  const plans = getPlans(db.settings);
  const plan = plans.find((p) => p.id === planId) || plans[0];
  const usedToday = db.usage[user.id]?.[ptDate] ?? 0;
  const remainingDaily = Math.max(0, plan.dailyLimit - usedToday);
  const bonusRequests = Math.max(0, user.bonusRequests || 0);

  return {
    ptDate,
    resetAtIso,
    secondsUntilReset,
    planId,
    planName: plan.name,
    subscriptionUntil: user.subscriptionUntil,
    subscriptionActive,
    dailyLimit: plan.dailyLimit,
    usedToday,
    remainingDaily,
    bonusRequests,
    totalAvailable: remainingDaily + bonusRequests,
  };
}

export function toPublicProfile(db: RuntimeDatabase, user: UserRecord): PublicUserProfile {
  const isOwner = isBotOwner(user.telegramId);
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: isOwner ? 'admin' : 'user',
    blocked: user.blocked,
    planId: normalizePlanId(user.planId),
    subscriptionUntil: user.subscriptionUntil,
    bonusRequests: user.bonusRequests,
    telegramId: user.telegramId ?? null,
    telegramUsername: user.telegramUsername ?? null,
    outreachTelegramConnected: Boolean(user.telegramSession?.encryptedSession),
    isOwner,
    createdAt: user.createdAt,
    lastActiveAt: user.lastActiveAt,
    quota: computeQuotaSummary(db, user),
  };
}

export function findOrCreateTelegramUser(
  db: RuntimeDatabase,
  tgUserId: string,
  tgUsername?: string,
  tgFirstName?: string,
): UserRecord {
  const cleanUsername = tgUsername?.trim().replace(/^@/, '') || '';
  const displayName = tgFirstName?.trim() || (cleanUsername ? `@${cleanUsername}` : `tg_${tgUserId}`);

  const linked = Object.values(db.users).find((u) => u.telegramId === tgUserId);
  if (linked) {
    if (cleanUsername) {
      linked.telegramUsername = cleanUsername;
    }
    if (linked.id.startsWith('tg_') && displayName) {
      linked.username = displayName;
    }
    linked.lastActiveAt = new Date().toISOString();
    return linked;
  }

  const syntheticId = `tg_${tgUserId}`;
  const existing = db.users[syntheticId];
  if (existing) {
    existing.telegramId = tgUserId;
    if (cleanUsername) existing.telegramUsername = cleanUsername;
    if (displayName) existing.username = displayName;
    existing.lastActiveAt = new Date().toISOString();
    return existing;
  }

  const nowIso = new Date().toISOString();
  const created: UserRecord = {
    id: syntheticId,
    username: displayName,
    email: `${syntheticId}@telegram.clientfy`,
    passwordHash: '',
    role: 'user',
    blocked: false,
    planId: 'free',
    subscriptionUntil: null,
    bonusRequests: 0,
    telegramId: tgUserId,
    telegramUsername: tgUsername || null,
    createdAt: nowIso,
    lastActiveAt: nowIso,
  };
  db.users[syntheticId] = created;
  return created;
}

export function activateSubscriptionDays(
  user: UserRecord,
  planId: 'pro' | 'max',
  days = 30,
): void {
  const base =
    user.subscriptionUntil && DateTime.fromISO(user.subscriptionUntil) > DateTime.now()
      ? DateTime.fromISO(user.subscriptionUntil)
      : DateTime.now();
  user.planId = planId;
  user.subscriptionUntil = base.plus({days: Math.max(1, days)}).toISO();
  user.lastActiveAt = new Date().toISOString();
}

export function consumeChannelQuota(
  db: RuntimeDatabase,
  user: UserRecord,
  channelCount: number,
): {ok: boolean; quota: QuotaSummary} {
  const quota = computeQuotaSummary(db, user);
  const cost = Math.max(0, Math.trunc(channelCount));
  if (cost === 0) {
    user.lastActiveAt = new Date().toISOString();
    return {ok: true, quota};
  }
  if (quota.totalAvailable <= 0) {
    return {ok: false, quota};
  }

  const fromDaily = Math.min(quota.remainingDaily, cost);
  const fromBonus = Math.min(user.bonusRequests || 0, cost - fromDaily);

  if (fromDaily > 0) {
    if (!db.usage[user.id]) {
      db.usage[user.id] = {};
    }
    db.usage[user.id][quota.ptDate] = (db.usage[user.id][quota.ptDate] ?? 0) + fromDaily;
  }
  if (fromBonus > 0) {
    user.bonusRequests = Math.max(0, (user.bonusRequests || 0) - fromBonus);
  }

  user.lastActiveAt = new Date().toISOString();
  return {ok: true, quota: computeQuotaSummary(db, user)};
}

export function recordSearchHistory(
  db: RuntimeDatabase,
  userId: string,
  filters: SearchFilters,
  results: YouTubeChannelResult[],
): SearchHistoryEntry {
  const {ptDate} = getPtDateInfo();
  const inDescription = results.filter((c) => c.linkInChannelDescription).length;
  const onlyInVideos = results.filter(
    (c) => c.linkInRecentVideos && !c.linkInChannelDescription,
  ).length;
  const noLinks = results.filter(
    (c) => !c.linkInChannelDescription && !c.linkInRecentVideos,
  ).length;

  const entry: SearchHistoryEntry = {
    id: `hist_${crypto.randomBytes(6).toString('hex')}`,
    userId,
    ptDate,
    createdAt: new Date().toISOString(),
    filters,
    totalFound: results.length,
    stats: {inDescription, onlyInVideos, noLinks},
    results,
  };
  db.searchHistory.unshift(entry);
  if (db.searchHistory.length > 500) {
    db.searchHistory = db.searchHistory.slice(0, 500);
  }
  return entry;
}

export function createUserAutosendDefaults(): UserAutosendData {
  return {
    contacts: [],
    templates: [
      {
        id: 'tpl_default_collab',
        name: 'Стандартное предложение ClientFy',
        body: 'Здравствуйте! Увидел ваш канал «{title}» ({url}) — хотел предложить сотрудничество.',
        updatedAt: new Date().toISOString(),
      },
    ],
    campaign: {
      running: false,
      stopRequested: false,
      templateId: 'tpl_default_collab',
      topics: [],
      delaySecondsMin: 20,
      delaySecondsMax: 30,
      sentCount: 0,
      failedCount: 0,
      lastMessage: 'Кампания готова к запуску',
      startedAt: null,
      finishedAt: null,
    },
  };
}

function getTargetsPath(userId: string): string {
  const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return resolveSafePath(AUTOSEND_DIR, `targets_${safeId}.json`);
}

function getSentPath(userId: string): string {
  const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return resolveSafePath(AUTOSEND_DIR, `sent_${safeId}.json`);
}

export async function readUserAutosend(userId: string): Promise<{
  data: UserAutosendData;
  sentLogs: SentOutreachLog[];
}> {
  return autosendMutex.run(async () => {
    await ensureDirectories();
    const targetsPath = getTargetsPath(userId);
    const sentPath = getSentPath(userId);

    let data: UserAutosendData;
    try {
      const raw = await fs.readFile(targetsPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<UserAutosendData>;
      const defaults = createUserAutosendDefaults();
      data = {
        contacts: Array.isArray(parsed.contacts) ? parsed.contacts : defaults.contacts,
        templates:
          Array.isArray(parsed.templates) && parsed.templates.length > 0
            ? parsed.templates
            : defaults.templates,
        campaign: {
          ...defaults.campaign,
          ...(parsed.campaign ?? {}),
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        data = createUserAutosendDefaults();
        await fs.writeFile(targetsPath, JSON.stringify(data, null, 2), 'utf8');
      } else {
        throw err;
      }
    }

    let sentLogs: SentOutreachLog[] = [];
    try {
      const rawSent = await fs.readFile(sentPath, 'utf8');
      const parsedSent = JSON.parse(rawSent);
      if (Array.isArray(parsedSent)) {
        sentLogs = parsedSent;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw err;
      }
    }

    return {data, sentLogs};
  });
}

export async function mutateUserAutosend<T>(
  userId: string,
  mutator: (
    data: UserAutosendData,
    sentLogs: SentOutreachLog[],
  ) =>
    | {result: T; nextSentLogs?: SentOutreachLog[]}
    | Promise<{result: T; nextSentLogs?: SentOutreachLog[]}>,
): Promise<T> {
  return autosendMutex.run(async () => {
    await ensureDirectories();
    const targetsPath = getTargetsPath(userId);
    const sentPath = getSentPath(userId);

    let data: UserAutosendData;
    try {
      const raw = await fs.readFile(targetsPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<UserAutosendData>;
      const defaults = createUserAutosendDefaults();
      data = {
        contacts: Array.isArray(parsed.contacts) ? parsed.contacts : defaults.contacts,
        templates:
          Array.isArray(parsed.templates) && parsed.templates.length > 0
            ? parsed.templates
            : defaults.templates,
        campaign: {
          ...defaults.campaign,
          ...(parsed.campaign ?? {}),
        },
      };
    } catch {
      data = createUserAutosendDefaults();
    }

    let sentLogs: SentOutreachLog[] = [];
    try {
      const rawSent = await fs.readFile(sentPath, 'utf8');
      const parsedSent = JSON.parse(rawSent);
      if (Array.isArray(parsedSent)) {
        sentLogs = parsedSent;
      }
    } catch {
      sentLogs = [];
    }

    const {result, nextSentLogs} = await mutator(data, sentLogs);

    const tmpTargets = `${targetsPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmpTargets, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmpTargets, targetsPath);

    if (nextSentLogs) {
      const tmpSent = `${sentPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(tmpSent, JSON.stringify(nextSentLogs.slice(0, 500), null, 2), 'utf8');
      await fs.rename(tmpSent, sentPath);
    }

    return result;
  });
}

export type {
  OutreachContact,
  OutreachTemplate,
  PaymentApplication,
  PromoCodeRecord,
  StarOrder,
};
