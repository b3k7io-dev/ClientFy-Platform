import crypto from 'node:crypto';
import express, {type NextFunction, type Request, type Response} from 'express';
import {DateTime} from 'luxon';
import {
  createSessionToken,
  hashPassword,
  sanitizeHttpUrl,
  timingSafeStringMatch,
  verifyPassword,
  verifySessionToken,
  verifyTelegramWebAppInitData,
} from './security.ts';
import {
  computeQuotaSummary,
  consumeChannelQuota,
  findOrCreateTelegramUser,
  getPlans,
  mutateDb,
  mutateUserAutosend,
  readDb,
  readUserAutosend,
  recordSearchHistory,
  toPublicProfile,
  type OutreachContact,
  type OutreachTemplate,
  type PromoCodeRecord,
} from './storage.ts';
import type {
  PromoType,
  SearchFilters,
  SentOutreachLog,
  StarOrder,
  UserRecord,
  YouTubeChannelResult,
} from './types.ts';
import {
  broadcastToAllTelegramUsers,
  createStarsInvoiceLink,
  getBotStatus,
  isBotOwner,
  notifyTelegramUserPaymentResult,
  resolveBotToken,
} from './telegramBot.ts';
import {buildCleanSourceTarGz} from './sourceArchive.ts';
import {
  disconnectUserbot,
  getUserbotStatus,
  isMtprotoConfigured,
  sendUserbotAuthCode,
  startMtprotoLoginChallenge,
  startRealOutreachCampaign,
  stopRealOutreachCampaign,
  verifyMtprotoLoginCode,
  verifyMtprotoLoginPassword,
  verifyUserbotAuthCode,
  verifyUserbotAuthPassword,
  type MtprotoLoginProfile,
} from './userbot.ts';
import {
  extractPersonalTgHandles,
  isYoutubeConfigured,
  searchYouTubeChannels,
  YouTubeApiError,
  YouTubeConfigError,
} from './youtube.ts';

interface AuthedRequest extends Request {
  authUser?: {
    userId: string;
    role: 'user' | 'admin';
    telegramId: string | null;
    isOwner: boolean;
  };
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function createRateLimiter(options: {windowMs: number; max: number; label: string}) {
  const buckets = new Map<string, {count: number; resetAt: number}>();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets.entries()) {
      if (entry.resetAt <= now) buckets.delete(key);
    }
  }, options.windowMs).unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = getClientIp(req);
    const now = Date.now();
    const existing = buckets.get(ip);
    if (!existing || existing.resetAt <= now) {
      buckets.set(ip, {count: 1, resetAt: now + options.windowMs});
      next();
      return;
    }
    if (existing.count >= options.max) {
      const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: `Слишком много запросов (${options.label}). Повторите через ${retryAfterSec} сек.`,
      });
      return;
    }
    existing.count += 1;
    next();
  };
}

function getEnvAdminPassword(): string {
  return process.env.ADMIN_PASSWORD?.trim() || '';
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token || null;
}

async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const token = extractBearer(req);
  if (!token) {
    res.status(401).json({error: 'Требуется авторизация'});
    return;
  }
  const payload = verifySessionToken(token);
  if (!payload) {
    res.status(401).json({error: 'Сессия истекла или недействительна'});
    return;
  }

  const db = await readDb();
  const user = db.users[payload.userId];
  if (!user) {
    res.status(401).json({error: 'Пользователь не найден'});
    return;
  }
  if (user.blocked) {
    res.status(403).json({error: 'Аккаунт заблокирован администратором'});
    return;
  }

  const isOwner = isBotOwner(user.telegramId);
  req.authUser = {
    userId: user.id,
    role: isOwner ? 'admin' : 'user',
    telegramId: user.telegramId ?? null,
    isOwner,
  };
  next();
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.authUser?.isOwner) {
    res.status(403).json({error: 'Доступ к админ-панели разрешён только владельцу (OWNER_ID)'});
    return;
  }
  next();
}

function formatSubsShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function createApiRouter(): express.Router {
  const router = express.Router();

  const generalLimiter = createRateLimiter({windowMs: 60_000, max: 180, label: 'API'});
  const authLimiter = createRateLimiter({windowMs: 60_000, max: 30, label: 'Auth'});

  // Structured API request logger (never logs tokens or secrets)
  router.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      if (req.path === '/health') return;
      const ms = Date.now() - start;
      console.log(`[API] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
    });
    next();
  });

  // Health Check
  router.get('/health', async (_req: Request, res: Response) => {
    let dbReady = true;
    try {
      await readDb();
    } catch {
      dbReady = false;
    }
    res.json({
      ok: dbReady,
      service: 'clientfy',
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      dbReady,
      youtubeConfigured: isYoutubeConfigured(),
      mtprotoConfigured: isMtprotoConfigured(),
      bot: getBotStatus(),
    });
  });

  // Clean Source Code Archive Download (excludes .env*, data/, autosend/, node_modules/, dist/)
  router.get('/download/source', generalLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const archiveBuffer = await buildCleanSourceTarGz();
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', 'attachment; filename="clientfy-source.tar.gz"');
      res.setHeader('Cache-Control', 'no-store');
      res.send(archiveBuffer);
    } catch (err) {
      next(err);
    }
  });

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/telegram/webhook') {
      next();
      return;
    }
    generalLimiter(req, res, next);
  });
  router.use('/auth', authLimiter);

  // Auth Status
  router.get('/auth/status', async (req: AuthedRequest, res: Response) => {
    const db = await readDb();
    const envAdminPwd = getEnvAdminPassword();
    const adminConfigured = Boolean(envAdminPwd) || Boolean(db.authBootstrap.claimedAdminHash);
    const needsAdminClaim = !envAdminPwd && !db.authBootstrap.claimedAdminHash;

    let currentUser = null;
    const token = extractBearer(req);
    if (token) {
      const payload = verifySessionToken(token);
      if (payload && db.users[payload.userId] && !db.users[payload.userId].blocked) {
        currentUser = toPublicProfile(db, db.users[payload.userId]);
      }
    }

    res.json({
      adminConfigured,
      needsAdminClaim,
      envAdminActive: Boolean(envAdminPwd),
      hasYoutubeKey: isYoutubeConfigured(),
      hasMtprotoConfig: isMtprotoConfigured(),
      botStatus: getBotStatus(),
      user: currentUser,
    });
  });

  async function issueSessionForMtprotoProfile(profile: MtprotoLoginProfile) {
    return mutateDb((db) => {
      const user = findOrCreateTelegramUser(
        db,
        profile.tgId,
        profile.username ?? undefined,
        profile.displayName || profile.username || undefined,
      );
      if (user.blocked) {
        return {error: 'Ваш аккаунт заблокирован администратором', status: 403 as const};
      }
      user.telegramSession = {
        phone: profile.phone,
        encryptedSession: profile.encryptedSession,
        displayName: profile.displayName,
        username: profile.username,
        connectedAt: new Date().toISOString(),
      };
      if (isBotOwner(profile.tgId)) {
        user.role = 'admin';
        user.planId = 'max';
      }
      const token = createSessionToken(user.id, user.role);
      return {status: 200 as const, token, user: toPublicProfile(db, user)};
    });
  }

  // Direct Website Login via Telegram Phone + Code + Optional 2FA Password (MTProto)
  router.post('/auth/telegram-phone/send-code', async (req: Request, res: Response) => {
    const phone = String(req.body?.phone || '').trim();
    const outcome = await startMtprotoLoginChallenge(phone);
    if (!outcome.ok) {
      res.status(400).json({error: outcome.error});
      return;
    }
    res.json({
      step: 'code',
      loginId: outcome.loginId,
      phoneMasked: outcome.phoneMasked,
    });
  });

  router.post('/auth/telegram-phone/verify-code', async (req: Request, res: Response) => {
    const loginId = String(req.body?.loginId || '').trim();
    const code = String(req.body?.code || '').trim();
    if (!loginId || !code) {
      res.status(400).json({error: 'Укажите код подтверждения'});
      return;
    }

    const outcome = await verifyMtprotoLoginCode(loginId, code);
    if (!outcome.ok) {
      res.status(400).json({error: outcome.error});
      return;
    }
    if (outcome.step === 'password') {
      res.json({step: 'password'});
      return;
    }

    const sessionRes = await issueSessionForMtprotoProfile(outcome.profile);
    if ('error' in sessionRes) {
      res.status(sessionRes.status).json({error: sessionRes.error});
      return;
    }
    res.json({step: 'connected', token: sessionRes.token, user: sessionRes.user});
  });

  router.post('/auth/telegram-phone/verify-password', async (req: Request, res: Response) => {
    const loginId = String(req.body?.loginId || '').trim();
    const password = String(req.body?.password || '');
    if (!loginId || !password) {
      res.status(400).json({error: 'Укажите пароль 2FA'});
      return;
    }

    const outcome = await verifyMtprotoLoginPassword(loginId, password);
    if (!outcome.ok) {
      res.status(400).json({error: outcome.error});
      return;
    }

    const sessionRes = await issueSessionForMtprotoProfile(outcome.profile);
    if ('error' in sessionRes) {
      res.status(sessionRes.status).json({error: sessionRes.error});
      return;
    }
    res.json({step: 'connected', token: sessionRes.token, user: sessionRes.user});
  });

  // Telegram Mini App (WebApp) verified auto-authentication
  router.post('/auth/telegram-webapp', async (req: Request, res: Response) => {
    const initData = String(req.body?.initData || '').trim();
    if (!initData) {
      res.status(400).json({error: 'Отсутствуют данные Telegram WebApp (initData)'});
      return;
    }

    const botToken = resolveBotToken();
    if (!botToken) {
      res.status(503).json({
        error: 'TELEGRAM_BOT_TOKEN не задан на сервере — невозможна проверка подписи Telegram WebApp.',
      });
      return;
    }

    const tgUser = verifyTelegramWebAppInitData(initData, botToken);
    if (!tgUser) {
      res.status(401).json({error: 'Недействительная или устаревшая подпись Telegram WebApp'});
      return;
    }

    const tgId = String(tgUser.id);
    const fullName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim();

    const outcome = await mutateDb((db) => {
      const user = findOrCreateTelegramUser(db, tgId, tgUser.username, fullName || tgUser.first_name);
      if (user.blocked) {
        return {error: 'Ваш аккаунт заблокирован администратором', status: 403 as const};
      }
      if (isBotOwner(tgId)) {
        user.role = 'admin';
        user.planId = 'max';
      }
      const token = createSessionToken(user.id, user.role);
      return {status: 200 as const, token, user: toPublicProfile(db, user)};
    });

    if ('error' in outcome) {
      res.status(outcome.status).json({error: outcome.error});
      return;
    }
    res.json({token: outcome.token, user: outcome.user});
  });

  // One-time Admin Claim
  router.post('/auth/claim-admin', async (req: Request, res: Response) => {
    const username = String(req.body?.username || 'admin').trim();
    const password = String(req.body?.password || '');

    if (username.length < 2 || username.length > 40) {
      res.status(400).json({error: 'Имя администратора должно быть от 2 до 40 символов'});
      return;
    }
    if (password.length < 6) {
      res.status(400).json({error: 'Пароль должен содержать минимум 6 символов'});
      return;
    }

    const result = await mutateDb((db) => {
      if (getEnvAdminPassword()) {
        return {error: 'Пароль администратора уже задан в переменных окружения (ADMIN_PASSWORD)', status: 409 as const};
      }
      if (db.authBootstrap.claimedAdminHash) {
        return {error: 'Администратор уже инициализирован', status: 409 as const};
      }

      const passwordHash = hashPassword(password);
      const nowIso = new Date().toISOString();
      const adminId = 'usr_admin';
      const existing = db.users[adminId];
      const adminUser: UserRecord = existing
        ? {
            ...existing,
            username,
            passwordHash,
            role: 'admin',
            blocked: false,
            planId: 'max',
            lastActiveAt: nowIso,
          }
        : {
            id: adminId,
            username,
            email: `${username.toLowerCase()}@clientfy.local`,
            passwordHash,
            role: 'admin',
            blocked: false,
            planId: 'max',
            subscriptionUntil: null,
            bonusRequests: 0,
            createdAt: nowIso,
            lastActiveAt: nowIso,
          };

      db.users[adminId] = adminUser;
      db.authBootstrap.claimedAdminHash = passwordHash;
      db.authBootstrap.claimedAt = nowIso;

      const token = createSessionToken(adminUser.id, 'admin');
      return {
        status: 200 as const,
        token,
        user: toPublicProfile(db, adminUser),
      };
    });

    if ('error' in result) {
      res.status(result.status).json({error: result.error});
      return;
    }
    res.json({token: result.token, user: result.user});
  });

  // Register
  router.post('/auth/register', async (req: Request, res: Response) => {
    const username = String(req.body?.username || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (username.length < 2 || username.length > 40) {
      res.status(400).json({error: 'Логин должен быть от 2 до 40 символов'});
      return;
    }
    if (password.length < 6) {
      res.status(400).json({error: 'Пароль должен быть не короче 6 символов'});
      return;
    }

    const result = await mutateDb((db) => {
      const duplicate = Object.values(db.users).find(
        (u) =>
          u.username.toLowerCase() === username.toLowerCase() ||
          (email && u.email.toLowerCase() === email),
      );
      if (duplicate) {
        return {error: 'Пользователь с таким логином или email уже существует', status: 409 as const};
      }

      const nowIso = new Date().toISOString();
      const userId = `usr_${crypto.randomBytes(6).toString('hex')}`;
      const user: UserRecord = {
        id: userId,
        username,
        email: email || `${username.toLowerCase()}@clientfy.user`,
        passwordHash: hashPassword(password),
        role: 'user',
        blocked: false,
        planId: 'free',
        subscriptionUntil: null,
        bonusRequests: 0,
        createdAt: nowIso,
        lastActiveAt: nowIso,
      };
      db.users[userId] = user;

      const token = createSessionToken(user.id, 'user');
      return {
        status: 201 as const,
        token,
        user: toPublicProfile(db, user),
      };
    });

    if ('error' in result) {
      res.status(result.status).json({error: result.error});
      return;
    }
    res.status(201).json({token: result.token, user: result.user});
  });

  // Login
  router.post('/auth/login', async (req: Request, res: Response) => {
    const identifier = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!identifier || !password) {
      res.status(400).json({error: 'Введите логин и пароль'});
      return;
    }

    const result = await mutateDb((db) => {
      const envAdminPwd = getEnvAdminPassword();
      const isAdminAttempt = identifier.toLowerCase() === 'admin';

      if (isAdminAttempt && envAdminPwd && timingSafeStringMatch(password, envAdminPwd)) {
        const nowIso = new Date().toISOString();
        const existingAdmin =
          Object.values(db.users).find((u) => u.role === 'admin') || db.users['usr_admin'];
        const adminId = existingAdmin?.id || 'usr_admin';
        const adminUser: UserRecord = existingAdmin
          ? {...existingAdmin, role: 'admin', blocked: false, planId: 'max', lastActiveAt: nowIso}
          : {
              id: adminId,
              username: 'admin',
              email: 'admin@clientfy.local',
              passwordHash: hashPassword(envAdminPwd),
              role: 'admin',
              blocked: false,
              planId: 'max',
              subscriptionUntil: null,
              bonusRequests: 0,
              createdAt: nowIso,
              lastActiveAt: nowIso,
            };
        db.users[adminId] = adminUser;
        const token = createSessionToken(adminUser.id, 'admin');
        return {status: 200 as const, token, user: toPublicProfile(db, adminUser)};
      }

      const user = Object.values(db.users).find(
        (u) =>
          u.username.toLowerCase() === identifier.toLowerCase() ||
          u.email.toLowerCase() === identifier.toLowerCase(),
      );

      if (!user || !verifyPassword(password, user.passwordHash)) {
        return {error: 'Неверный логин или пароль', status: 401 as const};
      }

      if (user.blocked) {
        return {error: 'Ваш аккаунт заблокирован администратором', status: 403 as const};
      }

      user.lastActiveAt = new Date().toISOString();
      const token = createSessionToken(user.id, user.role);
      return {status: 200 as const, token, user: toPublicProfile(db, user)};
    });

    if ('error' in result) {
      res.status(result.status).json({error: result.error});
      return;
    }
    res.json({token: result.token, user: result.user});
  });

  router.get('/me', requireAuth, async (req: AuthedRequest, res: Response) => {
    const db = await readDb();
    const user = db.users[req.authUser!.userId];
    if (!user) {
      res.status(404).json({error: 'Пользователь не найден'});
      return;
    }
    res.json({
      user: toPublicProfile(db, user),
      hasYoutubeKey: isYoutubeConfigured(),
    });
  });

  router.get('/plans', requireAuth, async (_req: AuthedRequest, res: Response) => {
    const db = await readDb();
    res.json({
      plans: getPlans(db.settings),
      botStatus: getBotStatus(),
      paymentDetails: {
        visaCardDetails: db.settings.visaCardDetails,
        tonWalletAddress: db.settings.tonWalletAddress,
        gramWalletAddress: db.settings.gramWalletAddress,
        supportContact: db.settings.supportContact,
        channelUrl: db.settings.channelUrl,
      },
    });
  });

  // Real YouTube Data API v3 Search (matching original ClientFy logic & per-channel quota)
  router.post('/youtube/search', requireAuth, async (req: AuthedRequest, res: Response) => {
    const query = String(req.body?.query || '').trim();
    if (query.length < 2 || query.length > 120) {
      res.status(400).json({error: 'Введите поисковый запрос от 2 до 120 символов'});
      return;
    }

    const dbSnapshot = await readDb();
    const userSnapshot = dbSnapshot.users[req.authUser!.userId];
    if (!userSnapshot) {
      res.status(404).json({error: 'Пользователь не найден'});
      return;
    }

    const preQuota = computeQuotaSummary(dbSnapshot, userSnapshot);
    if (preQuota.totalAvailable <= 0) {
      res.status(429).json({
        error: 'Дневной лимит каналов исчерпан. Активируйте промокод или улучшите тариф.',
        quota: preQuota,
      });
      return;
    }

    const plans = getPlans(dbSnapshot.settings);
    const activePlan = plans.find((p) => p.id === preQuota.planId) || plans[0];

    const days = Math.min(3650, Math.max(0, Number(req.body?.days ?? 7) || 0));
    const requestedCount = Math.min(
      activePlan.maxResultsPerSearch,
      Math.max(1, Math.trunc(Number(req.body?.count ?? 5) || 5)),
    );
    const effectiveCount = Math.min(requestedCount, preQuota.totalAvailable);

    const minSubs = Math.max(0, Number(req.body?.minSubs ?? 0) || 0);
    const maxSubsRaw = req.body?.maxSubs;
    const maxSubs =
      maxSubsRaw === null || maxSubsRaw === '' || maxSubsRaw === undefined
        ? null
        : Math.max(minSubs, Number(maxSubsRaw) || 0);
    const langRaw = String(req.body?.lang || 'any');
    const lang: SearchFilters['lang'] = langRaw === 'ru' || langRaw === 'en' ? langRaw : 'any';

    const filters: SearchFilters = {
      query,
      days,
      count: effectiveCount,
      minSubs,
      maxSubs,
      lang,
      requireChannelLink: Boolean(req.body?.requireChannelLink),
      requireRecentLink: Boolean(req.body?.requireRecentLink),
    };

    let channels: YouTubeChannelResult[];
    try {
      channels = await searchYouTubeChannels(filters);
    } catch (err) {
      if (err instanceof YouTubeConfigError) {
        res.status(503).json({code: err.code, error: err.message});
        return;
      }
      if (err instanceof YouTubeApiError) {
        res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
          error: err.message,
        });
        return;
      }
      res.status(500).json({error: 'Не удалось выполнить запрос к YouTube API'});
      return;
    }

    const saved = await mutateDb((db) => {
      const user = db.users[req.authUser!.userId];
      if (!user) return null;
      const consumed = consumeChannelQuota(db, user, channels.length);
      if (!consumed.ok) {
        return {limitHit: true as const, quota: consumed.quota};
      }
      const entry = recordSearchHistory(db, user.id, filters, channels);
      return {
        limitHit: false as const,
        quota: consumed.quota,
        historyEntryId: entry.id,
        stats: entry.stats,
      };
    });

    if (!saved) {
      res.status(404).json({error: 'Пользователь не найден'});
      return;
    }
    if (saved.limitHit) {
      res.status(429).json({error: 'Лимит каналов исчерпан', quota: saved.quota});
      return;
    }

    res.json({
      historyEntryId: saved.historyEntryId,
      filters,
      channels,
      stats: saved.stats,
      quota: saved.quota,
      cappedNotice:
        requestedCount > effectiveCount
          ? `Запрошено ${requestedCount}, но по лимиту доступно ${effectiveCount} каналов.`
          : null,
    });
  });

  // Search History
  router.get('/history', requireAuth, async (req: AuthedRequest, res: Response) => {
    const db = await readDb();
    const userId = req.authUser!.userId;
    const entries = db.searchHistory
      .filter((h) => h.userId === userId)
      .slice(0, 100)
      .map((h) => ({
        id: h.id,
        ptDate: h.ptDate,
        createdAt: h.createdAt,
        filters: h.filters,
        totalFound: h.totalFound,
        stats: h.stats,
      }));
    res.json({entries});
  });

  router.get('/history/:id', requireAuth, async (req: AuthedRequest, res: Response) => {
    const db = await readDb();
    const entry = db.searchHistory.find(
      (h) => h.id === req.params.id && (h.userId === req.authUser!.userId || req.authUser!.role === 'admin'),
    );
    if (!entry) {
      res.status(404).json({error: 'Запись истории не найдена'});
      return;
    }
    res.json({entry});
  });

  // Payments
  router.get('/payments/my', requireAuth, async (req: AuthedRequest, res: Response) => {
    const db = await readDb();
    const list = db.paymentApps.filter((p) => p.userId === req.authUser!.userId);
    res.json({payments: list});
  });

  router.post('/payments/submit', requireAuth, async (_req: AuthedRequest, res: Response) => {
    res.status(410).json({
      error: 'Оплата выполняется исключительно через Telegram-бота @demov2clientfybot.',
    });
  });

  // Telegram Bot Order Creation (Stars + Visa/TON/GRAM checkout inside bot) with Idempotency
  router.post('/payments/stars/create', requireAuth, async (req: AuthedRequest, res: Response) => {
    const planIdRaw = String(req.body?.planId || '');
    if (planIdRaw !== 'pro' && planIdRaw !== 'max') {
      res.status(400).json({error: 'Выберите тариф Pro или Max'});
      return;
    }

    const order = await mutateDb((db) => {
      const user = db.users[req.authUser!.userId];
      if (!user) return null;
      const plans = getPlans(db.settings);
      const plan = plans.find((p) => p.id === planIdRaw)!;

      // Idempotency guard: reuse recent pending order (within 60s) for same user & plan
      const cutoff = Date.now() - 60_000;
      const recentPending = Object.values(db.starOrders).find(
        (o) =>
          o.userId === user.id &&
          o.planId === planIdRaw &&
          o.status === 'pending' &&
          o.starsAmount === plan.priceStars &&
          Date.parse(o.createdAt) >= cutoff,
      );
      if (recentPending) {
        return recentPending;
      }

      const id = `st_${crypto.randomBytes(6).toString('hex')}`;
      const record: StarOrder = {
        id,
        userId: user.id,
        username: user.username,
        planId: planIdRaw,
        starsAmount: plan.priceStars,
        status: 'pending',
        telegramUserId: user.telegramId ?? null,
        telegramChargeId: null,
        createdAt: new Date().toISOString(),
        paidAt: null,
      };
      db.starOrders[id] = record;
      return record;
    });

    if (!order) {
      res.status(404).json({error: 'Пользователь не найден'});
      return;
    }

    const botStatus = getBotStatus();
    const botUsername =
      botStatus.username ||
      process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '') ||
      'demov2clientfybot';
    const deepLink = `https://t.me/${botUsername}?start=pay_${order.id}`;
    const invoiceLink = await createStarsInvoiceLink(
      order.planId,
      order.starsAmount,
      `web_order:${order.id}`,
      `Оплата для ${order.username}`,
    );

    res.status(201).json({order, botStatus, deepLink, invoiceLink});
  });

  router.get('/payments/stars/:orderId', requireAuth, async (req: AuthedRequest, res: Response) => {
    const orderId = String(req.params.orderId || '');
    const db = await readDb();
    const order = db.starOrders[orderId];
    if (!order || (order.userId !== req.authUser!.userId && req.authUser!.role !== 'admin')) {
      res.status(404).json({error: 'Заказ Stars не найден'});
      return;
    }
    const user = db.users[order.userId];
    res.json({
      order,
      user: user ? toPublicProfile(db, user) : null,
    });
  });

  router.post('/telegram/link-code', requireAuth, async (req: AuthedRequest, res: Response) => {
    const code = crypto.randomBytes(5).toString('hex');
    await mutateDb((db) => {
      db.telegramLinks[code] = {
        code,
        userId: req.authUser!.userId,
        createdAt: new Date().toISOString(),
      };
    });
    const botStatus = getBotStatus();
    const botUsername =
      botStatus.username ||
      process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '') ||
      'demov2clientfybot';
    const deepLink = `https://t.me/${botUsername}?start=link_${code}`;
    res.json({code, botStatus, deepLink});
  });

  // Promo redemption
  router.post('/promo/redeem', requireAuth, async (req: AuthedRequest, res: Response) => {
    const code = String(req.body?.code || '').trim().toUpperCase();
    if (!code) {
      res.status(400).json({error: 'Введите промокод'});
      return;
    }

    const outcome = await mutateDb((db) => {
      const user = db.users[req.authUser!.userId];
      if (!user) return {error: 'Пользователь не найден', status: 404 as const};

      const promo = db.promoCodes[code];
      if (!promo || !promo.active) {
        return {error: 'Промокод не найден или отключён', status: 404 as const};
      }
      if (promo.usedBy.includes(user.id)) {
        return {error: 'Вы уже использовали этот промокод', status: 409 as const};
      }
      if (promo.usedBy.length >= promo.maxUses) {
        return {error: 'Лимит использований промокода исчерпан', status: 409 as const};
      }

      promo.usedBy.push(user.id);
      let message = '';
      if (promo.type === 'requests') {
        user.bonusRequests = (user.bonusRequests || 0) + promo.value;
        message = `Промокод активирован! +${promo.value} каналов к квоте.`;
      } else {
        const targetPlan = promo.plan === 'pro' ? 'pro' : 'max';
        const baseTime =
          user.subscriptionUntil && DateTime.fromISO(user.subscriptionUntil) > DateTime.now()
            ? DateTime.fromISO(user.subscriptionUntil)
            : DateTime.now();
        user.planId = user.planId === 'max' ? 'max' : targetPlan;
        user.subscriptionUntil = baseTime.plus({days: promo.value}).toISO();
        message = `Промокод активирован! Тариф ${targetPlan.toUpperCase()} на ${promo.value} дн.`;
      }

      return {
        status: 200 as const,
        message,
        user: toPublicProfile(db, user),
      };
    });

    if ('error' in outcome) {
      res.status(outcome.status).json({error: outcome.error});
      return;
    }
    res.json({message: outcome.message, user: outcome.user});
  });

  // Outreach / Autosend Workspace
  router.get('/outreach', requireAuth, async (req: AuthedRequest, res: Response) => {
    const [{data, sentLogs}, telegramAccount] = await Promise.all([
      readUserAutosend(req.authUser!.userId),
      getUserbotStatus(req.authUser!.userId),
    ]);
    res.json({
      ...data,
      sentLogs,
      telegramAccount,
    });
  });

  // Real Telegram MTProto User-Account Auth for Autosend
  router.get('/outreach/telegram/status', requireAuth, async (req: AuthedRequest, res: Response) => {
    const status = await getUserbotStatus(req.authUser!.userId);
    res.json(status);
  });

  router.post('/outreach/telegram/send-code', requireAuth, async (req: AuthedRequest, res: Response) => {
    const phone = String(req.body?.phone || '').trim();
    const outcome = await sendUserbotAuthCode(req.authUser!.userId, phone);
    if (!outcome.ok) {
      res.status(400).json({error: outcome.error});
      return;
    }
    const status = await getUserbotStatus(req.authUser!.userId);
    res.json({step: 'code', phoneMasked: outcome.phoneMasked, status});
  });

  router.post('/outreach/telegram/verify-code', requireAuth, async (req: AuthedRequest, res: Response) => {
    const code = String(req.body?.code || '').trim();
    const outcome = await verifyUserbotAuthCode(req.authUser!.userId, code);
    if (!outcome.ok) {
      res.status(400).json({error: outcome.error});
      return;
    }
    if (outcome.step === 'password') {
      const status = await getUserbotStatus(req.authUser!.userId);
      res.json({step: 'password', status});
      return;
    }
    res.json({step: 'connected', status: outcome.status});
  });

  router.post('/outreach/telegram/verify-password', requireAuth, async (req: AuthedRequest, res: Response) => {
    const password = String(req.body?.password || '');
    const outcome = await verifyUserbotAuthPassword(req.authUser!.userId, password);
    if (!outcome.ok) {
      res.status(400).json({error: outcome.error});
      return;
    }
    res.json({step: 'connected', status: outcome.status});
  });

  router.post('/outreach/telegram/disconnect', requireAuth, async (req: AuthedRequest, res: Response) => {
    const status = await disconnectUserbot(req.authUser!.userId);
    res.json({status});
  });

  router.post('/outreach/campaigns/start', requireAuth, async (req: AuthedRequest, res: Response) => {
    const templateId = String(req.body?.templateId || '');
    const delayMin = Number(req.body?.delayMinSec ?? req.body?.delayMin ?? 20);
    const delayMax = Number(req.body?.delayMaxSec ?? req.body?.delayMax ?? 30);

    const outcome = await startRealOutreachCampaign(
      req.authUser!.userId,
      templateId,
      delayMin,
      delayMax,
    );
    if (!outcome.ok) {
      res.status(400).json({error: outcome.error});
      return;
    }
    const [{data, sentLogs}, telegramAccount] = await Promise.all([
      readUserAutosend(req.authUser!.userId),
      getUserbotStatus(req.authUser!.userId),
    ]);
    res.json({...data, sentLogs, telegramAccount});
  });

  router.post('/outreach/campaigns/stop', requireAuth, async (req: AuthedRequest, res: Response) => {
    await stopRealOutreachCampaign(req.authUser!.userId);
    const [{data, sentLogs}, telegramAccount] = await Promise.all([
      readUserAutosend(req.authUser!.userId),
      getUserbotStatus(req.authUser!.userId),
    ]);
    res.json({...data, sentLogs, telegramAccount});
  });

  router.post('/outreach/contacts', requireAuth, async (req: AuthedRequest, res: Response) => {
    const rawItems = Array.isArray(req.body?.contacts) ? req.body.contacts : [req.body];
    if (rawItems.length === 0) {
      res.status(400).json({error: 'Не переданы контакты'});
      return;
    }

    const addedCount = await mutateUserAutosend(req.authUser!.userId, (data) => {
      let added = 0;
      const existingValues = new Set(data.contacts.map((c) => c.contactValue.toLowerCase()));

      for (const item of rawItems.slice(0, 100)) {
        const contactValue = String(item?.contactValue || '').trim();
        const channelTitle = String(item?.channelTitle || 'Канал').trim().slice(0, 120);
        if (!contactValue || existingValues.has(contactValue.toLowerCase())) continue;

        const contactTypeRaw = String(item?.contactType || 'telegram');
        const contactType: OutreachContact['contactType'] =
          contactTypeRaw === 'email' || contactTypeRaw === 'website' || contactTypeRaw === 'social'
            ? contactTypeRaw
            : 'telegram';

        existingValues.add(contactValue.toLowerCase());
        data.contacts.unshift({
          id: `cnt_${crypto.randomBytes(5).toString('hex')}`,
          channelId: String(item?.channelId || '').slice(0, 64),
          channelTitle,
          channelUrl: String(item?.channelUrl || '').slice(0, 200),
          handle: String(item?.handle || '').slice(0, 64),
          contactValue: contactValue.slice(0, 200),
          contactType,
          subscriberCount: Math.max(0, Number(item?.subscriberCount || 0) || 0),
          status: 'queued',
          addedAt: new Date().toISOString(),
          sentAt: null,
        });
        added += 1;
      }

      return {result: added};
    });

    const [updated, telegramAccount] = await Promise.all([
      readUserAutosend(req.authUser!.userId),
      getUserbotStatus(req.authUser!.userId),
    ]);
    res.status(201).json({
      added: addedCount,
      ...updated.data,
      sentLogs: updated.sentLogs,
      telegramAccount,
    });
  });

  // Topic-based Telegram personal handle collector (from original ClientFy autosend.py)
  router.post('/outreach/collect', requireAuth, async (req: AuthedRequest, res: Response) => {
    const rawTopics = Array.isArray(req.body?.topics)
      ? req.body.topics
      : String(req.body?.topics || '')
          .split(/[\n,;]+/)
          .map((t) => t.trim());
    const topics = rawTopics.map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 5);

    if (topics.length === 0) {
      res.status(400).json({error: 'Укажите хотя бы одну тему для сбора контактов'});
      return;
    }

    const days = Math.min(365, Math.max(0, Number(req.body?.days ?? 14) || 0));
    const perTopicCount = Math.min(15, Math.max(3, Number(req.body?.count ?? 8) || 8));

    const collected: Array<{
      channelId: string;
      channelTitle: string;
      channelUrl: string;
      handle: string;
      contactValue: string;
      subscriberCount: number;
    }> = [];

    try {
      for (const topic of topics) {
        const channels = await searchYouTubeChannels({
          query: topic,
          days,
          count: perTopicCount,
          minSubs: 0,
          maxSubs: null,
          lang: 'any',
          requireChannelLink: false,
          requireRecentLink: false,
        });
        for (const ch of channels) {
          const allUrls = ch.linkSources.map((s) => s.url);
          const tgHandles = extractPersonalTgHandles(allUrls, ch.description);
          for (const tg of tgHandles) {
            collected.push({
              channelId: ch.channelId,
              channelTitle: ch.title,
              channelUrl: ch.url,
              handle: ch.handle,
              contactValue: tg,
              subscriberCount: ch.subscriberCount,
            });
          }
        }
      }
    } catch (err) {
      if (err instanceof YouTubeConfigError) {
        res.status(503).json({code: err.code, error: err.message});
        return;
      }
      if (err instanceof YouTubeApiError) {
        res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
          error: err.message,
        });
        return;
      }
      res.status(500).json({error: 'Ошибка сбора контактов по темам'});
      return;
    }

    const addedCount = await mutateUserAutosend(req.authUser!.userId, (data) => {
      data.campaign.topics = topics;
      const existingValues = new Set(data.contacts.map((c) => c.contactValue.toLowerCase()));
      let added = 0;

      for (const item of collected) {
        if (existingValues.has(item.contactValue.toLowerCase())) continue;
        existingValues.add(item.contactValue.toLowerCase());
        data.contacts.unshift({
          id: `cnt_${crypto.randomBytes(5).toString('hex')}`,
          channelId: item.channelId,
          channelTitle: item.channelTitle,
          channelUrl: item.channelUrl,
          handle: item.handle,
          contactValue: item.contactValue,
          contactType: 'telegram',
          subscriberCount: item.subscriberCount,
          status: 'queued',
          addedAt: new Date().toISOString(),
          sentAt: null,
        });
        added += 1;
      }
      data.campaign.lastMessage = `Сбор по темам (${topics.join(', ')}): найдено ${added} новых Telegram-контактов`;
      return {result: added};
    });

    const [updated, telegramAccount] = await Promise.all([
      readUserAutosend(req.authUser!.userId),
      getUserbotStatus(req.authUser!.userId),
    ]);
    res.json({
      added: addedCount,
      foundTotal: collected.length,
      ...updated.data,
      sentLogs: updated.sentLogs,
      telegramAccount,
    });
  });

  router.patch('/outreach/contacts/:id', requireAuth, async (req: AuthedRequest, res: Response) => {
    const statusRaw = String(req.body?.status || '');
    if (statusRaw !== 'queued' && statusRaw !== 'sent' && statusRaw !== 'skipped') {
      res.status(400).json({error: 'Некорректный статус контакта'});
      return;
    }

    const found = await mutateUserAutosend(req.authUser!.userId, (data) => {
      const contact = data.contacts.find((c) => c.id === req.params.id);
      if (!contact) return {result: false};
      contact.status = statusRaw;
      contact.sentAt = statusRaw === 'sent' ? new Date().toISOString() : null;
      return {result: true};
    });

    if (!found) {
      res.status(404).json({error: 'Контакт не найден'});
      return;
    }
    const [updated, telegramAccount] = await Promise.all([
      readUserAutosend(req.authUser!.userId),
      getUserbotStatus(req.authUser!.userId),
    ]);
    res.json({...updated.data, sentLogs: updated.sentLogs, telegramAccount});
  });

  router.delete('/outreach/contacts/:id', requireAuth, async (req: AuthedRequest, res: Response) => {
    await mutateUserAutosend(req.authUser!.userId, (data) => {
      data.contacts = data.contacts.filter((c) => c.id !== req.params.id);
      return {result: true};
    });
    const [updated, telegramAccount] = await Promise.all([
      readUserAutosend(req.authUser!.userId),
      getUserbotStatus(req.authUser!.userId),
    ]);
    res.json({...updated.data, sentLogs: updated.sentLogs, telegramAccount});
  });

  router.post('/outreach/templates', requireAuth, async (req: AuthedRequest, res: Response) => {
    const id = req.body?.id ? String(req.body.id) : null;
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const body = String(req.body?.body || '').trim().slice(0, 2000);
    if (!name || !body) {
      res.status(400).json({error: 'Укажите название и текст шаблона'});
      return;
    }

    await mutateUserAutosend(req.authUser!.userId, (data) => {
      const nowIso = new Date().toISOString();
      if (id) {
        const existing = data.templates.find((t) => t.id === id);
        if (existing) {
          existing.name = name;
          existing.body = body;
          existing.updatedAt = nowIso;
          return {result: existing};
        }
      }
      const created: OutreachTemplate = {
        id: `tpl_${crypto.randomBytes(5).toString('hex')}`,
        name,
        body,
        updatedAt: nowIso,
      };
      data.templates.unshift(created);
      data.campaign.templateId = created.id;
      return {result: created};
    });

    const [updated, telegramAccount] = await Promise.all([
      readUserAutosend(req.authUser!.userId),
      getUserbotStatus(req.authUser!.userId),
    ]);
    res.json({...updated.data, sentLogs: updated.sentLogs, telegramAccount});
  });

  router.delete('/outreach/templates/:id', requireAuth, async (req: AuthedRequest, res: Response) => {
    await mutateUserAutosend(req.authUser!.userId, (data) => {
      if (data.templates.length <= 1) return {result: false};
      data.templates = data.templates.filter((t) => t.id !== req.params.id);
      if (data.campaign.templateId === req.params.id) {
        data.campaign.templateId = data.templates[0]?.id || null;
      }
      return {result: true};
    });
    const [updated, telegramAccount] = await Promise.all([
      readUserAutosend(req.authUser!.userId),
      getUserbotStatus(req.authUser!.userId),
    ]);
    res.json({...updated.data, sentLogs: updated.sentLogs, telegramAccount});
  });

  router.post('/outreach/campaigns/generate', requireAuth, async (req: AuthedRequest, res: Response) => {
    const templateId = String(req.body?.templateId || '');
    const markAsSent = Boolean(req.body?.markAsSent);

    type GenerateOutcome =
      | {error: string}
      | {
          generatedMessages: Array<{
            contactId: string;
            channelTitle: string;
            contactValue: string;
            contactType: string;
            message: string;
          }>;
          count: number;
        };

    const outcome = await mutateUserAutosend<GenerateOutcome>(req.authUser!.userId, (data, sentLogs) => {
      const template =
        data.templates.find((t) => t.id === templateId) || data.templates[0];
      if (!template) {
        return {result: {error: 'Шаблон не найден'}};
      }

      const queued = data.contacts.filter((c) => c.status === 'queued');
      if (queued.length === 0) {
        return {result: {error: 'В очереди нет контактов со статусом «В очереди»'}};
      }

      const nowIso = new Date().toISOString();
      const generatedMessages = queued.map((c) => {
        const chUrl =
          c.channelUrl ||
          (c.channelId ? `https://www.youtube.com/channel/${c.channelId}` : c.contactValue);
        const text = template.body
          .replace(/\{title\}/g, c.channelTitle)
          .replace(/\{url\}/g, chUrl)
          .replace(/\{\{channel\}\}/g, c.channelTitle)
          .replace(/\{\{handle\}\}/g, c.handle || c.channelTitle)
          .replace(/\{\{subs\}\}/g, formatSubsShort(c.subscriberCount));
        return {
          contactId: c.id,
          channelTitle: c.channelTitle,
          contactValue: c.contactValue,
          contactType: c.contactType,
          message: text,
        };
      });

      const nextLogs: SentOutreachLog[] = [...sentLogs];
      if (markAsSent) {
        for (const c of queued) {
          c.status = 'sent';
          c.sentAt = nowIso;
          nextLogs.unshift({
            id: `log_${crypto.randomBytes(5).toString('hex')}`,
            contactId: c.id,
            channelTitle: c.channelTitle,
            contactValue: c.contactValue,
            templateName: template.name,
            status: 'sent',
            detail: 'Сформировано и отмечено в очереди рассылки',
            timestamp: nowIso,
          });
        }
        data.campaign.sentCount += queued.length;
        data.campaign.lastMessage = `Сформирована партия из ${queued.length} сообщений (${template.name})`;
        data.campaign.finishedAt = nowIso;
      }

      return {
        result: {generatedMessages, count: generatedMessages.length},
        nextSentLogs: markAsSent ? nextLogs : undefined,
      };
    });

    if ('error' in outcome) {
      res.status(400).json({error: outcome.error});
      return;
    }

    const [updated, telegramAccount] = await Promise.all([
      readUserAutosend(req.authUser!.userId),
      getUserbotStatus(req.authUser!.userId),
    ]);
    res.json({
      ...outcome,
      ...updated.data,
      sentLogs: updated.sentLogs,
      telegramAccount,
    });
  });

  // ---------------- ADMIN ROUTES ----------------
  router.get('/admin/overview', requireAuth, requireAdmin, async (_req: AuthedRequest, res: Response) => {
    const db = await readDb();
    const usersList = Object.values(db.users);
    const ptDate = DateTime.now().setZone('America/Los_Angeles').toISODate() || '';

    const searchesToday = Object.values(db.usage).reduce(
      (sum, byDate) => sum + (byDate[ptDate] ?? 0),
      0,
    );
    const pendingPayments = db.paymentApps.filter((p) => p.status === 'pending').length;
    const activePromos = Object.values(db.promoCodes).filter((p) => p.active).length;

    res.json({
      totalUsers: usersList.length,
      activeSubscribers: usersList.filter((u) => u.planId !== 'free').length,
      blockedUsers: usersList.filter((u) => u.blocked).length,
      searchesToday,
      totalHistoryEntries: db.searchHistory.length,
      pendingPayments,
      activePromos,
      hasYoutubeKey: isYoutubeConfigured(),
      botStatus: getBotStatus(),
      ptDate,
    });
  });

  router.get('/admin/users', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const page = Math.max(1, Number(req.query.page || 1) || 1);
    const pageSize = 20;

    const db = await readDb();
    const filtered = Object.values(db.users)
      .filter(
        (u) =>
          !q ||
          u.username.toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q) ||
          u.id.toLowerCase().includes(q),
      )
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));

    const total = filtered.length;
    const slice = filtered.slice((page - 1) * pageSize, page * pageSize);

    res.json({
      users: slice.map((u) => toPublicProfile(db, u)),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  });

  router.patch('/admin/users/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    const targetId = String(req.params.id);
    const outcome = await mutateDb((db) => {
      const user = db.users[targetId];
      if (!user) return {error: 'Пользователь не найден', status: 404 as const};

      if (typeof req.body?.blocked === 'boolean') {
        if (user.id === req.authUser!.userId && req.body.blocked) {
          return {error: 'Нельзя заблокировать собственный аккаунт администратора', status: 400 as const};
        }
        user.blocked = req.body.blocked;
      }

      if (req.body?.planId === 'free' || req.body?.planId === 'pro' || req.body?.planId === 'max') {
        user.planId = req.body.planId;
        if (req.body.planId === 'free') {
          user.subscriptionUntil = null;
        }
      }

      if (typeof req.body?.addBonusRequests === 'number' && Number.isFinite(req.body.addBonusRequests)) {
        user.bonusRequests = Math.max(0, (user.bonusRequests || 0) + Math.trunc(req.body.addBonusRequests));
      }

      if (typeof req.body?.addDays === 'number' && Number.isFinite(req.body.addDays) && req.body.addDays > 0) {
        const base =
          user.subscriptionUntil && DateTime.fromISO(user.subscriptionUntil) > DateTime.now()
            ? DateTime.fromISO(user.subscriptionUntil)
            : DateTime.now();
        if (user.planId === 'free') user.planId = 'pro';
        user.subscriptionUntil = base.plus({days: Math.trunc(req.body.addDays)}).toISO();
      }

      return {status: 200 as const, user: toPublicProfile(db, user)};
    });

    if ('error' in outcome) {
      res.status(outcome.status).json({error: outcome.error});
      return;
    }
    res.json({user: outcome.user});
  });

  router.get('/admin/payments', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    const statusFilter = String(req.query.status || 'all');
    const db = await readDb();
    const list = db.paymentApps.filter(
      (p) => statusFilter === 'all' || p.status === statusFilter,
    );
    res.json({payments: list});
  });

  router.post('/admin/payments/:id/review', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    const decision = String(req.body?.decision || '');
    const adminNote = String(req.body?.adminNote || '').trim().slice(0, 300);

    if (decision !== 'approved' && decision !== 'rejected') {
      res.status(400).json({error: 'Укажите решение approved или rejected'});
      return;
    }

    const result = await mutateDb((db) => {
      const app = db.paymentApps.find((p) => p.id === req.params.id);
      if (!app) return {error: 'Заявка не найдена', status: 404 as const};
      if (app.status !== 'pending') {
        return {error: 'Заявка уже обработана', status: 409 as const};
      }

      const nowIso = new Date().toISOString();
      app.status = decision;
      app.adminNote = adminNote;
      app.reviewedAt = nowIso;
      app.reviewedBy = req.authUser!.userId;

      if (decision === 'approved') {
        const user = db.users[app.userId];
        if (user) {
          const plans = getPlans(db.settings);
          const plan = plans.find((p) => p.id === app.planId);
          const durationDays = plan?.durationDays || 30;
          const base =
            user.subscriptionUntil && DateTime.fromISO(user.subscriptionUntil) > DateTime.now()
              ? DateTime.fromISO(user.subscriptionUntil)
              : DateTime.now();
          user.planId = app.planId;
          user.subscriptionUntil = base.plus({days: durationDays}).toISO();
        }
      }

      return {status: 200 as const, payment: app};
    });

    if ('error' in result) {
      res.status(result.status).json({error: result.error});
      return;
    }
    void notifyTelegramUserPaymentResult(result.payment, decision);
    res.json({payment: result.payment});
  });

  router.get('/admin/promos', requireAuth, requireAdmin, async (_req: AuthedRequest, res: Response) => {
    const db = await readDb();
    const promos = Object.values(db.promoCodes).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    res.json({promos});
  });

  router.post('/admin/promos', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    const code = String(req.body?.code || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, '');
    const type: PromoType = req.body?.type === 'subscription' ? 'subscription' : 'requests';
    const plan: 'pro' | 'max' = req.body?.plan === 'pro' ? 'pro' : 'max';
    const value = Math.max(1, Math.min(3650, Math.trunc(Number(req.body?.value || 0))));
    const maxUses = Math.max(1, Math.min(100000, Math.trunc(Number(req.body?.maxUses || 1))));

    if (code.length < 3 || code.length > 32) {
      res.status(400).json({error: 'Код должен содержать 3–32 символа (латиница, цифры, _ или -)'});
      return;
    }

    const promo = await mutateDb((db) => {
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
      db.promoCodes[code] = record;
      return record;
    });

    res.status(201).json({promo});
  });

  router.delete('/admin/promos/:code', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    const code = String(req.params.code || '').toUpperCase();
    await mutateDb((db) => {
      if (db.promoCodes[code]) {
        db.promoCodes[code].active = false;
      }
    });
    res.json({ok: true});
  });

  router.get('/admin/settings', requireAuth, requireAdmin, async (_req: AuthedRequest, res: Response) => {
    const db = await readDb();
    res.json({settings: db.settings});
  });

  router.patch('/admin/settings', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    const updated = await mutateDb((db) => {
      if (typeof req.body?.freeDailyLimit === 'number') {
        db.settings.freeDailyLimit = Math.max(1, Math.min(500, Math.trunc(req.body.freeDailyLimit)));
      }
      if (typeof req.body?.proDailyLimit === 'number') {
        db.settings.proDailyLimit = Math.max(1, Math.min(5000, Math.trunc(req.body.proDailyLimit)));
      }
      if (typeof req.body?.maxDailyLimit === 'number') {
        db.settings.maxDailyLimit = Math.max(1, Math.min(10000, Math.trunc(req.body.maxDailyLimit)));
      }
      if (typeof req.body?.proPriceUsd === 'number') {
        db.settings.proPriceUsd = Math.max(1, Math.min(1000, Number(req.body.proPriceUsd)));
      }
      if (typeof req.body?.proPriceStars === 'number') {
        db.settings.proPriceStars = Math.max(1, Math.min(100000, Math.trunc(req.body.proPriceStars)));
      }
      if (typeof req.body?.maxPriceUsd === 'number') {
        db.settings.maxPriceUsd = Math.max(1, Math.min(1000, Number(req.body.maxPriceUsd)));
      }
      if (typeof req.body?.maxPriceStars === 'number') {
        db.settings.maxPriceStars = Math.max(1, Math.min(100000, Math.trunc(req.body.maxPriceStars)));
      }
      if (typeof req.body?.visaCardDetails === 'string') {
        db.settings.visaCardDetails = req.body.visaCardDetails.trim().slice(0, 300);
      }
      if (typeof req.body?.tonWalletAddress === 'string') {
        db.settings.tonWalletAddress = req.body.tonWalletAddress.trim().slice(0, 200);
      }
      if (typeof req.body?.gramWalletAddress === 'string') {
        db.settings.gramWalletAddress = req.body.gramWalletAddress.trim().slice(0, 200);
      }
      if (typeof req.body?.supportContact === 'string') {
        db.settings.supportContact = req.body.supportContact.trim().slice(0, 100);
      }
      if (typeof req.body?.channelUrl === 'string') {
        const safeUrl = sanitizeHttpUrl(req.body.channelUrl);
        if (safeUrl) db.settings.channelUrl = safeUrl;
      }
      return db.settings;
    });
    res.json({settings: updated});
  });

  // Broadcast to all Telegram Bot Users (OWNER_ID only)
  router.post('/admin/broadcast', requireAuth, requireAdmin, async (req: AuthedRequest, res: Response) => {
    const text = String(req.body?.text || '').trim();
    if (!text || text.length > 4000) {
      res.status(400).json({error: 'Текст рассылки должен быть от 1 до 4000 символов'});
      return;
    }
    try {
      const result = await broadcastToAllTelegramUsers(text);
      res.json({ok: true, ...result});
    } catch (err) {
      res.status(503).json({
        error: err instanceof Error ? err.message : 'Не удалось выполнить рассылку через бота',
      });
    }
  });

  // Centralized API Error Handler
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[API Error]', err);
    if (res.headersSent) return;
    res.status(500).json({error: 'Внутренняя ошибка сервера'});
  });

  return router;
}
