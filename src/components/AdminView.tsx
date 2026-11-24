import React, {useCallback, useEffect, useState} from 'react';
import {AnimatePresence, motion} from 'motion/react';
import {
  Users,
  CreditCard,
  Ticket,
  Settings as SettingsIcon,
  Check,
  X,
  Search,
  Megaphone,
  Send,
} from 'lucide-react';
import {apiRequest, ApiError} from '../api';
import type {
  AdminOverview,
  AppSettings,
  PaymentApplication,
  PromoCodeRecord,
  PublicUserProfile,
} from '../types';

interface AdminViewProps {
  token: string;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

export function AdminView({token, onNotify}: AdminViewProps) {
  const [tab, setTab] = useState<'users' | 'payments' | 'promos' | 'broadcast' | 'settings'>('users');
  const [overview, setOverview] = useState<AdminOverview | null>(null);

  const [users, setUsers] = useState<PublicUserProfile[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [usersLoading, setUsersLoading] = useState(false);

  const [payments, setPayments] = useState<PaymentApplication[]>([]);
  const [paymentFilter, setPaymentFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>(
    'pending',
  );
  const [previewReceipt, setPreviewReceipt] = useState<string | null>(null);

  const [promos, setPromos] = useState<PromoCodeRecord[]>([]);
  const [promoCode, setPromoCode] = useState('');
  const [promoType, setPromoType] = useState<'requests' | 'subscription'>('requests');
  const [promoPlan, setPromoPlan] = useState<'pro' | 'max'>('max');
  const [promoValue, setPromoValue] = useState(10);
  const [promoMaxUses, setPromoMaxUses] = useState(25);

  const [settings, setSettings] = useState<AppSettings | null>(null);

  const [broadcastText, setBroadcastText] = useState('');
  const [broadcastSending, setBroadcastSending] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<{
    totalRecipients: number;
    sent: number;
    failed: number;
  } | null>(null);

  const loadOverview = useCallback(async () => {
    try {
      const ov = await apiRequest<AdminOverview>('/api/admin/overview', {token});
      setOverview(ov);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка сводки', 'error');
    }
  }, [token, onNotify]);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const res = await apiRequest<{users: PublicUserProfile[]}>(
        `/api/admin/users?q=${encodeURIComponent(userSearch)}`,
        {token},
      );
      setUsers(res.users);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка пользователей', 'error');
    } finally {
      setUsersLoading(false);
    }
  }, [token, userSearch, onNotify]);

  const loadPayments = useCallback(async () => {
    try {
      const res = await apiRequest<{payments: PaymentApplication[]}>(
        `/api/admin/payments?status=${paymentFilter}`,
        {token},
      );
      setPayments(res.payments);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка заявок', 'error');
    }
  }, [token, paymentFilter, onNotify]);

  const loadPromos = useCallback(async () => {
    try {
      const res = await apiRequest<{promos: PromoCodeRecord[]}>('/api/admin/promos', {token});
      setPromos(res.promos);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка промокодов', 'error');
    }
  }, [token, onNotify]);

  const loadSettings = useCallback(async () => {
    try {
      const res = await apiRequest<{settings: AppSettings}>('/api/admin/settings', {token});
      setSettings(res.settings);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка настроек', 'error');
    }
  }, [token, onNotify]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (tab === 'users') void loadUsers();
    if (tab === 'payments') void loadPayments();
    if (tab === 'promos') void loadPromos();
    if (tab === 'settings') void loadSettings();
  }, [tab, loadUsers, loadPayments, loadPromos, loadSettings]);

  const handlePatchUser = async (
    id: string,
    payload: {
      blocked?: boolean;
      planId?: 'free' | 'pro' | 'max';
      addBonusRequests?: number;
      addDays?: number;
    },
  ) => {
    try {
      const res = await apiRequest<{user: PublicUserProfile}>(`/api/admin/users/${id}`, {
        method: 'PATCH',
        token,
        body: payload,
      });
      setUsers((prev) => prev.map((u) => (u.id === id ? res.user : u)));
      void loadOverview();
      onNotify(`Обновлено: ${res.user.username}`);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка обновления', 'error');
    }
  };

  const handleReviewPayment = async (id: string, decision: 'approved' | 'rejected') => {
    try {
      await apiRequest(`/api/admin/payments/${id}/review`, {
        method: 'POST',
        token,
        body: {decision},
      });
      void loadPayments();
      void loadOverview();
      onNotify(decision === 'approved' ? 'Одобрено' : 'Отклонено');
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка обработки', 'error');
    }
  };

  const handleCreatePromo = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiRequest('/api/admin/promos', {
        method: 'POST',
        token,
        body: {
          code: promoCode,
          type: promoType,
          plan: promoPlan,
          value: promoValue,
          maxUses: promoMaxUses,
        },
      });
      setPromoCode('');
      void loadPromos();
      void loadOverview();
      onNotify('Промокод создан');
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка промокода', 'error');
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    try {
      const res = await apiRequest<{settings: AppSettings}>('/api/admin/settings', {
        method: 'PATCH',
        token,
        body: settings,
      });
      setSettings(res.settings);
      onNotify('Сохранено');
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка сохранения', 'error');
    }
  };

  const handleBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!broadcastText.trim()) return;
    setBroadcastSending(true);
    setBroadcastResult(null);
    try {
      const res = await apiRequest<{
        ok: boolean;
        totalRecipients: number;
        sent: number;
        failed: number;
      }>('/api/admin/broadcast', {
        method: 'POST',
        token,
        body: {text: broadcastText.trim()},
      });
      setBroadcastResult({
        totalRecipients: res.totalRecipients,
        sent: res.sent,
        failed: res.failed,
      });
      setBroadcastText('');
      onNotify(`Отправлено: ${res.sent} из ${res.totalRecipients}`);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка рассылки', 'error');
    } finally {
      setBroadcastSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="liquid-glass-elevated rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Админ-панель</h1>
          <div className="mt-1 text-xs font-mono text-neutral-400">
            Бот:{' '}
            {overview?.botStatus?.running && overview.botStatus.username
              ? `@${overview.botStatus.username}`
              : 'оффлайн'}{' '}
            · YouTube: {overview?.hasYoutubeKey ? 'онлайн' : 'нет ключа'}
          </div>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.04] border border-white/[0.06] overflow-x-auto">
          {[
            {id: 'users', label: 'Пользователи', icon: Users},
            {id: 'payments', label: 'Оплаты', icon: CreditCard},
            {id: 'promos', label: 'Промокоды', icon: Ticket},
            {id: 'broadcast', label: 'Рассылка', icon: Megaphone},
            {id: 'settings', label: 'Цены и реквизиты', icon: SettingsIcon},
          ].map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() =>
                  setTab(item.id as 'users' | 'payments' | 'promos' | 'broadcast' | 'settings')
                }
                className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                  tab === item.id ? 'bg-white text-black' : 'text-neutral-400 hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {overview && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="liquid-glass rounded-2xl p-4">
            <div className="text-xs text-neutral-500">Пользователей</div>
            <div className="mt-1 text-2xl font-mono font-semibold text-white">
              {overview.totalUsers}
            </div>
          </div>
          <div className="liquid-glass rounded-2xl p-4">
            <div className="text-xs text-neutral-500">Подписчиков</div>
            <div className="mt-1 text-2xl font-mono font-semibold text-white">
              {overview.activeSubscribers}
            </div>
          </div>
          <div className="liquid-glass rounded-2xl p-4">
            <div className="text-xs text-neutral-500">Запросов ({overview.ptDate})</div>
            <div className="mt-1 text-2xl font-mono font-semibold text-white">
              {overview.searchesToday}
            </div>
          </div>
          <div className="liquid-glass rounded-2xl p-4">
            <div className="text-xs text-neutral-500">Ожидают проверки</div>
            <div className="mt-1 text-2xl font-mono font-semibold text-white">
              {overview.pendingPayments}
            </div>
          </div>
        </div>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{opacity: 0, y: 6}}
          animate={{opacity: 1, y: 0}}
          exit={{opacity: 0, y: -6}}
          transition={{duration: 0.16}}
        >
          {tab === 'users' && (
            <section className="liquid-glass rounded-2xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="relative w-full sm:w-80">
                  <Search className="w-4 h-4 text-neutral-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                    placeholder="Поиск..."
                    className="w-full h-9 pl-9 pr-3 rounded-xl bg-black/50 border border-white/10 text-xs text-white"
                  />
                </div>
                <button
                  type="button"
                  onClick={loadUsers}
                  className="h-9 px-3.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] text-xs font-medium text-white"
                >
                  Обновить
                </button>
              </div>

              {usersLoading ? (
                <div className="h-40 animate-pulse bg-white/[0.02] rounded-xl" />
              ) : users.length === 0 ? (
                <div className="py-8 text-center text-xs text-neutral-500">Пусто</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-white/[0.08] text-neutral-500">
                        <th className="py-2.5 pr-3 font-medium">Аккаунт</th>
                        <th className="py-2.5 px-3 font-medium">Тариф</th>
                        <th className="py-2.5 px-3 font-medium text-right">Квота</th>
                        <th className="py-2.5 px-3 font-medium text-right">Бонус</th>
                        <th className="py-2.5 pl-3 font-medium text-right">Действия</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.05]">
                      {users.map((u) => (
                        <tr key={u.id} className="hover:bg-white/[0.02]">
                          <td className="py-2.5 pr-3">
                            <div className="font-medium text-white">
                              {u.username}{' '}
                              {u.blocked && (
                                <span className="text-neutral-500 font-normal">· Блок</span>
                              )}
                            </div>
                            <div className="text-neutral-500 font-mono">
                              {u.telegramUsername ? `@${u.telegramUsername}` : u.email}
                            </div>
                          </td>
                          <td className="py-2.5 px-3">
                            <select
                              value={u.planId}
                              onChange={(e) =>
                                void handlePatchUser(u.id, {
                                  planId: e.target.value as 'free' | 'pro' | 'max',
                                })
                              }
                              className="h-8 px-2 rounded-lg bg-black/60 border border-white/10 text-xs text-white"
                            >
                              <option value="free">Free</option>
                              <option value="pro">Pro</option>
                              <option value="max">Max</option>
                            </select>
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-neutral-200">
                            {u.quota.usedToday}/{u.quota.dailyLimit}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono text-white">
                            {u.bonusRequests}
                          </td>
                          <td className="py-2.5 pl-3 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handlePatchUser(u.id, {addBonusRequests: 10})}
                                className="h-7 px-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-neutral-200 whitespace-nowrap"
                              >
                                +10
                              </button>
                              <button
                                type="button"
                                onClick={() => handlePatchUser(u.id, {addDays: 30})}
                                className="h-7 px-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-neutral-200 whitespace-nowrap"
                              >
                                +30д
                              </button>
                              <button
                                type="button"
                                onClick={() => handlePatchUser(u.id, {blocked: !u.blocked})}
                                className="h-7 px-2 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-neutral-300 whitespace-nowrap"
                              >
                                {u.blocked ? 'Разблок' : 'Блок'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {tab === 'payments' && (
            <section className="liquid-glass rounded-2xl p-5 space-y-4">
              <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.06] w-fit">
                {[
                  {id: 'pending', label: 'Ожидают'},
                  {id: 'approved', label: 'Одобрены'},
                  {id: 'rejected', label: 'Отклонены'},
                  {id: 'all', label: 'Все'},
                ].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() =>
                      setPaymentFilter(item.id as 'all' | 'pending' | 'approved' | 'rejected')
                    }
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${
                      paymentFilter === item.id
                        ? 'bg-white text-black'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {payments.length === 0 ? (
                <div className="py-8 text-center text-xs text-neutral-500">Заявок нет</div>
              ) : (
                <div className="divide-y divide-white/[0.06]">
                  {payments.map((p) => (
                    <div
                      key={p.id}
                      className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                    >
                      <div>
                        <div className="font-medium text-white">
                          {p.username} · {p.planId.toUpperCase()} · {p.amountLabel}
                        </div>
                        <div className="mt-0.5 text-neutral-400">
                          {p.comment || '—'} ·{' '}
                          <span className="font-mono">
                            {new Date(p.createdAt).toLocaleString('ru-RU')}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {p.receiptDataUrl && (
                          <button
                            type="button"
                            onClick={() => setPreviewReceipt(p.receiptDataUrl)}
                            className="h-8 px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-white"
                          >
                            Чек
                          </button>
                        )}

                        {p.status === 'pending' ? (
                          <>
                            <button
                              type="button"
                              onClick={() => handleReviewPayment(p.id, 'approved')}
                              className="h-8 px-3 rounded-lg bg-white hover:bg-neutral-200 text-black font-semibold flex items-center gap-1"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>Одобрить</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleReviewPayment(p.id, 'rejected')}
                              className="h-8 px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-neutral-300 flex items-center gap-1"
                            >
                              <X className="w-3.5 h-3.5" />
                              <span>Отклонить</span>
                            </button>
                          </>
                        ) : (
                          <span className="text-neutral-300">
                            {p.status === 'approved' ? 'Одобрено' : 'Отклонено'}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {previewReceipt && (
                <div
                  onClick={() => setPreviewReceipt(null)}
                  className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
                >
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="liquid-glass rounded-2xl p-4 max-w-lg w-full space-y-3"
                  >
                    <div className="flex items-center justify-between text-xs text-white">
                      <span>Чек</span>
                      <button
                        type="button"
                        onClick={() => setPreviewReceipt(null)}
                        className="text-neutral-400 hover:text-white"
                      >
                        Закрыть
                      </button>
                    </div>
                    <img
                      src={previewReceipt}
                      alt="Чек"
                      className="w-full max-h-[70vh] object-contain rounded-xl bg-black"
                    />
                  </div>
                </div>
              )}
            </section>
          )}

          {tab === 'promos' && (
            <section className="liquid-glass rounded-2xl p-5 space-y-5">
              <form onSubmit={handleCreatePromo} className="grid grid-cols-1 sm:grid-cols-6 gap-3">
                <input
                  type="text"
                  required
                  value={promoCode}
                  onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                  placeholder="КОД"
                  className="h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs font-mono text-white uppercase"
                />
                <select
                  value={promoType}
                  onChange={(e) => setPromoType(e.target.value as 'requests' | 'subscription')}
                  className="h-10 px-3 rounded-xl bg-black/55 border border-white/10 text-xs text-white"
                >
                  <option value="requests">Запросы</option>
                  <option value="subscription">Подписка</option>
                </select>
                {promoType === 'subscription' ? (
                  <select
                    value={promoPlan}
                    onChange={(e) => setPromoPlan(e.target.value as 'pro' | 'max')}
                    className="h-10 px-3 rounded-xl bg-black/55 border border-white/10 text-xs text-white"
                  >
                    <option value="pro">Pro</option>
                    <option value="max">Max</option>
                  </select>
                ) : (
                  <div className="h-10 px-3 rounded-xl bg-black/30 border border-white/[0.06] text-xs text-neutral-500 flex items-center">
                    Бонус
                  </div>
                )}
                <input
                  type="number"
                  min={1}
                  value={promoValue}
                  onChange={(e) => setPromoValue(Math.max(1, Number(e.target.value) || 1))}
                  className="h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs font-mono text-white"
                />
                <input
                  type="number"
                  min={1}
                  value={promoMaxUses}
                  onChange={(e) => setPromoMaxUses(Math.max(1, Number(e.target.value) || 1))}
                  className="h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs font-mono text-white"
                />
                <button
                  type="submit"
                  className="h-10 px-4 rounded-xl bg-white hover:bg-neutral-200 text-black text-xs font-semibold"
                >
                  Создать
                </button>
              </form>

              {promos.length === 0 ? (
                <div className="py-6 text-center text-xs text-neutral-500">Пусто</div>
              ) : (
                <div className="divide-y divide-white/[0.06]">
                  {promos.map((p) => (
                    <div key={p.code} className="py-3 flex items-center justify-between gap-3 text-xs">
                      <div>
                        <span className="font-mono font-semibold text-white">{p.code}</span>
                        <span className="text-neutral-400 ml-2">
                          ·{' '}
                          {p.type === 'requests'
                            ? `+${p.value} запр.`
                            : `+${p.value} дн. ${(p.plan || 'max').toUpperCase()}`}{' '}
                          · {p.usedBy.length}/{p.maxUses}
                        </span>
                      </div>
                      {p.active ? (
                        <button
                          type="button"
                          onClick={async () => {
                            await apiRequest(`/api/admin/promos/${p.code}`, {
                              method: 'DELETE',
                              token,
                            });
                            void loadPromos();
                            void loadOverview();
                          }}
                          className="text-neutral-300 hover:text-white"
                        >
                          Отключить
                        </button>
                      ) : (
                        <span className="text-neutral-600">Отключён</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {tab === 'broadcast' && (
            <section className="liquid-glass rounded-2xl p-5 sm:p-6 space-y-4 max-w-2xl">
              <div>
                <h2 className="text-sm font-semibold text-white">Рассылка пользователям бота</h2>
                <p className="mt-1 text-xs text-neutral-400">
                  Сообщение будет отправлено через бота всем пользователям с привязанным Telegram.
                </p>
              </div>
              <form onSubmit={handleBroadcast} className="space-y-4">
                <textarea
                  rows={5}
                  required
                  maxLength={4000}
                  value={broadcastText}
                  onChange={(e) => setBroadcastText(e.target.value)}
                  placeholder="Введите текст объявления или акции..."
                  className="rgb-focus-ring w-full p-3.5 rounded-xl bg-black/50 border border-white/10 text-xs text-white placeholder:text-neutral-600 focus:outline-none leading-relaxed"
                />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] font-mono text-neutral-500">
                    {broadcastText.length} / 4000
                  </span>
                  <button
                    type="submit"
                    disabled={broadcastSending || !broadcastText.trim()}
                    className="h-10 px-5 rounded-xl bg-white hover:bg-neutral-200 text-black text-xs font-semibold flex items-center gap-2 transition-colors disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>{broadcastSending ? 'Отправка...' : 'Отправить всем'}</span>
                  </button>
                </div>
              </form>

              {broadcastResult && (
                <div className="p-3.5 rounded-xl bg-black/40 border border-white/10 text-xs text-neutral-200 flex flex-wrap gap-4 font-mono">
                  <span>Всего: {broadcastResult.totalRecipients}</span>
                  <span>Отправлено: {broadcastResult.sent}</span>
                  <span>Ошибок: {broadcastResult.failed}</span>
                </div>
              )}
            </section>
          )}

          {tab === 'settings' && settings && (
            <section className="liquid-glass rounded-2xl p-5 sm:p-6">
              <form onSubmit={handleSaveSettings} className="space-y-4 max-w-2xl">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Free/день</label>
                    <input
                      type="number"
                      value={settings.freeDailyLimit}
                      onChange={(e) =>
                        setSettings({...settings, freeDailyLimit: Number(e.target.value) || 1})
                      }
                      className="w-full h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs font-mono text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Pro/день</label>
                    <input
                      type="number"
                      value={settings.proDailyLimit}
                      onChange={(e) =>
                        setSettings({...settings, proDailyLimit: Number(e.target.value) || 1})
                      }
                      className="w-full h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs font-mono text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Max/день</label>
                    <input
                      type="number"
                      value={settings.maxDailyLimit}
                      onChange={(e) =>
                        setSettings({...settings, maxDailyLimit: Number(e.target.value) || 1})
                      }
                      className="w-full h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs font-mono text-white"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Pro ($)</label>
                    <input
                      type="number"
                      value={settings.proPriceUsd}
                      onChange={(e) =>
                        setSettings({...settings, proPriceUsd: Number(e.target.value) || 1})
                      }
                      className="w-full h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs font-mono text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Pro (Stars)</label>
                    <input
                      type="number"
                      value={settings.proPriceStars}
                      onChange={(e) =>
                        setSettings({...settings, proPriceStars: Number(e.target.value) || 1})
                      }
                      className="w-full h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs font-mono text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Max ($)</label>
                    <input
                      type="number"
                      value={settings.maxPriceUsd}
                      onChange={(e) =>
                        setSettings({...settings, maxPriceUsd: Number(e.target.value) || 1})
                      }
                      className="w-full h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs font-mono text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">Max (Stars)</label>
                    <input
                      type="number"
                      value={settings.maxPriceStars}
                      onChange={(e) =>
                        setSettings({...settings, maxPriceStars: Number(e.target.value) || 1})
                      }
                      className="w-full h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs font-mono text-white"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-neutral-500 mb-1">Карта</label>
                  <input
                    type="text"
                    value={settings.visaCardDetails}
                    onChange={(e) => setSettings({...settings, visaCardDetails: e.target.value})}
                    className="w-full h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs text-white"
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">TON кошелёк</label>
                    <input
                      type="text"
                      value={settings.tonWalletAddress}
                      onChange={(e) => setSettings({...settings, tonWalletAddress: e.target.value})}
                      className="w-full h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs font-mono text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">GRAM кошелёк</label>
                    <input
                      type="text"
                      value={settings.gramWalletAddress}
                      onChange={(e) => setSettings({...settings, gramWalletAddress: e.target.value})}
                      className="w-full h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs font-mono text-white"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-neutral-500 mb-1">Контакт поддержки</label>
                  <input
                    type="text"
                    value={settings.supportContact}
                    onChange={(e) => setSettings({...settings, supportContact: e.target.value})}
                    className="w-full h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs text-white"
                  />
                </div>

                <button
                  type="submit"
                  className="h-10 px-5 rounded-xl bg-white hover:bg-neutral-200 text-black text-xs font-semibold transition-colors"
                >
                  Сохранить цены и реквизиты
                </button>
              </form>
            </section>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
