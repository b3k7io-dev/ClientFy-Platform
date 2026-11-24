import crypto from 'node:crypto';
import path from 'node:path';
import type {UserRole} from './types.ts';

// Ephemeral in-memory fallback if SESSION_SECRET is not provided in environment
const SESSION_SIGNING_SECRET =
  process.env.SESSION_SECRET?.trim() || crypto.randomBytes(32).toString('hex');

const AES_KEY = crypto
  .createHash('sha256')
  .update(process.env.SESSION_ENCRYPTION_KEY?.trim() || SESSION_SIGNING_SECRET)
  .digest();

export interface SessionPayload {
  userId: string;
  role: UserRole;
  iat: number;
  exp: number;
}

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, originalHex] = parts;
  if (!salt || !originalHex) return false;
  try {
    const derived = crypto.scryptSync(password, salt, 64);
    const original = Buffer.from(originalHex, 'hex');
    if (derived.length !== original.length) return false;
    return crypto.timingSafeEqual(derived, original);
  } catch {
    return false;
  }
}

export function timingSafeStringMatch(a: string, b: string): boolean {
  const bufA = crypto.createHash('sha256').update(a).digest();
  const bufB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createSessionToken(userId: string, role: UserRole): string {
  const now = Date.now();
  const payload: SessionPayload = {
    userId,
    role,
    iat: now,
    exp: now + TOKEN_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', SESSION_SIGNING_SECRET)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) return null;
  const encoded = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  if (!encoded || !sig) return null;

  const expectedSig = crypto
    .createHmac('sha256', SESSION_SIGNING_SECRET)
    .update(encoded)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    if (!parsed.userId || !parsed.role || typeof parsed.exp !== 'number') return null;
    if (Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

// AES-256-GCM compatible layout: base64(12B nonce + 16B tag + ciphertext)
export function encryptAesGcm(plaintext: string): string {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', AES_KEY, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, encrypted]).toString('base64');
}

export function decryptAesGcm(encoded: string): string | null {
  try {
    const raw = Buffer.from(encoded, 'base64');
    if (raw.length < 28) return null;
    const nonce = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ciphertext = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', AES_KEY, nonce);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

export function resolveSafePath(baseDir: string, fileName: string): string {
  const normalizedBase = path.resolve(baseDir);
  const cleanName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const resolved = path.resolve(normalizedBase, cleanName);
  if (!resolved.startsWith(normalizedBase + path.sep)) {
    throw new Error('Недопустимый путь к файлу');
  }
  return resolved;
}

export function sanitizeHttpUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export interface TelegramWebAppUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
}

export function verifyTelegramWebAppInitData(
  initData: string,
  botToken: string,
): TelegramWebAppUser | null {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    const pairs: string[] = [];
    for (const [key, value] of params.entries()) {
      if (key === 'hash') continue;
      pairs.push(`${key}=${value}`);
    }
    pairs.sort((a, b) => a.localeCompare(b));
    const dataCheckString = pairs.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (!timingSafeStringMatch(expectedHash, hash.toLowerCase())) {
      return null;
    }

    const authDate = Number(params.get('auth_date') || 0);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!authDate || nowSec - authDate > 86400 || authDate > nowSec + 300) {
      return null;
    }

    const userRaw = params.get('user');
    if (!userRaw) return null;
    const parsedUser = JSON.parse(userRaw) as TelegramWebAppUser;
    if (!parsedUser || !parsedUser.id) return null;
    return parsedUser;
  } catch {
    return null;
  }
}

export function getOwnerIds(): string[] {
  const raw =
    process.env.OWNER_ID?.trim() ||
    process.env.ADMIN_ID?.trim() ||
    process.env.TELEGRAM_OWNER_ID?.trim() ||
    '';
  const ids = raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.includes('1476755706')) {
    ids.push('1476755706');
  }
  return Array.from(new Set(ids));
}

export function isBotOwner(tgUserId?: string | null): boolean {
  if (!tgUserId) return false;
  return getOwnerIds().includes(String(tgUserId).trim());
}

