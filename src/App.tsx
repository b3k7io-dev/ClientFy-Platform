import React, {useCallback, useEffect, useState} from 'react';
import {AnimatePresence, motion, MotionConfig} from 'motion/react';
import {
  Search,
  History,
  Send,
  CreditCard,
  User,
  Shield,
  Menu,
  X,
  LogOut,
} from 'lucide-react';
import {apiRequest} from './api';
import {AdminView} from './components/AdminView';
import {AuthView} from './components/AuthView';
import {HistoryView} from './components/HistoryView';
import {OutreachView} from './components/OutreachView';
import {PlansBillingView} from './components/PlansBillingView';
import {ProfileView} from './components/ProfileView';
import {SearchWorkspace} from './components/SearchWorkspace';
import {getTelegramInitData, initTelegramWebApp} from './telegramWebApp';
import type {
  AuthStatusResponse,
  PublicUserProfile,
  QuotaSummary,
  SearchFilters,
  YouTubeChannelResult,
} from './types';

type NavSection = 'search' | 'history' | 'outreach' | 'plans' | 'profile' | 'admin';

function resolveRequestedInitialSection(): NavSection {
  if (typeof window === 'undefined') return 'search';
  const params = new URLSearchParams(window.location.search);
  if (params.get('tab') === 'admin' || window.location.hash === '#admin') {
    return 'admin';
  }
  return 'search';
}

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [user, setUser] = useState<PublicUserProfile | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const [section, setSection] = useState<NavSection>('search');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Restored search state from history
  const [restoredResults, setRestoredResults] = useState<YouTubeChannelResult[] | undefined>(
    undefined,
  );
  const [restoredFilters, setRestoredFilters] = useState<SearchFilters | null>(null);
  const [searchMountKey, setSearchMountKey] = useState(0);

  // Toast feedback
  const [toast, setToast] = useState<{msg: string; tone: 'info' | 'error'} | null>(null);
  const [tgAuthenticating, setTgAuthenticating] = useState<boolean>(() => Boolean(getTelegramInitData()));
  const [tgAuthError, setTgAuthError] = useState<string | null>(null);

  const notify = useCallback((msg: string, tone: 'info' | 'error' = 'info') => {
    setToast({msg, tone});
  }, []);

  useEffect(() => {
    initTelegramWebApp();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const fetchAuthStatus = useCallback(async (activeToken: string | null) => {
    try {
      const status = await apiRequest<AuthStatusResponse>('/api/auth/status', {
        token: activeToken,
      });
      setAuthStatus(status);
      setUser(status.user);
      if (status.user?.isOwner && resolveRequestedInitialSection() === 'admin') {
        setSection('admin');
      }
      setBootError(null);
    } catch {
      setBootError('Не удалось подключиться к серверу ClientFy');
    }
  }, []);

  useEffect(() => {
    fetchAuthStatus(token);
  }, [fetchAuthStatus, token]);

  // Auto-sign in when opened inside Telegram Mini App (WebApp)
  useEffect(() => {
    const initData = getTelegramInitData();
    if (!initData || token) {
      setTgAuthenticating(false);
      return;
    }

    let cancelled = false;
    setTgAuthenticating(true);
    setTgAuthError(null);

    apiRequest<{token: string; user: PublicUserProfile}>('/api/auth/telegram-webapp', {
      method: 'POST',
      body: {initData},
    })
      .then((res) => {
        if (cancelled) return;
        setToken(res.token);
        setUser(res.user);
        if (res.user.isOwner && resolveRequestedInitialSection() === 'admin') {
          setSection('admin');
        }
        setTgAuthError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setTgAuthError(err instanceof Error ? err.message : 'Ошибка входа через Telegram WebApp');
      })
      .finally(() => {
        if (!cancelled) setTgAuthenticating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAuthenticated = (newToken: string, authedUser: PublicUserProfile) => {
    setToken(newToken);
    setUser(authedUser);
    setSection(
      authedUser.isOwner && resolveRequestedInitialSection() === 'admin'
        ? 'admin'
        : 'search',
    );
  };

  const handleLogout = () => {
    setToken(null);
    setUser(null);
    setSection('search');
  };

  const handleQuotaUpdate = useCallback((nextQuota: QuotaSummary) => {
    setUser((prev) => (prev ? {...prev, quota: nextQuota} : prev));
  }, []);

  const handleRestoreSearch = useCallback(
    (filters: SearchFilters, results: YouTubeChannelResult[]) => {
      setRestoredFilters(filters);
      setRestoredResults(results);
      setSearchMountKey((k) => k + 1);
      setSection('search');
    },
    [],
  );

  if (bootError) {
    return (
      <div className="min-h-screen bg-[#050507] flex items-center justify-center p-6">
        <div className="liquid-glass rounded-2xl p-6 max-w-md w-full text-center space-y-3">
          <div className="text-base font-semibold text-white">{bootError}</div>
          <button
            type="button"
            onClick={() => fetchAuthStatus(token)}
            className="h-10 px-5 rounded-xl bg-white hover:bg-neutral-200 text-black text-xs font-semibold transition-colors"
          >
            Повторить
          </button>
        </div>
      </div>
    );
  }

  if (!authStatus || tgAuthenticating) {
    return (
      <div className="min-h-screen bg-[#050507] flex items-center justify-center p-6">
        <div className="liquid-glass rounded-2xl px-6 py-5 text-sm text-neutral-300">
          {tgAuthenticating ? 'Вход через Telegram...' : 'Загрузка...'}
        </div>
      </div>
    );
  }

  if (!token || !user) {
    return (
      <AuthView
        authStatus={authStatus}
        tgAuthError={tgAuthError}
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  const navItems: Array<{id: NavSection; label: string; icon: typeof Search}> = [
    {id: 'search', label: 'Поиск каналов', icon: Search},
    {id: 'history', label: 'История поисков', icon: History},
    {id: 'outreach', label: 'Рассылка и база', icon: Send},
    {id: 'plans', label: 'Тарифы и оплата', icon: CreditCard},
    {id: 'profile', label: 'Профиль и квоты', icon: User},
  ];

  if (user.isOwner) {
    navItems.push({id: 'admin', label: 'Админ-панель', icon: Shield});
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen bg-[#050507] text-neutral-100 relative">
        <div
          aria-hidden="true"
          className="pointer-events-none fixed -top-48 left-1/3 h-[420px] w-[420px] rounded-full bg-white/[0.03] blur-[150px]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none fixed bottom-0 right-1/4 h-[380px] w-[380px] rounded-full bg-white/[0.02] blur-[150px]"
        />

        {/* Top Bar */}
        <header className="sticky top-0 z-30 h-16 px-4 sm:px-6 border-b border-white/[0.07] bg-[#050507]/80 backdrop-blur-2xl flex items-center justify-between gap-8">
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              className="lg:hidden p-2 -ml-2 rounded-lg text-neutral-300 hover:bg-white/[0.06] transition-colors"
              aria-label="Меню"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
            <a
              href="#search"
              onClick={(e) => {
                e.preventDefault();
                setSection('search');
              }}
              className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
            >
              ClientFy
            </a>
          </div>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-neutral-400">
            {(
              [
                ['search', 'Поиск'],
                ['history', 'История'],
                ['outreach', 'Рассылка'],
                ['plans', 'Тарифы'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                className={`relative py-1 transition-colors whitespace-nowrap shrink-0 ${
                  section === id ? 'text-white' : 'hover:text-neutral-200'
                }`}
              >
                {label}
                {section === id && (
                  <motion.span
                    layoutId="topbar-underline"
                    transition={{duration: 0.22, ease: [0.16, 1, 0.3, 1]}}
                    className="absolute inset-x-0 -bottom-1 h-[1.5px] bg-white rounded-full"
                  />
                )}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={handleLogout}
              className="h-9 px-3.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-xs font-medium text-white flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Выйти</span>
            </button>
          </div>
        </header>

        <div className="max-w-[1440px] mx-auto flex">
          {/* Workspace Sidebar */}
          <aside
            className={`${
              mobileMenuOpen ? 'fixed inset-y-16 left-0 z-40 block' : 'hidden'
            } lg:block w-64 shrink-0 border-r border-white/[0.07] bg-[#050507]/95 lg:bg-white/[0.015] backdrop-blur-2xl p-4 flex flex-col justify-between min-h-[calc(100vh-4rem)]`}
          >
            <div className="space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = section === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setSection(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full h-10 px-3 rounded-xl text-xs font-medium flex items-center gap-2.5 transition-all duration-200 whitespace-nowrap ${
                      active
                        ? 'liquid-glass-elevated text-white'
                        : 'text-neutral-400 hover:text-white hover:bg-white/[0.04]'
                    }`}
                  >
                    <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-white' : 'text-neutral-500'}`} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="mt-8 pt-4 border-t border-white/[0.07] space-y-2.5 text-xs">
              <div className="flex items-center justify-between text-neutral-500">
                <span>Аккаунт</span>
                <span className="text-neutral-100 font-medium truncate max-w-[120px]">
                  {user.username}
                </span>
              </div>
              <div className="flex items-center justify-between text-neutral-500">
                <span>Тариф</span>
                <span className="text-white font-medium">{user.quota.planName}</span>
              </div>
              <div className="flex items-center justify-between text-neutral-500">
                <span>Квота</span>
                <span className="font-mono text-white">{user.quota.totalAvailable}</span>
              </div>
              <div className="flex items-center justify-between text-neutral-500">
                <span>Бот</span>
                <span className="font-mono text-neutral-300 truncate max-w-[120px]">
                  {authStatus.botStatus.running && authStatus.botStatus.username
                    ? `@${authStatus.botStatus.username}`
                    : 'Оффлайн'}
                </span>
              </div>
            </div>
          </aside>

          {/* Main Content Viewport */}
          <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8">
            <AnimatePresence mode="wait">
              <motion.div
                key={section}
                initial={{opacity: 0, y: 8}}
                animate={{opacity: 1, y: 0}}
                exit={{opacity: 0, y: -6}}
                transition={{duration: 0.2, ease: [0.16, 1, 0.3, 1]}}
              >
                {section === 'search' && (
                  <SearchWorkspace
                    key={searchMountKey}
                    token={token}
                    hasYoutubeKey={authStatus.hasYoutubeKey}
                    quota={user.quota}
                    initialResults={restoredResults}
                    initialFilters={restoredFilters}
                    onQuotaUpdate={handleQuotaUpdate}
                    onNotify={notify}
                    onGoToPlans={() => setSection('plans')}
                  />
                )}

                {section === 'history' && (
                  <HistoryView
                    token={token}
                    onRestoreSearch={handleRestoreSearch}
                    onGoToSearch={() => setSection('search')}
                    onNotify={notify}
                  />
                )}

                {section === 'outreach' && <OutreachView token={token} onNotify={notify} />}

                {section === 'plans' && (
                  <PlansBillingView
                    token={token}
                    user={user}
                    botStatus={authStatus.botStatus}
                    onUserUpdated={(updated) => setUser(updated)}
                    onNotify={notify}
                  />
                )}

                {section === 'profile' && (
                  <ProfileView
                    token={token}
                    user={user}
                    botStatus={authStatus.botStatus}
                    onGoToPlans={() => setSection('plans')}
                    onUserRefresh={() => fetchAuthStatus(token)}
                    onNotify={notify}
                  />
                )}

                {section === 'admin' && user.isOwner && (
                  <AdminView token={token} onNotify={notify} />
                )}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>

        <AnimatePresence>
          {toast && (
            <motion.div
              role="status"
              initial={{opacity: 0, y: 12, scale: 0.98}}
              animate={{opacity: 1, y: 0, scale: 1}}
              exit={{opacity: 0, y: 8, scale: 0.98}}
              transition={{duration: 0.18, ease: [0.16, 1, 0.3, 1]}}
              className={`fixed bottom-5 right-5 z-50 px-4 py-2.5 rounded-xl text-xs font-medium border backdrop-blur-2xl shadow-xl ${
                toast.tone === 'error'
                  ? 'bg-neutral-950/95 border-red-500/40 text-red-200'
                  : 'bg-neutral-950/95 border-white/15 text-white'
              }`}
            >
              {toast.msg}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
