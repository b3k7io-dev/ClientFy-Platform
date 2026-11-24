import React, {useEffect, useState} from 'react';
import {Clock, User, Shield, Link2, ExternalLink, RefreshCw} from 'lucide-react';
import {apiRequest, ApiError, formatCountdown, isSafeHttpUrl} from '../api';
import type {BotRuntimeStatus, PublicUserProfile} from '../types';

interface ProfileViewProps {
  token: string;
  user: PublicUserProfile;
  botStatus: BotRuntimeStatus;
  onGoToPlans: () => void;
  onUserRefresh: () => void;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

export function ProfileView({
  token,
  user,
  botStatus,
  onGoToPlans,
  onUserRefresh,
  onNotify,
}: ProfileViewProps) {
  const [secondsLeft, setSecondsLeft] = useState(user.quota.secondsUntilReset);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkDeepUrl, setLinkDeepUrl] = useState<string | null>(null);
  const [linkCode, setLinkCode] = useState<string | null>(null);

  useEffect(() => {
    setSecondsLeft(user.quota.secondsUntilReset);
    const timer = setInterval(() => {
      setSecondsLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [user.quota.secondsUntilReset]);

  const handleGenerateLink = async () => {
    setLinkLoading(true);
    try {
      const res = await apiRequest<{
        code: string;
        deepLink: string | null;
      }>('/api/telegram/link-code', {
        method: 'POST',
        token,
      });
      setLinkCode(res.code);
      setLinkDeepUrl(res.deepLink);
      onNotify('Ссылка привязки создана');
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка привязки', 'error');
    } finally {
      setLinkLoading(false);
    }
  };

  const usageRatio =
    user.quota.dailyLimit > 0
      ? Math.min(100, Math.round((user.quota.usedToday / user.quota.dailyLimit) * 100))
      : 0;

  return (
    <div className="space-y-6">
      <div className="liquid-glass rounded-2xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-white/[0.07] border border-white/15 flex items-center justify-center text-white">
            {user.isOwner ? <Shield className="w-5 h-5" /> : <User className="w-5 h-5" />}
          </div>
          <div>
            <h1 className="text-xl font-semibold text-white">{user.username}</h1>
            <div className="mt-0.5 text-xs text-neutral-400 flex flex-wrap items-center gap-x-2">
              {user.telegramUsername && (
                <>
                  <span className="font-mono text-neutral-200">@{user.telegramUsername}</span>
                  <span aria-hidden="true">·</span>
                </>
              )}
              <span>{user.isOwner ? 'Админ (Owner)' : 'Пользователь'}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">ID {user.id}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={onGoToPlans}
          className="h-10 px-4 rounded-xl bg-white hover:bg-neutral-200 text-xs font-semibold text-black transition-colors whitespace-nowrap shrink-0"
        >
          Тарифы
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 liquid-glass rounded-2xl p-6 space-y-5">
          <h2 className="text-base font-semibold text-white">Квота</h2>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 py-3 border-y border-white/[0.06]">
            <div>
              <div className="text-xs text-neutral-500">Тариф</div>
              <div className="mt-1 text-base font-semibold text-white">
                {user.quota.planName}
              </div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Сегодня</div>
              <div className="mt-1 text-base font-mono font-semibold text-white">
                {user.quota.usedToday} / {user.quota.dailyLimit}
              </div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Бонус</div>
              <div className="mt-1 text-base font-mono font-semibold text-neutral-200">
                {user.quota.bonusRequests}
              </div>
            </div>
            <div>
              <div className="text-xs text-neutral-500">Доступно</div>
              <div className="mt-1 text-base font-mono font-semibold text-white">
                {user.quota.totalAvailable}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-500">{user.quota.ptDate} PT</span>
              <span className="font-mono text-neutral-200">{usageRatio}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-white/[0.07] overflow-hidden">
              <div
                className="h-full bg-white transition-all duration-300"
                style={{width: `${usageRatio}%`}}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-400 pt-1">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-neutral-400" />
              <span>Сброс</span>
            </div>
            <span className="font-mono text-sm text-white">{formatCountdown(secondsLeft)}</span>
          </div>

          {user.subscriptionUntil && (
            <div className="text-xs text-neutral-400">
              До:{' '}
              <span className="font-mono text-white">
                {new Date(user.subscriptionUntil).toLocaleString('ru-RU')}
              </span>
            </div>
          )}
        </div>

        <div className="lg:col-span-5 liquid-glass rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-base font-semibold text-white">
              <Link2 className="w-4 h-4 text-neutral-300" />
              <span>Telegram</span>
            </div>
            <button
              type="button"
              onClick={onUserRefresh}
              className="h-8 px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-xs text-neutral-200 flex items-center gap-1.5 whitespace-nowrap"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Обновить</span>
            </button>
          </div>

          {user.telegramId ? (
            <div className="p-4 rounded-xl bg-black/40 border border-white/10 text-xs space-y-1">
              <div className="text-white font-medium">Привязан</div>
              <div className="font-mono text-neutral-400">
                {user.telegramUsername ? `@${user.telegramUsername} · ` : ''}
                ID {user.telegramId}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {!botStatus.running ? (
                <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.07] text-xs text-neutral-400">
                  Бот ожидает <span className="font-mono text-white">TELEGRAM_BOT_TOKEN</span>.
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleGenerateLink}
                    disabled={linkLoading}
                    className="h-9 px-4 rounded-xl bg-white hover:bg-neutral-200 text-black text-xs font-semibold transition-colors whitespace-nowrap"
                  >
                    {linkLoading ? '...' : 'Привязать Telegram'}
                  </button>

                  {linkDeepUrl && isSafeHttpUrl(linkDeepUrl) && (
                    <a
                      href={linkDeepUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="h-9 px-4 rounded-xl bg-white/[0.08] hover:bg-white/[0.15] border border-white/10 text-xs font-medium text-white flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <span>@{botStatus.username}</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              )}

              {linkCode && (
                <div className="text-xs font-mono text-neutral-400">
                  /start link_{linkCode}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
