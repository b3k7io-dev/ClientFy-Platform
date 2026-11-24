import crypto from 'node:crypto';
import {Api, TelegramClient} from 'telegram';
import {StringSession} from 'telegram/sessions/index.js';
import {decryptAesGcm, encryptAesGcm} from './security.ts';
import {mutateDb, mutateUserAutosend, readDb, readUserAutosend} from './storage.ts';
import type {SentOutreachLog} from './types.ts';

interface PendingAuthState {
  client: TelegramClient;
  phone: string;
  phoneCodeHash: string;
  needsPassword: boolean;
  expiresAt: number;
}

export interface MtprotoLoginProfile {
  tgId: string;
  phone: string;
  encryptedSession: string;
  displayName: string | null;
  username: string | null;
}

const pendingAuthMap = new Map<string, PendingAuthState>();
const pendingWebLoginMap = new Map<string, PendingAuthState>();
const activeCampaignStops = new Set<string>();
const runningCampaigns = new Set<string>();

function resolveMtprotoCredentials(): {apiId: number; apiHash: string} | null {
  const apiId = Number(process.env.TELEGRAM_API_ID?.trim() || 0);
  const apiHash = process.env.TELEGRAM_API_HASH?.trim() || '';
  if (!Number.isFinite(apiId) || apiId <= 0 || !apiHash) {
    return null;
  }
  return {apiId, apiHash};
}

export function isMtprotoConfigured(): boolean {
  return resolveMtprotoCredentials() !== null;
}

function maskPhone(phone: string): string {
  const clean = phone.replace(/\s+/g, '');
  if (clean.length <= 6) return clean;
  return `${clean.slice(0, 4)} ••• ${clean.slice(-3)}`;
}

function normalizePhone(raw: string): string {
  const trimmed = raw.trim().replace(/[^\d+]/g, '');
  if (!trimmed) return '';
  return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
}

async function cleanupPendingAuth(userId: string): Promise<void> {
  const existing = pendingAuthMap.get(userId);
  if (!existing) return;
  pendingAuthMap.delete(userId);
  await existing.client.disconnect().catch(() => {});
}

async function cleanupPendingWebLogin(loginId: string): Promise<void> {
  const existing = pendingWebLoginMap.get(loginId);
  if (!existing) return;
  pendingWebLoginMap.delete(loginId);
  await existing.client.disconnect().catch(() => {});
}

// Periodic cleanup of stale auth sessions
setInterval(() => {
  const now = Date.now();
  for (const [uid, st] of pendingAuthMap.entries()) {
    if (st.expiresAt < now) {
      pendingAuthMap.delete(uid);
      void st.client.disconnect().catch(() => {});
    }
  }
  for (const [lid, st] of pendingWebLoginMap.entries()) {
    if (st.expiresAt < now) {
      pendingWebLoginMap.delete(lid);
      void st.client.disconnect().catch(() => {});
    }
  }
}, 60_000).unref();

export interface UserbotAccountStatus {
  apiConfigured: boolean;
  connected: boolean;
  phoneMasked: string | null;
  displayName: string | null;
  username: string | null;
  connectedAt: string | null;
  pendingStep: 'idle' | 'code' | 'password';
  campaignRunning: boolean;
}

export async function getUserbotStatus(userId: string): Promise<UserbotAccountStatus> {
  const db = await readDb();
  const user = db.users[userId];
  const sess = user?.telegramSession ?? null;
  const pending = pendingAuthMap.get(userId);
  const pendingStep: 'idle' | 'code' | 'password' =
    pending && pending.expiresAt > Date.now()
      ? pending.needsPassword
        ? 'password'
        : 'code'
      : 'idle';

  return {
    apiConfigured: isMtprotoConfigured(),
    connected: Boolean(sess?.encryptedSession),
    phoneMasked: sess?.phone ? maskPhone(sess.phone) : null,
    displayName: sess?.displayName ?? null,
    username: sess?.username ?? null,
    connectedAt: sess?.connectedAt ?? null,
    pendingStep,
    campaignRunning: runningCampaigns.has(userId),
  };
}

export async function sendUserbotAuthCode(
  userId: string,
  rawPhone: string,
): Promise<{ok: true; phoneMasked: string} | {ok: false; error: string}> {
  const creds = resolveMtprotoCredentials();
  if (!creds) {
    console.warn('[ClientFy MTProto] TELEGRAM_API_ID/TELEGRAM_API_HASH not configured in environment.');
    return {
      ok: false,
      error: 'Авторизация по номеру временно недоступна. Попробуйте чуть позже.',
    };
  }

  const phone = normalizePhone(rawPhone);
  if (phone.length < 8 || phone.length > 20) {
    return {ok: false, error: 'Введите корректный номер телефона в формате +79991234567'};
  }

  await cleanupPendingAuth(userId);

  const client = new TelegramClient(new StringSession(''), creds.apiId, creds.apiHash, {
    connectionRetries: 3,
  });
  client.setLogLevel('none' as never);

  try {
    await client.connect();
    const sent = await client.sendCode(
      {apiId: creds.apiId, apiHash: creds.apiHash},
      phone,
    );

    pendingAuthMap.set(userId, {
      client,
      phone,
      phoneCodeHash: sent.phoneCodeHash,
      needsPassword: false,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    return {ok: true, phoneMasked: maskPhone(phone)};
  } catch (err) {
    await client.disconnect().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return {ok: false, error: `Не удалось отправить код: ${msg}`};
  }
}

async function finalizeAuthorizedClient(
  userId: string,
  client: TelegramClient,
  phone: string,
): Promise<UserbotAccountStatus> {
  const savedSession = client.session.save();
  const sessionStr = typeof savedSession === 'string' ? savedSession : '';
  const encryptedSession = encryptAesGcm(sessionStr);

  let displayName: string | null = null;
  let username: string | null = null;
  try {
    const me = await client.getMe();
    if (me && 'firstName' in me) {
      displayName = [me.firstName, me.lastName].filter(Boolean).join(' ').trim() || null;
    }
    if (me && 'username' in me && me.username) {
      username = me.username;
    }
  } catch {
    // ignore profile fetch failure
  }

  await mutateDb((db) => {
    const u = db.users[userId];
    if (!u) return;
    u.telegramSession = {
      phone,
      encryptedSession,
      displayName,
      username,
      connectedAt: new Date().toISOString(),
    };
  });

  await cleanupPendingAuth(userId);
  return getUserbotStatus(userId);
}

export async function verifyUserbotAuthCode(
  userId: string,
  rawCode: string,
): Promise<
  | {ok: true; step: 'connected'; status: UserbotAccountStatus}
  | {ok: true; step: 'password'}
  | {ok: false; error: string}
> {
  const pending = pendingAuthMap.get(userId);
  if (!pending || pending.expiresAt < Date.now()) {
    await cleanupPendingAuth(userId);
    return {ok: false, error: 'Сессия ввода кода истекла. Запросите код заново.'};
  }

  const code = rawCode.replace(/[^\d]/g, '').trim();
  if (code.length < 4 || code.length > 8) {
    return {ok: false, error: 'Введите цифровой код из Telegram'};
  }

  try {
    await pending.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: pending.phone,
        phoneCodeHash: pending.phoneCodeHash,
        phoneCode: code,
      }),
    );

    const status = await finalizeAuthorizedClient(userId, pending.client, pending.phone);
    return {ok: true, step: 'connected', status};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('SESSION_PASSWORD_NEEDED') || msg.toLowerCase().includes('password')) {
      pending.needsPassword = true;
      return {ok: true, step: 'password'};
    }
    if (msg.includes('PHONE_CODE_INVALID')) {
      return {ok: false, error: 'Неверный код подтверждения'};
    }
    if (msg.includes('PHONE_CODE_EXPIRED')) {
      await cleanupPendingAuth(userId);
      return {ok: false, error: 'Срок действия кода истёк. Запросите новый код.'};
    }
    return {ok: false, error: msg};
  }
}

export async function verifyUserbotAuthPassword(
  userId: string,
  password: string,
): Promise<
  | {ok: true; status: UserbotAccountStatus}
  | {ok: false; error: string}
> {
  const creds = resolveMtprotoCredentials();
  const pending = pendingAuthMap.get(userId);
  if (!creds || !pending || pending.expiresAt < Date.now()) {
    await cleanupPendingAuth(userId);
    return {ok: false, error: 'Сессия авторизации истекла. Начните заново.'};
  }
  if (!password) {
    return {ok: false, error: 'Введите пароль двухфакторной защиты Telegram'};
  }

  try {
    await pending.client.signInWithPassword(
      {apiId: creds.apiId, apiHash: creds.apiHash},
      {
        password: async () => password,
        onError: async (err) => {
          throw err;
        },
      },
    );

    const status = await finalizeAuthorizedClient(userId, pending.client, pending.phone);
    return {ok: true, status};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('PASSWORD_HASH_INVALID')) {
      return {ok: false, error: 'Неверный облачный пароль 2FA'};
    }
    return {ok: false, error: msg};
  }
}

export async function disconnectUserbot(userId: string): Promise<UserbotAccountStatus> {
  activeCampaignStops.add(userId);
  await cleanupPendingAuth(userId);
  await mutateDb((db) => {
    const u = db.users[userId];
    if (u) {
      u.telegramSession = null;
    }
  });
  return getUserbotStatus(userId);
}

function extractTelegramTarget(contactValue: string): string | null {
  const v = contactValue.trim();
  if (!v) return null;
  if (v.startsWith('@')) return v.slice(1);
  const m = v.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{4,})/i);
  if (m?.[1]) return m[1];
  if (/^[A-Za-z0-9_]{4,}$/.test(v)) return v;
  return null;
}

function formatSubsShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function sleepInterruptible(ms: number, userId: string): Promise<void> {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => {
      if (activeCampaignStops.has(userId) || Date.now() >= end) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(500, end - Date.now()));
    };
    tick();
  });
}

export async function startRealOutreachCampaign(
  userId: string,
  templateId: string,
  delayMinSec = 20,
  delayMaxSec = 30,
): Promise<{ok: true} | {ok: false; error: string}> {
  if (runningCampaigns.has(userId)) {
    return {ok: false, error: 'Рассылка уже запущена'};
  }

  const creds = resolveMtprotoCredentials();
  if (!creds) {
    console.warn('[ClientFy MTProto] TELEGRAM_API_ID/TELEGRAM_API_HASH not configured in environment.');
    return {
      ok: false,
      error: 'Сервис рассылки временно недоступен.',
    };
  }

  const db = await readDb();
  const user = db.users[userId];
  const encryptedSession = user?.telegramSession?.encryptedSession;
  if (!encryptedSession) {
    return {ok: false, error: 'Сначала подключите свой Telegram-аккаунт для рассылки'};
  }

  const sessionStr = decryptAesGcm(encryptedSession);
  if (!sessionStr) {
    return {ok: false, error: 'Не удалось расшифровать сохранённую сессию. Переподключите аккаунт.'};
  }

  const {data} = await readUserAutosend(userId);
  const template = data.templates.find((t) => t.id === templateId) || data.templates[0];
  if (!template) {
    return {ok: false, error: 'Шаблон сообщения не найден'};
  }

  const queuedTg = data.contacts.filter(
    (c) => c.status === 'queued' && c.contactType === 'telegram' && extractTelegramTarget(c.contactValue),
  );
  if (queuedTg.length === 0) {
    return {ok: false, error: 'В очереди нет Telegram-контактов со статусом «В очереди»'};
  }

  const safeMin = Math.max(5, Math.min(120, Math.trunc(delayMinSec)));
  const safeMax = Math.max(safeMin, Math.min(180, Math.trunc(delayMaxSec)));

  activeCampaignStops.delete(userId);
  runningCampaigns.add(userId);

  await mutateUserAutosend(userId, (d) => {
    d.campaign.running = true;
    d.campaign.stopRequested = false;
    d.campaign.templateId = template.id;
    d.campaign.delaySecondsMin = safeMin;
    d.campaign.delaySecondsMax = safeMax;
    d.campaign.startedAt = new Date().toISOString();
    d.campaign.finishedAt = null;
    d.campaign.lastMessage = `Запуск рассылки: ${queuedTg.length} Telegram-контактов`;
    return {result: true};
  });

  // Run loop in background without blocking HTTP request
  void (async () => {
    const client = new TelegramClient(new StringSession(sessionStr), creds.apiId, creds.apiHash, {
      connectionRetries: 3,
    });
    client.setLogLevel('none' as never);

    try {
      await client.connect();
      const authorized = await client.checkAuthorization();
      if (!authorized) {
        await mutateUserAutosend(userId, (d) => {
          d.campaign.running = false;
          d.campaign.finishedAt = new Date().toISOString();
          d.campaign.lastMessage = 'Сессия Telegram отозвана — требуется повторный вход';
          return {result: true};
        });
        return;
      }

      for (let i = 0; i < queuedTg.length; i += 1) {
        if (activeCampaignStops.has(userId)) {
          await mutateUserAutosend(userId, (d) => {
            d.campaign.lastMessage = 'Рассылка остановлена пользователем';
            return {result: true};
          });
          break;
        }

        const targetContact = queuedTg[i];
        const username = extractTelegramTarget(targetContact.contactValue);
        if (!username) continue;

        const chUrl =
          targetContact.channelUrl ||
          (targetContact.channelId
            ? `https://www.youtube.com/channel/${targetContact.channelId}`
            : targetContact.contactValue);

        const messageText = template.body
          .replace(/\{title\}/g, targetContact.channelTitle)
          .replace(/\{url\}/g, chUrl)
          .replace(/\{\{channel\}\}/g, targetContact.channelTitle)
          .replace(/\{\{handle\}\}/g, targetContact.handle || targetContact.channelTitle)
          .replace(/\{\{subs\}\}/g, formatSubsShort(targetContact.subscriberCount));

        let sendSuccess = false;
        let detail = '';

        try {
          await client.sendMessage(username, {message: messageText});
          sendSuccess = true;
          detail = `Отправлено @${username}`;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          detail = msg;
          // Handle Telegram FloodWaitError gracefully
          const waitMatch = msg.match(/A wait of (\d+) seconds/i);
          if (waitMatch?.[1]) {
            const waitSec = Math.min(300, Number(waitMatch[1]) + 2);
            await mutateUserAutosend(userId, (d) => {
              d.campaign.lastMessage = `Ограничение Telegram FloodWait: пауза ${waitSec} сек.`;
              return {result: true};
            });
            await sleepInterruptible(waitSec * 1000, userId);
          }
        }

        const nowIso = new Date().toISOString();
        await mutateUserAutosend(userId, (d, logs) => {
          const rec = d.contacts.find((c) => c.id === targetContact.id);
          if (rec) {
            rec.status = sendSuccess ? 'sent' : 'skipped';
            rec.sentAt = sendSuccess ? nowIso : null;
          }
          if (sendSuccess) {
            d.campaign.sentCount += 1;
            d.campaign.lastMessage = `Отправлено @${username} (${i + 1}/${queuedTg.length})`;
          } else {
            d.campaign.failedCount += 1;
            d.campaign.lastMessage = `Ошибка @${username}: ${detail.slice(0, 80)}`;
          }

          const logEntry: SentOutreachLog = {
            id: `log_${crypto.randomBytes(5).toString('hex')}`,
            contactId: targetContact.id,
            channelTitle: targetContact.channelTitle,
            contactValue: targetContact.contactValue,
            templateName: template.name,
            status: sendSuccess ? 'sent' : 'failed',
            detail,
            timestamp: nowIso,
          };

          return {
            result: true,
            nextSentLogs: [logEntry, ...logs],
          };
        });

        if (i < queuedTg.length - 1 && !activeCampaignStops.has(userId)) {
          const delaySec =
            safeMin + Math.floor(Math.random() * (safeMax - safeMin + 1));
          await sleepInterruptible(delaySec * 1000, userId);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await mutateUserAutosend(userId, (d) => {
        d.campaign.lastMessage = `Сбой рассылки: ${msg.slice(0, 100)}`;
        return {result: true};
      });
    } finally {
      await client.disconnect().catch(() => {});
      runningCampaigns.delete(userId);
      activeCampaignStops.delete(userId);
      await mutateUserAutosend(userId, (d) => {
        d.campaign.running = false;
        d.campaign.stopRequested = false;
        d.campaign.finishedAt = new Date().toISOString();
        return {result: true};
      });
    }
  })();

  return {ok: true};
}

export async function stopRealOutreachCampaign(userId: string): Promise<void> {
  activeCampaignStops.add(userId);
  await mutateUserAutosend(userId, (d) => {
    d.campaign.stopRequested = true;
    d.campaign.lastMessage = 'Остановка рассылки...';
    return {result: true};
  });
}

async function extractMtprotoProfile(
  client: TelegramClient,
  phone: string,
): Promise<MtprotoLoginProfile | null> {
  const saved = client.session.save();
  const sessionStr = typeof saved === 'string' ? saved : '';
  const encryptedSession = encryptAesGcm(sessionStr);

  const me = await client.getMe().catch(() => null);
  if (!me || !('id' in me)) return null;

  const displayName =
    'firstName' in me
      ? [me.firstName, 'lastName' in me ? me.lastName : ''].filter(Boolean).join(' ').trim() ||
        null
      : null;
  const username = 'username' in me && me.username ? String(me.username) : null;

  return {
    tgId: String(me.id),
    phone,
    encryptedSession,
    displayName,
    username,
  };
}

export async function startMtprotoLoginChallenge(
  rawPhone: string,
): Promise<{ok: true; loginId: string; phoneMasked: string} | {ok: false; error: string}> {
  const creds = resolveMtprotoCredentials();
  if (!creds) {
    console.warn('[ClientFy MTProto] TELEGRAM_API_ID/TELEGRAM_API_HASH not configured in environment.');
    return {
      ok: false,
      error: 'Вход по номеру временно недоступен. Используйте вход через Telegram-бота.',
    };
  }

  const phone = normalizePhone(rawPhone);
  if (phone.length < 8 || phone.length > 20) {
    return {ok: false, error: 'Введите корректный номер телефона в формате +79991234567'};
  }

  const client = new TelegramClient(new StringSession(''), creds.apiId, creds.apiHash, {
    connectionRetries: 3,
  });
  client.setLogLevel('none' as never);

  try {
    await client.connect();
    const sent = await client.sendCode({apiId: creds.apiId, apiHash: creds.apiHash}, phone);
    const loginId = crypto.randomBytes(16).toString('hex');

    pendingWebLoginMap.set(loginId, {
      client,
      phone,
      phoneCodeHash: sent.phoneCodeHash,
      needsPassword: false,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    return {ok: true, loginId, phoneMasked: maskPhone(phone)};
  } catch (err) {
    await client.disconnect().catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    return {ok: false, error: `Не удалось отправить код: ${msg}`};
  }
}

export async function verifyMtprotoLoginCode(
  loginId: string,
  rawCode: string,
): Promise<
  | {ok: true; step: 'connected'; profile: MtprotoLoginProfile}
  | {ok: true; step: 'password'}
  | {ok: false; error: string}
> {
  const pending = pendingWebLoginMap.get(loginId);
  if (!pending || pending.expiresAt < Date.now()) {
    await cleanupPendingWebLogin(loginId);
    return {ok: false, error: 'Сессия ввода кода истекла. Запросите код заново.'};
  }

  const code = rawCode.replace(/[^\d]/g, '').trim();
  if (code.length < 4 || code.length > 8) {
    return {ok: false, error: 'Введите цифровой код из Telegram'};
  }

  try {
    await pending.client.invoke(
      new Api.auth.SignIn({
        phoneNumber: pending.phone,
        phoneCodeHash: pending.phoneCodeHash,
        phoneCode: code,
      }),
    );

    const profile = await extractMtprotoProfile(pending.client, pending.phone);
    await cleanupPendingWebLogin(loginId);
    if (!profile) {
      return {ok: false, error: 'Не удалось получить профиль Telegram'};
    }
    return {ok: true, step: 'connected', profile};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('SESSION_PASSWORD_NEEDED') || msg.toLowerCase().includes('password')) {
      pending.needsPassword = true;
      return {ok: true, step: 'password'};
    }
    if (msg.includes('PHONE_CODE_INVALID')) {
      return {ok: false, error: 'Неверный код подтверждения'};
    }
    if (msg.includes('PHONE_CODE_EXPIRED')) {
      await cleanupPendingWebLogin(loginId);
      return {ok: false, error: 'Срок действия кода истёк. Запросите новый код.'};
    }
    return {ok: false, error: msg};
  }
}

export async function verifyMtprotoLoginPassword(
  loginId: string,
  password: string,
): Promise<{ok: true; profile: MtprotoLoginProfile} | {ok: false; error: string}> {
  const creds = resolveMtprotoCredentials();
  const pending = pendingWebLoginMap.get(loginId);
  if (!creds || !pending || pending.expiresAt < Date.now()) {
    await cleanupPendingWebLogin(loginId);
    return {ok: false, error: 'Сессия авторизации истекла. Начните заново.'};
  }
  if (!password) {
    return {ok: false, error: 'Введите облачный пароль 2FA'};
  }

  try {
    await pending.client.signInWithPassword(
      {apiId: creds.apiId, apiHash: creds.apiHash},
      {
        password: async () => password,
        onError: async (err) => {
          throw err;
        },
      },
    );

    const profile = await extractMtprotoProfile(pending.client, pending.phone);
    await cleanupPendingWebLogin(loginId);
    if (!profile) {
      return {ok: false, error: 'Не удалось получить профиль Telegram'};
    }
    return {ok: true, profile};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('PASSWORD_HASH_INVALID')) {
      return {ok: false, error: 'Неверный облачный пароль 2FA'};
    }
    return {ok: false, error: msg};
  }
}
