import React, {useCallback, useEffect, useState} from 'react';
import {motion} from 'motion/react';
import {
  Ticket,
  Check,
  Star,
  ExternalLink,
  RefreshCw,
  MessageCircle,
} from 'lucide-react';
import {apiRequest, ApiError, isSafeHttpUrl} from '../api';
import {getTelegramWebApp} from '../telegramWebApp';
import type {
  BotRuntimeStatus,
  PaymentApplication,
  PaymentDetails,
  PlanDefinition,
  PublicUserProfile,
  StarOrder,
} from '../types';

interface PlansBillingViewProps {
  token: string;
  user: PublicUserProfile;
  botStatus: BotRuntimeStatus;
  onUserUpdated: (user: PublicUserProfile) => void;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

export function PlansBillingView({
  token,
  user,
  botStatus,
  onUserUpdated,
  onNotify,
}: PlansBillingViewProps) {
  const [plans, setPlans] = useState<PlanDefinition[]>([]);
  const [details, setDetails] = useState<PaymentDetails | null>(null);
  const [liveBotStatus, setLiveBotStatus] = useState<BotRuntimeStatus>(botStatus);
  const [myPayments, setMyPayments] = useState<PaymentApplication[]>([]);
  const [loading, setLoading] = useState(true);

  const [promoCode, setPromoCode] = useState('');
  const [promoLoading, setPromoLoading] = useState(false);

  // Bot Checkout (Stars + Visa/TON/GRAM inside @demov2clientfybot)
  const [checkoutLoadingPlan, setCheckoutLoadingPlan] = useState<'pro' | 'max' | null>(null);
  const [activeOrder, setActiveOrder] = useState<StarOrder | null>(null);
  const [activeDeepLink, setActiveDeepLink] = useState<string | null>(null);
  const [checkingOrder, setCheckingOrder] = useState(false);

  const loadBilling = useCallback(async () => {
    setLoading(true);
    try {
      const [plansRes, payRes] = await Promise.all([
        apiRequest<{
          plans: PlanDefinition[];
          paymentDetails: PaymentDetails;
          botStatus?: BotRuntimeStatus;
        }>('/api/plans', {token}),
        apiRequest<{payments: PaymentApplication[]}>('/api/payments/my', {token}),
      ]);
      setPlans(plansRes.plans);
      setDetails(plansRes.paymentDetails);
      if (plansRes.botStatus) setLiveBotStatus(plansRes.botStatus);
      setMyPayments(payRes.payments);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка загрузки тарифов', 'error');
    } finally {
      setLoading(false);
    }
  }, [token, onNotify]);

  useEffect(() => {
    void loadBilling();
  }, [loadBilling]);

  const checkOrderStatus = useCallback(
    async (orderId: string, silent = false) => {
      if (!silent) setCheckingOrder(true);
      try {
        const res = await apiRequest<{
          order: StarOrder;
          user: PublicUserProfile | null;
        }>(`/api/payments/stars/${orderId}`, {token});
        setActiveOrder(res.order);
        if (res.order.status === 'paid') {
          if (res.user) onUserUpdated(res.user);
          const payRes = await apiRequest<{payments: PaymentApplication[]}>('/api/payments/my', {
            token,
          });
          setMyPayments(payRes.payments);
          onNotify(`Оплачено: ${res.order.planId.toUpperCase()}`);
        } else if (!silent) {
          onNotify('Ожидает оплаты в Telegram-боте');
        }
      } catch (err) {
        if (!silent) {
          onNotify(err instanceof ApiError ? err.message : 'Ошибка проверки', 'error');
        }
      } finally {
        if (!silent) setCheckingOrder(false);
      }
    },
    [token, onUserUpdated, onNotify],
  );

  useEffect(() => {
    if (!activeOrder || activeOrder.status !== 'pending') return;
    const interval = setInterval(() => {
      void checkOrderStatus(activeOrder.id, true);
    }, 3000);
    return () => clearInterval(interval);
  }, [activeOrder, checkOrderStatus]);

  const handleBotCheckout = async (planId: 'pro' | 'max') => {
    setCheckoutLoadingPlan(planId);
    try {
      const res = await apiRequest<{
        order: StarOrder;
        botStatus: BotRuntimeStatus;
        deepLink: string | null;
        invoiceLink?: string | null;
      }>('/api/payments/stars/create', {
        method: 'POST',
        token,
        body: {planId},
      });
      setActiveOrder(res.order);
      setActiveDeepLink(res.deepLink);
      setLiveBotStatus(res.botStatus);

      const tg = getTelegramWebApp();
      if (tg?.openInvoice && res.invoiceLink) {
        tg.openInvoice(res.invoiceLink, (invoiceStatus) => {
          if (invoiceStatus === 'paid') {
            void checkOrderStatus(res.order.id, false);
          }
        });
        return;
      }

      if (tg?.openTelegramLink && res.deepLink) {
        tg.openTelegramLink(res.deepLink);
        return;
      }

      onNotify('Заказ создан. Перейдите в Telegram-бота для оплаты.');
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка создания счёта', 'error');
    } finally {
      setCheckoutLoadingPlan(null);
    }
  };

  const handleRedeemPromo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!promoCode.trim()) return;
    setPromoLoading(true);
    try {
      const res = await apiRequest<{message: string; user: PublicUserProfile}>(
        '/api/promo/redeem',
        {
          method: 'POST',
          token,
          body: {code: promoCode.trim()},
        },
      );
      onUserUpdated(res.user);
      setPromoCode('');
      onNotify(res.message);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Неверный промокод', 'error');
    } finally {
      setPromoLoading(false);
    }
  };

  const botUsername = liveBotStatus.username || 'demov2clientfybot';
  const supportUrl =
    details?.supportContact && isSafeHttpUrl(details.supportContact)
      ? details.supportContact
      : 'https://t.me/ClienFy_Support';

  const statusText = (s: PaymentApplication['status']) =>
    s === 'approved' ? 'Подтверждена' : s === 'rejected' ? 'Отклонена' : 'Ожидает';

  return (
    <div className="space-y-6">
      <div className="liquid-glass rounded-2xl p-5 sm:p-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Тарифы и подписка</h1>
          <div className="mt-1 text-xs font-mono text-neutral-400">
            {user.quota.planName} · {user.quota.dailyLimit}/день · Бонус {user.quota.bonusRequests}
          </div>
        </div>

        <a
          href={supportUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="h-9 px-3.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-xs font-medium text-white flex items-center gap-1.5 whitespace-nowrap transition-colors"
        >
          <MessageCircle className="w-3.5 h-3.5" />
          <span>Поддержка</span>
        </a>
      </div>

      {/* Plans */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="liquid-glass-subtle rounded-2xl h-64 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {plans.map((plan, idx) => {
            const isCurrent = user.quota.planId === plan.id;
            return (
              <motion.div
                key={plan.id}
                initial={{opacity: 0, y: 10}}
                animate={{opacity: 1, y: 0}}
                transition={{duration: 0.2, delay: idx * 0.04}}
                className={`liquid-glass rounded-2xl p-6 flex flex-col justify-between ${
                  isCurrent ? 'border-white/30' : ''
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-lg font-semibold text-white">{plan.name}</h2>
                    {isCurrent && (
                      <span className="text-[11px] font-medium text-black bg-white px-2 py-0.5 rounded-md">
                        Активен
                      </span>
                    )}
                  </div>
                  <div className="mt-3 text-2xl font-mono font-semibold text-white">
                    {plan.priceUsd === 0 ? 'Free' : `$${plan.priceUsd}`}
                  </div>
                  {plan.priceStars > 0 && (
                    <div className="text-xs font-mono text-neutral-400 mt-0.5">
                      {plan.priceStars} Stars · 30 дней
                    </div>
                  )}

                  <ul className="mt-5 space-y-2 text-xs text-neutral-300">
                    {plan.highlights.map((item) => (
                      <li key={item} className="flex items-start gap-2">
                        <Check className="w-3.5 h-3.5 text-white shrink-0 mt-0.5" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {plan.id !== 'free' && (
                  <button
                    type="button"
                    onClick={() => handleBotCheckout(plan.id as 'pro' | 'max')}
                    disabled={checkoutLoadingPlan === plan.id}
                    className="mt-6 h-10 w-full rounded-xl bg-white hover:bg-neutral-200 text-xs font-semibold text-black transition-colors flex items-center justify-center gap-1.5"
                  >
                    <Star className="w-3.5 h-3.5" />
                    <span>
                      {checkoutLoadingPlan === plan.id
                        ? 'Подготовка...'
                        : `Оплатить в @${botUsername}`}
                    </span>
                  </button>
                )}
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Active Bot Checkout Banner */}
      {activeOrder && (
        <section className="liquid-glass-elevated rounded-2xl p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="text-white font-medium">
              Заказ <span className="font-mono">{activeOrder.id}</span> ·{' '}
              {activeOrder.planId.toUpperCase()} ({activeOrder.starsAmount} Stars / Visa / TON)
            </div>
            <span className="text-neutral-300 font-medium">
              {activeOrder.status === 'paid' ? 'Оплачен' : 'Ожидает оплаты в боте'}
            </span>
          </div>

          {activeOrder.status === 'pending' && (
            <div className="flex flex-wrap items-center gap-2.5">
              {activeDeepLink && isSafeHttpUrl(activeDeepLink) && (
                <a
                  href={activeDeepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h-9 px-4 rounded-xl bg-white hover:bg-neutral-200 text-black text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap"
                >
                  <span>Перейти к оплате в @{botUsername}</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}

              <button
                type="button"
                onClick={() => void checkOrderStatus(activeOrder.id, false)}
                disabled={checkingOrder}
                className="h-9 px-3.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-xs font-medium text-white flex items-center gap-1.5 whitespace-nowrap"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${checkingOrder ? 'animate-spin' : ''}`} />
                <span>Проверить статус</span>
              </button>
            </div>
          )}
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-6 liquid-glass rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Ticket className="w-4 h-4 text-neutral-300" />
            <span>Промокод</span>
          </div>
          <form onSubmit={handleRedeemPromo} className="flex gap-2">
            <input
              type="text"
              value={promoCode}
              onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
              placeholder="КОД"
              className="rgb-focus-ring flex-1 h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs font-mono text-white placeholder:text-neutral-600 uppercase focus:outline-none"
            />
            <button
              type="submit"
              disabled={promoLoading}
              className="h-10 px-4 rounded-xl bg-white/[0.08] hover:bg-white/[0.15] border border-white/10 text-xs font-medium text-white whitespace-nowrap"
            >
              {promoLoading ? '...' : 'Активировать'}
            </button>
          </form>
        </section>

        <section className="lg:col-span-6 liquid-glass rounded-2xl p-5 space-y-3">
          <div className="text-sm font-semibold text-white">История оплат</div>
          {myPayments.length === 0 ? (
            <div className="text-xs text-neutral-500 py-3">
              Оплаты через Telegram Stars и переводы в @{botUsername} появятся здесь.
            </div>
          ) : (
            <div className="divide-y divide-white/[0.06] max-h-64 overflow-y-auto">
              {myPayments.map((p) => (
                <div key={p.id} className="py-2.5 text-xs flex items-center justify-between gap-2">
                  <div>
                    <div className="font-medium text-white">
                      {p.planId.toUpperCase()} · {p.amountLabel}
                    </div>
                    <div className="text-neutral-500 font-mono">
                      {new Date(p.createdAt).toLocaleDateString('ru-RU')}
                    </div>
                  </div>
                  <span className="font-medium text-neutral-300">{statusText(p.status)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
