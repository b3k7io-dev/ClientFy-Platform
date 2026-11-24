import React, {useState} from 'react';
import {AnimatePresence, motion} from 'motion/react';
import {
  ShieldCheck,
  KeyRound,
  LogIn,
  ExternalLink,
  Phone,
  Delete,
  Shield,
} from 'lucide-react';
import {apiRequest, ApiError, isSafeHttpUrl} from '../api';
import type {AuthStatusResponse, PublicUserProfile} from '../types';

interface AuthViewProps {
  authStatus: AuthStatusResponse;
  tgAuthError?: string | null;
  onAuthenticated: (token: string, user: PublicUserProfile) => void;
}

export function AuthView({authStatus, tgAuthError, onAuthenticated}: AuthViewProps) {
  const [mode, setMode] = useState<'telegram' | 'login' | 'register' | 'claim'>(
    authStatus.needsAdminClaim ? 'claim' : 'telegram',
  );

  // Telegram Phone + Code + 2FA Password state
  const [tgStep, setTgStep] = useState<'phone' | 'code' | 'password'>('phone');
  const [tgPhone, setTgPhone] = useState('');
  const [tgLoginId, setTgLoginId] = useState('');
  const [tgPhoneMasked, setTgPhoneMasked] = useState('');
  const [tgCode, setTgCode] = useState('');
  const [tg2faPassword, setTg2faPassword] = useState('');

  // Standard password auth state
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleTgSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest<{loginId: string; phoneMasked: string}>(
        '/api/auth/telegram-phone/send-code',
        {
          method: 'POST',
          body: {phone: tgPhone.trim()},
        },
      );
      setTgLoginId(res.loginId);
      setTgPhoneMasked(res.phoneMasked);
      setTgCode('');
      setTgStep('code');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ошибка отправки кода');
    } finally {
      setLoading(false);
    }
  };

  const handleTgVerifyCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (tgCode.length < 4) return;
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest<
        | {step: 'password'}
        | {step: 'connected'; token: string; user: PublicUserProfile}
      >('/api/auth/telegram-phone/verify-code', {
        method: 'POST',
        body: {loginId: tgLoginId, code: tgCode},
      });
      if (res.step === 'password') {
        setTg2faPassword('');
        setTgStep('password');
      } else {
        onAuthenticated(res.token, res.user);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Неверный код');
    } finally {
      setLoading(false);
    }
  };

  const handleTgVerifyPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiRequest<{
        step: 'connected';
        token: string;
        user: PublicUserProfile;
      }>('/api/auth/telegram-phone/verify-password', {
        method: 'POST',
        body: {loginId: tgLoginId, password: tg2faPassword},
      });
      onAuthenticated(res.token, res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Неверный пароль 2FA');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitStandard = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === 'claim') {
        const res = await apiRequest<{token: string; user: PublicUserProfile}>(
          '/api/auth/claim-admin',
          {
            method: 'POST',
            body: {username: username.trim() || 'admin', password},
          },
        );
        onAuthenticated(res.token, res.user);
      } else if (mode === 'register') {
        const res = await apiRequest<{token: string; user: PublicUserProfile}>(
          '/api/auth/register',
          {
            method: 'POST',
            body: {username, email, password},
          },
        );
        onAuthenticated(res.token, res.user);
      } else {
        const res = await apiRequest<{token: string; user: PublicUserProfile}>(
          '/api/auth/login',
          {
            method: 'POST',
            body: {username, password},
          },
        );
        onAuthenticated(res.token, res.user);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Ошибка подключения');
    } finally {
      setLoading(false);
    }
  };

  const botUsername = authStatus.botStatus.username || 'demov2clientfybot';
  const botUrl = `https://t.me/${botUsername}`;

  return (
    <div className="min-h-screen bg-[#050507] relative overflow-hidden flex items-center justify-center px-4 py-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-48 left-1/3 h-96 w-96 rounded-full bg-white/[0.03] blur-[150px]"
      />

      <motion.div
        initial={{opacity: 0, y: 12}}
        animate={{opacity: 1, y: 0}}
        transition={{duration: 0.28, ease: [0.16, 1, 0.3, 1]}}
        className="relative w-full max-w-md liquid-glass-elevated rounded-2xl p-6 sm:p-7 space-y-6"
      >
        <div className="flex items-center justify-between">
          <div className="font-display text-xl font-bold tracking-tight text-white">ClientFy</div>
          {isSafeHttpUrl(botUrl) && (
            <a
              href={botUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="h-8 px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-xs text-neutral-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
            >
              <span>@{botUsername}</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>

        <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.07]">
          {authStatus.needsAdminClaim && (
            <button
              type="button"
              onClick={() => {
                setMode('claim');
                setError(null);
              }}
              className={`flex-1 py-2 px-2.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 flex items-center justify-center gap-1 ${
                mode === 'claim' ? 'bg-white text-black' : 'text-neutral-400 hover:text-white'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Админ</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setMode('telegram');
              setError(null);
            }}
            className={`flex-1 py-2 px-2.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 flex items-center justify-center gap-1 ${
              mode === 'telegram' ? 'bg-white text-black' : 'text-neutral-400 hover:text-white'
            }`}
          >
            <Phone className="w-3.5 h-3.5" />
            <span>Telegram</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('login');
              setError(null);
            }}
            className={`flex-1 py-2 px-2.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 flex items-center justify-center gap-1 ${
              mode === 'login' ? 'bg-white text-black' : 'text-neutral-400 hover:text-white'
            }`}
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>Логин</span>
          </button>
        </div>

        <AnimatePresence mode="wait">
          {mode === 'telegram' ? (
            <motion.div
              key={`tg-${tgStep}`}
              initial={{opacity: 0, y: 6}}
              animate={{opacity: 1, y: 0}}
              exit={{opacity: 0, y: -6}}
              transition={{duration: 0.16}}
              className="space-y-4"
            >
              {tgStep === 'phone' ? (
                <form onSubmit={handleTgSendCode} className="space-y-4">
                  <div>
                    <label className="block text-xs text-neutral-400 mb-1.5">
                      Номер Telegram
                    </label>
                    <input
                      type="tel"
                      required
                      value={tgPhone}
                      onChange={(e) => setTgPhone(e.target.value)}
                      placeholder="+79991234567"
                      className="rgb-focus-ring w-full h-11 px-3.5 rounded-xl bg-black/50 border border-white/10 text-sm font-mono text-white placeholder:text-neutral-600 focus:outline-none"
                    />
                  </div>
                  {error && (
                    <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-xs text-red-300">
                      {error}
                    </div>
                  )}
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full h-11 rounded-xl bg-white hover:bg-neutral-200 text-sm font-semibold text-black transition-colors disabled:opacity-50"
                  >
                    {loading ? 'Отправка кода...' : 'Получить код'}
                  </button>
                </form>
              ) : tgStep === 'code' ? (
                <form onSubmit={handleTgVerifyCode} className="space-y-3">
                  <div className="text-xs text-neutral-400">
                    Код отправлен на <span className="font-mono text-white">{tgPhoneMasked}</span>
                  </div>
                  <input
                    type="text"
                    inputMode="numeric"
                    required
                    value={tgCode}
                    onChange={(e) => setTgCode(e.target.value.replace(/[^\d]/g, '').slice(0, 8))}
                    placeholder="Код из Telegram"
                    className="rgb-focus-ring w-full h-11 px-3.5 rounded-xl bg-black/50 border border-white/10 text-base font-mono tracking-widest text-white placeholder:text-neutral-600 focus:outline-none"
                  />

                  <div className="grid grid-cols-6 gap-1.5">
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setTgCode((prev) => (prev + d).slice(0, 8))}
                        className="h-9 rounded-lg bg-white/[0.04] hover:bg-white/[0.1] border border-white/[0.08] text-xs font-mono text-white transition-colors"
                      >
                        {d}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setTgCode((prev) => prev.slice(0, -1))}
                      className="h-9 rounded-lg bg-white/[0.04] hover:bg-white/[0.1] border border-white/[0.08] text-neutral-300 flex items-center justify-center transition-colors"
                    >
                      <Delete className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTgStep('phone');
                        setTgCode('');
                        setError(null);
                      }}
                      className="h-9 rounded-lg bg-white/[0.04] hover:bg-white/[0.1] border border-white/[0.08] text-[11px] text-neutral-400 hover:text-white transition-colors"
                    >
                      Сброс
                    </button>
                  </div>

                  {error && (
                    <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-xs text-red-300">
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading || tgCode.length < 4}
                    className="w-full h-11 rounded-xl bg-white hover:bg-neutral-200 text-sm font-semibold text-black transition-colors disabled:opacity-40"
                  >
                    {loading ? 'Проверка...' : 'Войти'}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleTgVerifyPassword} className="space-y-4">
                  <div className="flex items-center gap-1.5 text-xs text-neutral-300">
                    <Shield className="w-3.5 h-3.5" />
                    <span>Облачный пароль Telegram (2FA)</span>
                  </div>
                  <input
                    type="password"
                    required
                    value={tg2faPassword}
                    onChange={(e) => setTg2faPassword(e.target.value)}
                    placeholder="Пароль 2FA"
                    className="rgb-focus-ring w-full h-11 px-3.5 rounded-xl bg-black/50 border border-white/10 text-sm text-white placeholder:text-neutral-600 focus:outline-none"
                  />
                  {error && (
                    <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-xs text-red-300">
                      {error}
                    </div>
                  )}
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full h-11 rounded-xl bg-white hover:bg-neutral-200 text-sm font-semibold text-black transition-colors disabled:opacity-50"
                  >
                    {loading ? 'Вход...' : 'Подтвердить пароль'}
                  </button>
                </form>
              )}
            </motion.div>
          ) : (
            <motion.form
              key={mode}
              initial={{opacity: 0, y: 6}}
              animate={{opacity: 1, y: 0}}
              exit={{opacity: 0, y: -6}}
              transition={{duration: 0.16}}
              onSubmit={handleSubmitStandard}
              className="space-y-4"
            >
              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">
                  {mode === 'claim' ? 'Логин администратора' : 'Логин'}
                </label>
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={mode === 'claim' ? 'admin' : 'username или admin'}
                  className="rgb-focus-ring w-full h-11 px-3.5 rounded-xl bg-black/50 border border-white/10 text-sm text-white placeholder:text-neutral-600 focus:outline-none"
                />
              </div>

              {mode === 'register' && (
                <div>
                  <label className="block text-xs text-neutral-400 mb-1.5">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@domain.com"
                    className="rgb-focus-ring w-full h-11 px-3.5 rounded-xl bg-black/50 border border-white/10 text-sm text-white placeholder:text-neutral-600 focus:outline-none"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs text-neutral-400 mb-1.5">Пароль</label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Минимум 6 символов"
                  className="rgb-focus-ring w-full h-11 px-3.5 rounded-xl bg-black/50 border border-white/10 text-sm text-white placeholder:text-neutral-600 focus:outline-none"
                />
              </div>

              {error && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-xs text-red-300">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full h-11 rounded-xl bg-white hover:bg-neutral-200 text-sm font-semibold text-black transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <KeyRound className="w-4 h-4" />
                <span>
                  {loading
                    ? 'Выполняется...'
                    : mode === 'claim'
                      ? 'Создать админа'
                      : mode === 'register'
                        ? 'Создать аккаунт'
                        : 'Войти'}
                </span>
              </button>

              <div className="text-center">
                <button
                  type="button"
                  onClick={() => setMode(mode === 'register' ? 'login' : 'register')}
                  className="text-xs text-neutral-400 hover:text-white underline-offset-4 hover:underline"
                >
                  {mode === 'register' ? 'Уже есть аккаунт? Войти' : 'Создать новый аккаунт'}
                </button>
              </div>
            </motion.form>
          )}
        </AnimatePresence>

        {tgAuthError && (
          <div className="p-3 rounded-xl bg-white/[0.04] border border-white/10 text-xs text-neutral-300">
            {tgAuthError}
          </div>
        )}

        <div className="pt-3 border-t border-white/[0.07] text-[11px] text-neutral-500 leading-relaxed">
          {authStatus.needsAdminClaim
            ? 'Откройте вкладку «Админ», чтобы задать начальный пароль.'
            : `Бот @${botUsername} открывает профиль автоматически по Telegram.`}
        </div>
      </motion.div>
    </div>
  );
}
