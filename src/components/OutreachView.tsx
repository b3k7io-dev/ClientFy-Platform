import React, {useCallback, useEffect, useState} from 'react';
import {AnimatePresence, motion} from 'motion/react';
import {
  Send,
  Plus,
  Trash2,
  Download,
  Copy,
  FileText,
  Users,
  Search,
  Play,
  Square,
  Phone,
  Shield,
  LogOut,
  Delete,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import {apiRequest, ApiError, formatCompactNumber} from '../api';
import type {OutreachContact, OutreachPayload} from '../types';

interface OutreachViewProps {
  token: string;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

interface GeneratedMessage {
  contactId: string;
  channelTitle: string;
  contactValue: string;
  contactType: string;
  message: string;
}

export function OutreachView({token, onNotify}: OutreachViewProps) {
  const [data, setData] = useState<OutreachPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | 'queued' | 'sent' | 'skipped'>('all');
  const [searchText, setSearchText] = useState('');

  // MTProto Telegram Account Auth
  const [tgStep, setTgStep] = useState<'idle' | 'code' | 'password'>('idle');
  const [tgPhone, setTgPhone] = useState('');
  const [tgCode, setTgCode] = useState('');
  const [tgPassword, setTgPassword] = useState('');
  const [tgBusy, setTgBusy] = useState(false);

  // Real Autosend Campaign
  const [delayMin, setDelayMin] = useState(20);
  const [delayMax, setDelayMax] = useState(30);
  const [campaignBusy, setCampaignBusy] = useState(false);

  // Topic-based collector
  const [topicsInput, setTopicsInput] = useState('');
  const [collecting, setCollecting] = useState(false);

  // Add contact form
  const [newTitle, setNewTitle] = useState('');
  const [newContact, setNewContact] = useState('');
  const [newType, setNewType] = useState<'telegram' | 'email' | 'website' | 'social'>('telegram');

  // Template editor
  const [selectedTplId, setSelectedTplId] = useState<string>('');
  const [tplName, setTplName] = useState('');
  const [tplBody, setTplBody] = useState('');

  // Preview batch
  const [generated, setGenerated] = useState<GeneratedMessage[]>([]);
  const [generating, setGenerating] = useState(false);

  const loadOutreach = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const payload = await apiRequest<OutreachPayload>('/api/outreach', {token});
        setData(payload);
        if (payload.telegramAccount && !payload.telegramAccount.connected) {
          setTgStep(payload.telegramAccount.pendingStep);
        }
        if (payload.campaign.topics?.length > 0 && !topicsInput) {
          setTopicsInput(payload.campaign.topics.join(', '));
        }
        if (!selectedTplId) {
          const activeTpl =
            payload.templates.find((t) => t.id === payload.campaign.templateId) ||
            payload.templates[0];
          if (activeTpl) {
            setSelectedTplId(activeTpl.id);
            setTplName(activeTpl.name);
            setTplBody(activeTpl.body);
          }
        }
      } catch (err) {
        if (!silent) {
          onNotify(err instanceof ApiError ? err.message : 'Ошибка загрузки рассылки', 'error');
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [token, onNotify, selectedTplId, topicsInput],
  );

  useEffect(() => {
    void loadOutreach(false);
  }, [loadOutreach]);

  // Live poll while campaign is running
  useEffect(() => {
    if (!data?.campaign.running) return;
    const timer = setInterval(() => {
      void loadOutreach(true);
    }, 2500);
    return () => clearInterval(timer);
  }, [data?.campaign.running, loadOutreach]);

  const handleSendTgCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tgPhone.trim()) return;
    setTgBusy(true);
    try {
      const res = await apiRequest<{phoneMasked: string}>('/api/outreach/telegram/send-code', {
        method: 'POST',
        token,
        body: {phone: tgPhone.trim()},
      });
      setTgStep('code');
      setTgCode('');
      onNotify(`Код отправлен в Telegram (${res.phoneMasked})`);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Не удалось отправить код', 'error');
    } finally {
      setTgBusy(false);
    }
  };

  const handleVerifyTgCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (tgCode.trim().length < 4) return;
    setTgBusy(true);
    try {
      const res = await apiRequest<{
        step: 'connected' | 'password';
        telegramAccount?: OutreachPayload['telegramAccount'];
      }>('/api/outreach/telegram/verify-code', {
        method: 'POST',
        token,
        body: {code: tgCode.trim()},
      });
      if (res.step === 'password') {
        setTgStep('password');
        onNotify('Требуется облачный пароль 2FA');
      } else {
        setTgStep('idle');
        setTgCode('');
        setTgPhone('');
        await loadOutreach(true);
        onNotify('Telegram-аккаунт подключён');
      }
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Неверный код', 'error');
    } finally {
      setTgBusy(false);
    }
  };

  const handleVerifyTgPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tgPassword) return;
    setTgBusy(true);
    try {
      await apiRequest('/api/outreach/telegram/verify-password', {
        method: 'POST',
        token,
        body: {password: tgPassword},
      });
      setTgStep('idle');
      setTgPassword('');
      setTgCode('');
      setTgPhone('');
      await loadOutreach(true);
      onNotify('Telegram-аккаунт подключён');
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Неверный пароль 2FA', 'error');
    } finally {
      setTgBusy(false);
    }
  };

  const handleDisconnectTg = async () => {
    setTgBusy(true);
    try {
      await apiRequest('/api/outreach/telegram/disconnect', {
        method: 'POST',
        token,
      });
      setTgStep('idle');
      await loadOutreach(true);
      onNotify('Telegram-аккаунт отключён');
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка отключения', 'error');
    } finally {
      setTgBusy(false);
    }
  };

  const handleStartCampaign = async () => {
    setCampaignBusy(true);
    try {
      const updated = await apiRequest<OutreachPayload>('/api/outreach/campaigns/start', {
        method: 'POST',
        token,
        body: {
          templateId: selectedTplId,
          delayMinSec: delayMin,
          delayMaxSec: delayMax,
        },
      });
      setData(updated);
      onNotify('Авторассылка запущена');
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Не удалось запустить рассылку', 'error');
    } finally {
      setCampaignBusy(false);
    }
  };

  const handleStopCampaign = async () => {
    setCampaignBusy(true);
    try {
      const updated = await apiRequest<OutreachPayload>('/api/outreach/campaigns/stop', {
        method: 'POST',
        token,
      });
      setData(updated);
      onNotify('Остановка рассылки...');
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка остановки', 'error');
    } finally {
      setCampaignBusy(false);
    }
  };

  const handleCollectByTopics = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topicsInput.trim()) return;
    setCollecting(true);
    try {
      const res = await apiRequest<OutreachPayload & {added: number}>('/api/outreach/collect', {
        method: 'POST',
        token,
        body: {topics: topicsInput, days: 14, count: 8},
      });
      setData(res);
      onNotify(`Добавлено Telegram-контактов: ${res.added}`);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка сбора контактов', 'error');
    } finally {
      setCollecting(false);
    }
  };

  const handleAddContact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newContact.trim()) return;
    try {
      const updated = await apiRequest<OutreachPayload & {added: number}>(
        '/api/outreach/contacts',
        {
          method: 'POST',
          token,
          body: {
            channelTitle: newTitle.trim() || newContact.trim(),
            contactValue: newContact.trim(),
            contactType: newType,
          },
        },
      );
      setData(updated);
      setNewTitle('');
      setNewContact('');
      onNotify(updated.added > 0 ? 'Контакт добавлен' : 'Уже есть в базе');
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка добавления', 'error');
    }
  };

  const handleContactStatus = async (id: string, status: OutreachContact['status']) => {
    try {
      const updated = await apiRequest<OutreachPayload>(`/api/outreach/contacts/${id}`, {
        method: 'PATCH',
        token,
        body: {status},
      });
      setData(updated);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка обновления', 'error');
    }
  };

  const handleDeleteContact = async (id: string) => {
    try {
      const updated = await apiRequest<OutreachPayload>(`/api/outreach/contacts/${id}`, {
        method: 'DELETE',
        token,
      });
      setData(updated);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка удаления', 'error');
    }
  };

  const handleSaveTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const updated = await apiRequest<OutreachPayload>('/api/outreach/templates', {
        method: 'POST',
        token,
        body: {
          id: selectedTplId || undefined,
          name: tplName,
          body: tplBody,
        },
      });
      setData(updated);
      onNotify('Шаблон сохранён');
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка сохранения', 'error');
    }
  };

  const handleGenerateBatch = async () => {
    setGenerating(true);
    try {
      const res = await apiRequest<
        OutreachPayload & {generatedMessages: GeneratedMessage[]; count: number}
      >('/api/outreach/campaigns/generate', {
        method: 'POST',
        token,
        body: {templateId: selectedTplId, markAsSent: false},
      });
      setData(res);
      setGenerated(res.generatedMessages);
      onNotify(`Предпросмотр: ${res.count} сообщ.`);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка генерации', 'error');
    } finally {
      setGenerating(false);
    }
  };

  const handleExportContacts = () => {
    if (!data || data.contacts.length === 0) return;
    const rows = [
      ['Канал', 'Handle', 'Контакт', 'Тип', 'Подписчики', 'Статус'],
      ...data.contacts.map((c) => [
        c.channelTitle,
        c.handle,
        c.contactValue,
        c.contactType,
        String(c.subscriberCount),
        c.status,
      ]),
    ];
    const csv = rows
      .map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([`\uFEFF${csv}`], {type: 'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'clientfy_outreach_contacts.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const contacts = data?.contacts ?? [];
  const queuedTgCount = contacts.filter(
    (c) => c.status === 'queued' && c.contactType === 'telegram',
  ).length;
  const tgAcc = data?.telegramAccount;

  const filteredContacts = contacts.filter((c) => {
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    const q = searchText.trim().toLowerCase();
    if (!q) return true;
    return (
      c.channelTitle.toLowerCase().includes(q) ||
      c.contactValue.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="liquid-glass rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Авторассылка</h1>
          <p className="mt-1 text-xs text-neutral-400">
            Подключение Telegram-аккаунта и отправка сообщений по базе.
          </p>
        </div>

        <button
          type="button"
          disabled={contacts.length === 0}
          onClick={handleExportContacts}
          className="h-9 px-3.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-xs font-medium text-white flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
        >
          <Download className="w-3.5 h-3.5" />
          <span>CSV ({contacts.length})</span>
        </button>
      </div>

      {/* Real MTProto Telegram Account + Campaign Runner */}
      {!loading && data && (
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
          {/* Account Connection */}
          <div className="lg:col-span-6 liquid-glass-elevated rounded-2xl p-5 space-y-4 flex flex-col justify-between">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium text-white">
                <Phone className="w-4 h-4 text-neutral-300" />
                <span>Telegram-аккаунт для рассылки</span>
              </div>
              {tgAcc?.connected && (
                <button
                  type="button"
                  disabled={tgBusy}
                  onClick={handleDisconnectTg}
                  className="h-8 px-3 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-xs text-neutral-200 flex items-center gap-1.5 transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Отключить</span>
                </button>
              )}
            </div>

            {tgAcc?.connected ? (
              <div className="p-4 rounded-xl bg-black/40 border border-white/10 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-white">
                    {tgAcc.displayName || 'Telegram подключён'}
                  </div>
                  <div className="mt-0.5 text-xs font-mono text-neutral-400">
                    {tgAcc.username ? `@${tgAcc.username} · ` : ''}
                    {tgAcc.phoneMasked}
                  </div>
                </div>
                <span className="text-xs font-medium text-white bg-white/10 border border-white/15 px-2.5 py-1 rounded-lg">
                  Активен
                </span>
              </div>
            ) : (
              <AnimatePresence mode="wait">
                {tgStep === 'idle' && (
                  <motion.form
                    key="step-phone"
                    initial={{opacity: 0, y: 6}}
                    animate={{opacity: 1, y: 0}}
                    exit={{opacity: 0, y: -6}}
                    transition={{duration: 0.18}}
                    onSubmit={handleSendTgCode}
                    className="space-y-3"
                  >
                    <div className="flex gap-2">
                      <input
                        type="tel"
                        required
                        value={tgPhone}
                        onChange={(e) => setTgPhone(e.target.value)}
                        placeholder="+79991234567"
                        className="rgb-focus-ring flex-1 h-10 px-3.5 rounded-xl bg-black/50 border border-white/10 text-xs font-mono text-white placeholder:text-neutral-600 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={tgBusy}
                        className="h-10 px-4 rounded-xl bg-white hover:bg-neutral-200 text-black text-xs font-semibold transition-colors whitespace-nowrap disabled:opacity-50"
                      >
                        {tgBusy ? 'Отправка...' : 'Получить код'}
                      </button>
                    </div>
                  </motion.form>
                )}

                {tgStep === 'code' && (
                  <motion.form
                    key="step-code"
                    initial={{opacity: 0, y: 6}}
                    animate={{opacity: 1, y: 0}}
                    exit={{opacity: 0, y: -6}}
                    transition={{duration: 0.18}}
                    onSubmit={handleVerifyTgCode}
                    className="space-y-3"
                  >
                    <div className="flex gap-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        required
                        value={tgCode}
                        onChange={(e) => setTgCode(e.target.value.replace(/[^\d]/g, '').slice(0, 8))}
                        placeholder="Код из Telegram"
                        className="rgb-focus-ring flex-1 h-10 px-3.5 rounded-xl bg-black/50 border border-white/10 text-sm font-mono tracking-widest text-white placeholder:text-neutral-600 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={tgBusy || tgCode.length < 4}
                        className="h-10 px-4 rounded-xl bg-white hover:bg-neutral-200 text-black text-xs font-semibold transition-colors whitespace-nowrap disabled:opacity-40"
                      >
                        {tgBusy ? 'Вход...' : 'Подтвердить'}
                      </button>
                    </div>

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
                        title="Стереть"
                      >
                        <Delete className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setTgStep('idle');
                          setTgCode('');
                        }}
                        className="h-9 rounded-lg bg-white/[0.04] hover:bg-white/[0.1] border border-white/[0.08] text-[11px] text-neutral-400 hover:text-white transition-colors"
                      >
                        Назад
                      </button>
                    </div>
                  </motion.form>
                )}

                {tgStep === 'password' && (
                  <motion.form
                    key="step-pass"
                    initial={{opacity: 0, y: 6}}
                    animate={{opacity: 1, y: 0}}
                    exit={{opacity: 0, y: -6}}
                    transition={{duration: 0.18}}
                    onSubmit={handleVerifyTgPassword}
                    className="space-y-3"
                  >
                    <div className="flex items-center gap-1.5 text-xs text-neutral-300">
                      <Shield className="w-3.5 h-3.5" />
                      <span>Облачный пароль 2FA</span>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        required
                        value={tgPassword}
                        onChange={(e) => setTgPassword(e.target.value)}
                        placeholder="Пароль двухфакторной защиты"
                        className="rgb-focus-ring flex-1 h-10 px-3.5 rounded-xl bg-black/50 border border-white/10 text-xs text-white placeholder:text-neutral-600 focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={tgBusy}
                        className="h-10 px-4 rounded-xl bg-white hover:bg-neutral-200 text-black text-xs font-semibold transition-colors whitespace-nowrap disabled:opacity-50"
                      >
                        {tgBusy ? '...' : 'Войти'}
                      </button>
                    </div>
                  </motion.form>
                )}
              </AnimatePresence>
            )}
          </div>

          {/* Real Campaign Controls */}
          <div className="lg:col-span-6 liquid-glass-elevated rounded-2xl p-5 space-y-4 flex flex-col justify-between">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium text-white">
                <Send className="w-4 h-4 text-neutral-300" />
                <span>Запуск рассылки</span>
              </div>
              <div className="text-xs font-mono text-neutral-400">
                В очереди: <span className="text-white">{queuedTgCount}</span> · Отправлено:{' '}
                <span className="text-white">{data.campaign.sentCount}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 items-end">
              <div>
                <label className="block text-[11px] text-neutral-500 mb-1">Пауза от (сек)</label>
                <input
                  type="number"
                  min={5}
                  max={120}
                  value={delayMin}
                  onChange={(e) => setDelayMin(Math.max(5, Number(e.target.value) || 20))}
                  disabled={data.campaign.running}
                  className="w-full h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs font-mono text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] text-neutral-500 mb-1">Пауза до (сек)</label>
                <input
                  type="number"
                  min={delayMin}
                  max={180}
                  value={delayMax}
                  onChange={(e) => setDelayMax(Math.max(delayMin, Number(e.target.value) || 30))}
                  disabled={data.campaign.running}
                  className="w-full h-10 px-3 rounded-xl bg-black/50 border border-white/10 text-xs font-mono text-white"
                />
              </div>

              {data.campaign.running ? (
                <button
                  type="button"
                  disabled={campaignBusy}
                  onClick={handleStopCampaign}
                  className="col-span-2 sm:col-span-1 h-10 px-4 rounded-xl bg-white/15 hover:bg-white/25 border border-white/20 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                >
                  <Square className="w-3.5 h-3.5" />
                  <span>Стоп</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={campaignBusy || !tgAcc?.connected || queuedTgCount === 0}
                  onClick={handleStartCampaign}
                  className="col-span-2 sm:col-span-1 h-10 px-4 rounded-xl bg-white hover:bg-neutral-200 text-black text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap disabled:opacity-40"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Запустить</span>
                </button>
              )}
            </div>

            {data.campaign.lastMessage && (
              <div className="px-3 py-2 rounded-lg bg-black/40 border border-white/[0.07] text-xs font-mono text-neutral-300 truncate">
                {data.campaign.lastMessage}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Topic-based Telegram Collector */}
      <section className="liquid-glass rounded-2xl p-5 space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-white">
          <Search className="w-4 h-4 text-neutral-300" />
          <span>Сбор Telegram-контактов по темам</span>
        </div>
        <form onSubmit={handleCollectByTopics} className="flex flex-col sm:flex-row gap-2.5">
          <input
            type="text"
            value={topicsInput}
            onChange={(e) => setTopicsInput(e.target.value)}
            placeholder="Темы через запятую: монтаж видео, крипта, авто"
            className="rgb-focus-ring flex-1 h-10 px-3.5 rounded-xl bg-black/50 border border-white/10 text-xs text-white placeholder:text-neutral-600 focus:outline-none"
          />
          <button
            type="submit"
            disabled={collecting}
            className="h-10 px-4 rounded-xl bg-white hover:bg-neutral-200 text-black text-xs font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            {collecting ? 'Сбираем...' : 'Собрать контакты'}
          </button>
        </form>
      </section>

      {loading && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-7 liquid-glass-subtle rounded-2xl h-80 animate-pulse" />
          <div className="lg:col-span-5 liquid-glass-subtle rounded-2xl h-80 animate-pulse" />
        </div>
      )}

      {!loading && data && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Contacts Table */}
          <section className="lg:col-span-7 liquid-glass rounded-2xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-medium text-white">
                <Users className="w-4 h-4 text-neutral-300" />
                <span>База ({contacts.length})</span>
              </div>

              <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                {[
                  {id: 'all', label: 'Все'},
                  {id: 'queued', label: 'В очереди'},
                  {id: 'sent', label: 'Готово'},
                  {id: 'skipped', label: 'Пропуск'},
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() =>
                      setStatusFilter(tab.id as 'all' | 'queued' | 'sent' | 'skipped')
                    }
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      statusFilter === tab.id
                        ? 'bg-white text-black'
                        : 'text-neutral-400 hover:text-neutral-200'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <form onSubmit={handleAddContact} className="grid grid-cols-1 sm:grid-cols-12 gap-2">
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Канал"
                className="sm:col-span-4 h-9 px-3 rounded-lg bg-black/50 border border-white/10 text-xs text-white placeholder:text-neutral-600 focus:outline-none"
              />
              <input
                type="text"
                required
                value={newContact}
                onChange={(e) => setNewContact(e.target.value)}
                placeholder="@username или t.me/..."
                className="sm:col-span-4 h-9 px-3 rounded-lg bg-black/50 border border-white/10 text-xs text-white placeholder:text-neutral-600 focus:outline-none"
              />
              <select
                value={newType}
                onChange={(e) =>
                  setNewType(e.target.value as 'telegram' | 'email' | 'website' | 'social')
                }
                className="sm:col-span-2 h-9 px-2 rounded-lg bg-black/60 border border-white/10 text-xs text-white"
              >
                <option value="telegram">Telegram</option>
                <option value="email">Email</option>
                <option value="social">Соцсеть</option>
                <option value="website">Сайт</option>
              </select>
              <button
                type="submit"
                className="sm:col-span-2 h-9 px-3 rounded-lg bg-white hover:bg-neutral-200 text-black text-xs font-semibold flex items-center justify-center gap-1 whitespace-nowrap transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Добавить</span>
              </button>
            </form>

            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Поиск по базе..."
              className="w-full h-9 px-3 rounded-lg bg-black/40 border border-white/[0.08] text-xs text-white placeholder:text-neutral-600 focus:outline-none"
            />

            {filteredContacts.length === 0 ? (
              <div className="py-10 text-center text-xs text-neutral-500">
                Контакты отсутствуют.
              </div>
            ) : (
              <div className="divide-y divide-white/[0.06] max-h-[460px] overflow-y-auto">
                {filteredContacts.map((c) => (
                  <div
                    key={c.id}
                    className="py-3 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-white truncate">{c.channelTitle}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-neutral-400">
                        <span className="text-neutral-200 truncate max-w-[220px]">
                          {c.contactValue}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{c.contactType}</span>
                        {c.subscriberCount > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">
                              {formatCompactNumber(c.subscriberCount)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <select
                        value={c.status}
                        onChange={(e) =>
                          handleContactStatus(
                            c.id,
                            e.target.value as OutreachContact['status'],
                          )
                        }
                        className="h-8 px-2 rounded-lg bg-black/60 border border-white/10 text-xs text-neutral-200"
                      >
                        <option value="queued">В очереди</option>
                        <option value="sent">Отправлено</option>
                        <option value="skipped">Пропустить</option>
                      </select>

                      <button
                        type="button"
                        onClick={() => handleDeleteContact(c.id)}
                        className="p-1.5 rounded-lg text-neutral-500 hover:text-white hover:bg-white/[0.08] transition-colors"
                        title="Удалить"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Template & Sent Logs */}
          <section className="lg:col-span-5 space-y-4">
            <div className="liquid-glass rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium text-white">
                  <FileText className="w-4 h-4 text-neutral-300" />
                  <span>Шаблон</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedTplId('');
                    setTplName('Новый шаблон');
                    setTplBody(
                      'Здравствуйте! Увидел ваш канал «{title}» ({url}) — есть предложение по сотрудничеству.',
                    );
                  }}
                  className="text-xs text-neutral-300 hover:text-white underline-offset-4 hover:underline"
                >
                  + Новый
                </button>
              </div>

              {data.templates.length > 0 && (
                <select
                  value={selectedTplId}
                  onChange={(e) => {
                    const tpl = data.templates.find((t) => t.id === e.target.value);
                    if (tpl) {
                      setSelectedTplId(tpl.id);
                      setTplName(tpl.name);
                      setTplBody(tpl.body);
                    }
                  }}
                  className="w-full h-9 px-3 rounded-lg bg-black/60 border border-white/10 text-xs text-white"
                >
                  {data.templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}

              <form onSubmit={handleSaveTemplate} className="space-y-3">
                <input
                  type="text"
                  required
                  value={tplName}
                  onChange={(e) => setTplName(e.target.value)}
                  placeholder="Название шаблона"
                  className="w-full h-9 px-3 rounded-lg bg-black/50 border border-white/10 text-xs text-white"
                />
                <textarea
                  rows={4}
                  required
                  value={tplBody}
                  onChange={(e) => setTplBody(e.target.value)}
                  className="w-full p-3 rounded-lg bg-black/50 border border-white/10 text-xs text-white leading-relaxed"
                />
                <div className="text-[11px] text-neutral-500">
                  Переменные: <span className="font-mono text-neutral-300">{'{title}'}</span>,{' '}
                  <span className="font-mono text-neutral-300">{'{url}'}</span>,{' '}
                  <span className="font-mono text-neutral-300">{'{{subs}}'}</span>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="submit"
                    className="h-9 px-3.5 rounded-xl bg-white/[0.07] hover:bg-white/[0.12] border border-white/10 text-xs font-medium text-white transition-colors"
                  >
                    Сохранить
                  </button>
                  <button
                    type="button"
                    disabled={generating}
                    onClick={handleGenerateBatch}
                    className="h-9 px-3.5 rounded-xl bg-white/[0.07] hover:bg-white/[0.12] border border-white/10 text-xs font-medium text-white transition-colors disabled:opacity-50"
                  >
                    {generating ? '...' : 'Предпросмотр текстов'}
                  </button>
                </div>
              </form>
            </div>

            {data.sentLogs && data.sentLogs.length > 0 && (
              <div className="liquid-glass rounded-2xl p-5 space-y-3">
                <div className="text-sm font-medium text-white">
                  Журнал отправки ({data.sentLogs.length})
                </div>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {data.sentLogs.slice(0, 25).map((log) => (
                    <div
                      key={log.id}
                      className="p-2.5 rounded-xl bg-black/40 border border-white/[0.06] flex items-start justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="text-white truncate">{log.contactValue}</div>
                        <div className="text-[11px] text-neutral-500 truncate">{log.detail}</div>
                      </div>
                      {log.status === 'sent' ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-white shrink-0 mt-0.5" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-neutral-500 shrink-0 mt-0.5" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {generated.length > 0 && (
              <div className="liquid-glass rounded-2xl p-5 space-y-3">
                <div className="text-sm font-medium text-white">
                  Тексты ({generated.length})
                </div>
                <div className="space-y-2.5 max-h-64 overflow-y-auto">
                  {generated.map((item) => (
                    <div
                      key={item.contactId}
                      className="p-3 rounded-xl bg-black/45 border border-white/[0.06] space-y-1.5"
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-medium text-white truncate">
                          {item.channelTitle} · {item.contactValue}
                        </span>
                        <button
                          type="button"
                          onClick={async () => {
                            await navigator.clipboard.writeText(item.message);
                            onNotify('Скопировано');
                          }}
                          className="text-neutral-300 hover:text-white flex items-center gap-1 shrink-0"
                        >
                          <Copy className="w-3 h-3" />
                          <span>Копировать</span>
                        </button>
                      </div>
                      <p className="text-xs text-neutral-300 whitespace-pre-line">{item.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
