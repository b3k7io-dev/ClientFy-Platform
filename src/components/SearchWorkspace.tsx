import React, {useState} from 'react';
import {AnimatePresence, motion} from 'motion/react';
import {
  Search,
  ExternalLink,
  Copy,
  UserPlus,
  Download,
  SlidersHorizontal,
  AlertTriangle,
  Youtube,
} from 'lucide-react';
import {apiRequest, ApiError, formatCompactNumber, isSafeHttpUrl} from '../api';
import type {
  QuotaSummary,
  SearchFilters,
  YouTubeChannelResult,
} from '../types';

interface SearchWorkspaceProps {
  token: string;
  hasYoutubeKey: boolean;
  quota: QuotaSummary;
  initialResults?: YouTubeChannelResult[];
  initialFilters?: SearchFilters | null;
  onQuotaUpdate: (quota: QuotaSummary) => void;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
  onGoToPlans: () => void;
}

const DAYS_OPTIONS = [
  {label: 'Все', value: 0},
  {label: '7 дн', value: 7},
  {label: '14 дн', value: 14},
  {label: '30 дн', value: 30},
];

const COUNT_OPTIONS = [5, 10, 15, 25];

const SUBS_PRESETS = [
  {id: 'any', label: 'Любые', min: 0, max: null},
  {id: '0_1k', label: '0–1K', min: 0, max: 1000},
  {id: '1k_10k', label: '1K–10K', min: 1000, max: 10000},
  {id: '10k_100k', label: '10K–100K', min: 10000, max: 100000},
  {id: '100k_1m', label: '100K–1M', min: 100000, max: 1000000},
  {id: '1m_plus', label: '1M+', min: 1000000, max: null},
] as const;

export function SearchWorkspace({
  token,
  hasYoutubeKey,
  quota,
  initialResults,
  initialFilters,
  onQuotaUpdate,
  onNotify,
  onGoToPlans,
}: SearchWorkspaceProps) {
  const [query, setQuery] = useState(initialFilters?.query || '');
  const [days, setDays] = useState<number>(initialFilters?.days ?? 7);
  const [count, setCount] = useState<number>(initialFilters?.count ?? 5);
  const [minSubs, setMinSubs] = useState<number>(initialFilters?.minSubs ?? 0);
  const [maxSubs, setMaxSubs] = useState<number | null>(initialFilters?.maxSubs ?? null);
  const [customRangeOpen, setCustomRangeOpen] = useState(false);
  const [lang, setLang] = useState<'any' | 'ru' | 'en'>(initialFilters?.lang ?? 'any');
  const [requireChannelLink, setRequireChannelLink] = useState<boolean>(
    initialFilters?.requireChannelLink ?? false,
  );
  const [requireRecentLink, setRequireRecentLink] = useState<boolean>(
    initialFilters?.requireRecentLink ?? false,
  );

  const [results, setResults] = useState<YouTubeChannelResult[]>(initialResults ?? []);
  const [stats, setStats] = useState<{
    inDescription: number;
    onlyInVideos: number;
    noLinks: number;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(
    Boolean(
      (initialFilters?.minSubs && initialFilters.minSubs > 0) ||
        initialFilters?.maxSubs !== null ||
        initialFilters?.requireChannelLink ||
        initialFilters?.requireRecentLink,
    ),
  );

  const activePresetId =
    SUBS_PRESETS.find((p) => p.min === minSubs && p.max === maxSubs)?.id || 'custom';
  const activeAdvancedCount =
    (minSubs > 0 || maxSubs !== null ? 1 : 0) +
    (requireChannelLink ? 1 : 0) +
    (requireRecentLink ? 1 : 0);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim().length < 2) {
      setErrorMsg('Введите тему (минимум 2 символа)');
      return;
    }

    setErrorMsg(null);
    setLoading(true);
    try {
      const data = await apiRequest<{
        channels: YouTubeChannelResult[];
        stats: {inDescription: number; onlyInVideos: number; noLinks: number};
        quota: QuotaSummary;
        cappedNotice?: string | null;
      }>('/api/youtube/search', {
        method: 'POST',
        token,
        body: {
          query: query.trim(),
          days,
          count,
          minSubs,
          maxSubs,
          lang,
          requireChannelLink,
          requireRecentLink,
        },
      });
      setResults(data.channels);
      setStats(data.stats);
      onQuotaUpdate(data.quota);
      if (data.cappedNotice) {
        onNotify(data.cappedNotice);
      } else {
        onNotify(`Найдено: ${data.channels.length}`);
      }
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : 'Ошибка поиска');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyContacts = async (ch: YouTubeChannelResult) => {
    const items = ch.linkSources.map((s) => `${s.url} (${s.source})`);
    const payload = items.length > 0 ? items.join('\n') : ch.url;
    try {
      await navigator.clipboard.writeText(payload);
      onNotify(`Скопировано: ${ch.title}`);
    } catch {
      onNotify('Не удалось скопировать', 'error');
    }
  };

  const handleAddToOutreach = async (ch: YouTubeChannelResult) => {
    const contactValue =
      ch.links.telegram[0] ||
      ch.links.emails[0] ||
      ch.links.instagram[0] ||
      ch.links.websites[0] ||
      ch.url;

    const contactType = ch.links.telegram[0]
      ? 'telegram'
      : ch.links.emails[0]
        ? 'email'
        : ch.links.websites[0]
          ? 'website'
          : 'social';

    try {
      const res = await apiRequest<{added: number}>('/api/outreach/contacts', {
        method: 'POST',
        token,
        body: {
          channelId: ch.channelId,
          channelTitle: ch.title,
          channelUrl: ch.url,
          handle: ch.handle,
          contactValue,
          contactType,
          subscriberCount: ch.subscriberCount,
        },
      });
      onNotify(res.added > 0 ? `Добавлено в рассылку: ${ch.title}` : 'Уже в базе рассылки');
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Ошибка сохранения', 'error');
    }
  };

  const handleExportCsv = () => {
    if (results.length === 0) return;
    const headers = [
      'Название',
      'Handle',
      'Подписчики',
      'Видео',
      'Язык',
      'Telegram',
      'Email',
      'Ссылки',
      'URL канала',
    ];
    const rows = results.map((ch) => [
      ch.title,
      ch.handle,
      String(ch.subscriberCount),
      String(ch.videoCount),
      ch.detectedLang,
      ch.links.telegram.join(' | '),
      ch.links.emails.join(' | '),
      ch.linkSources.map((s) => `${s.url} [${s.source}]`).join(' | '),
      ch.url,
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([`\uFEFF${csv}`], {type: 'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clientfy_${query.trim().replace(/\s+/g, '_') || 'channels'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {!hasYoutubeKey && (
        <div className="liquid-glass rounded-2xl p-4 border border-white/15 flex items-center gap-3 text-xs text-neutral-300">
          <AlertTriangle className="w-4 h-4 text-neutral-300 shrink-0" />
          <span>Добавьте <span className="font-mono text-white">YOUTUBE_API_KEY</span> в Secrets сервера.</span>
        </div>
      )}

      {/* Search Bar & Filters */}
      <section className="liquid-glass-elevated rounded-2xl p-5 sm:p-6">
        <div className="max-w-3xl mx-auto">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <h1 className="text-xl font-semibold text-white">Поиск каналов</h1>
            <div className="text-xs text-neutral-400 font-mono">
              Квота: <span className="text-white">{quota.totalAvailable}</span>
            </div>
          </div>

          <form onSubmit={handleSearch} className="space-y-4">
            <div className="rgb-focus-ring rounded-2xl bg-black/55 border border-white/10 p-1.5 flex items-center gap-2">
              <Search className="w-4 h-4 text-neutral-500 ml-3 shrink-0" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Тема или ниша..."
                className="flex-1 bg-transparent h-10 text-sm text-white placeholder:text-neutral-600 focus:outline-none min-w-0"
              />
              <button
                type="submit"
                disabled={loading}
                className="h-10 px-5 rounded-xl bg-white hover:bg-neutral-200 text-black font-semibold text-xs transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                {loading ? 'Поиск...' : 'Найти'}
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] text-neutral-500">Период</span>
                <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                  {DAYS_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setDays(opt.value)}
                      className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        days === opt.value
                          ? 'bg-white text-black'
                          : 'text-neutral-400 hover:text-white'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] text-neutral-500">Количество</span>
                <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                  {COUNT_OPTIONS.map((cnt) => (
                    <button
                      key={cnt}
                      type="button"
                      onClick={() => setCount(cnt)}
                      className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-mono font-medium transition-colors whitespace-nowrap shrink-0 ${
                        count === cnt
                          ? 'bg-white text-black'
                          : 'text-neutral-400 hover:text-white'
                      }`}
                    >
                      {cnt}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] text-neutral-500">Язык</span>
                <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                  {[
                    {id: 'any', label: 'Любой'},
                    {id: 'ru', label: 'RU'},
                    {id: 'en', label: 'EN'},
                  ].map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setLang(item.id as 'any' | 'ru' | 'en')}
                      className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        lang === item.id
                          ? 'bg-white text-black'
                          : 'text-neutral-400 hover:text-white'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="h-8 px-3 rounded-lg bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.08] text-xs text-neutral-300 flex items-center gap-2 transition-colors whitespace-nowrap"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>Фильтры</span>
                {activeAdvancedCount > 0 && (
                  <span className="font-mono text-white">({activeAdvancedCount})</span>
                )}
              </button>
              <span className="text-[11px] text-neutral-500">Без Shorts</span>
            </div>

            <AnimatePresence initial={false}>
              {advancedOpen && (
                <motion.div
                  initial={{opacity: 0, height: 0}}
                  animate={{opacity: 1, height: 'auto'}}
                  exit={{opacity: 0, height: 0}}
                  transition={{duration: 0.2, ease: [0.16, 1, 0.3, 1]}}
                  className="overflow-hidden"
                >
                  <div className="pt-3 border-t border-white/[0.07] space-y-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-neutral-500 mr-1">Подписчики:</span>
                      {SUBS_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => {
                            setMinSubs(preset.min);
                            setMaxSubs(preset.max);
                            setCustomRangeOpen(false);
                          }}
                          className={`py-1.5 px-2.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
                            activePresetId === preset.id && !customRangeOpen
                              ? 'bg-white border-white text-black'
                              : 'bg-white/[0.02] border-white/[0.07] text-neutral-400 hover:text-white'
                          }`}
                        >
                          {preset.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setCustomRangeOpen((v) => !v)}
                        className={`py-1.5 px-2.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
                          customRangeOpen || activePresetId === 'custom'
                            ? 'bg-white border-white text-black'
                            : 'bg-white/[0.02] border-white/[0.07] text-neutral-400 hover:text-white'
                        }`}
                      >
                        Свой
                      </button>
                    </div>

                    {customRangeOpen && (
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-neutral-500 mb-1">Минимум</label>
                          <input
                            type="number"
                            min={0}
                            value={minSubs}
                            onChange={(e) => setMinSubs(Math.max(0, Number(e.target.value) || 0))}
                            className="w-full h-9 px-3 rounded-lg bg-black/50 border border-white/10 text-xs font-mono text-white"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-neutral-500 mb-1">Максимум</label>
                          <input
                            type="number"
                            min={0}
                            value={maxSubs ?? ''}
                            onChange={(e) =>
                              setMaxSubs(
                                e.target.value === ''
                                  ? null
                                  : Math.max(0, Number(e.target.value) || 0),
                              )
                            }
                            className="w-full h-9 px-3 rounded-lg bg-black/50 border border-white/10 text-xs font-mono text-white"
                          />
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-5 text-xs text-neutral-300">
                      <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={requireChannelLink}
                          onChange={(e) => setRequireChannelLink(e.target.checked)}
                          className="rounded border-white/20 bg-black text-white focus:ring-white/30"
                        />
                        <span>Ссылка в профиле</span>
                      </label>

                      <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={requireRecentLink}
                          onChange={(e) => setRequireRecentLink(e.target.checked)}
                          className="rounded border-white/20 bg-black text-white focus:ring-white/30"
                        />
                        <span>Ссылка в видео</span>
                      </label>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </form>

          {errorMsg && (
            <div className="mt-4 p-3.5 rounded-xl bg-red-500/10 border border-red-500/25 flex flex-wrap items-center justify-between gap-3 text-xs text-red-200">
              <span>{errorMsg}</span>
              {quota.totalAvailable <= 0 && (
                <button
                  type="button"
                  onClick={onGoToPlans}
                  className="px-3 py-1.5 rounded-lg bg-white text-black font-semibold whitespace-nowrap"
                >
                  Тарифы
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Results Header & Export */}
      <section className="space-y-3">
        {(loading || results.length > 0) && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-neutral-400 flex flex-wrap items-center gap-x-2">
              {loading ? (
                <span>Поиск каналов...</span>
              ) : (
                <>
                  <span>
                    Найдено: <span className="font-mono text-white">{results.length}</span>
                  </span>
                  {stats && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>В описании: {stats.inDescription}</span>
                      <span aria-hidden="true">·</span>
                      <span>В видео: {stats.onlyInVideos}</span>
                    </>
                  )}
                </>
              )}
            </div>

            {results.length > 0 && (
              <button
                type="button"
                onClick={handleExportCsv}
                className="h-9 px-3.5 rounded-xl bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-xs font-medium text-white flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                <span>CSV</span>
              </button>
            )}
          </div>
        )}

        {loading && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((idx) => (
              <div key={idx} className="liquid-glass-subtle rounded-2xl p-5 h-44 animate-pulse" />
            ))}
          </div>
        )}

        {!loading && results.length === 0 && (
          <div className="liquid-glass-subtle rounded-2xl p-10 text-center">
            <Youtube className="w-7 h-7 text-neutral-600 mx-auto" />
            <div className="mt-2.5 text-sm font-medium text-neutral-300">Нет результатов</div>
          </div>
        )}

        {!loading && results.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {results.map((ch, idx) => {
              const isExpanded = expandedId === ch.channelId;
              return (
                <motion.article
                  key={ch.channelId}
                  initial={{opacity: 0, y: 10}}
                  animate={{opacity: 1, y: 0}}
                  transition={{duration: 0.22, delay: Math.min(idx * 0.03, 0.24)}}
                  className="liquid-glass rounded-2xl p-5 flex flex-col justify-between gap-4"
                >
                  <div>
                    <div className="flex items-start gap-3.5">
                      {ch.thumbnailUrl && isSafeHttpUrl(ch.thumbnailUrl) ? (
                        <img
                          src={ch.thumbnailUrl}
                          alt={ch.title}
                          referrerPolicy="no-referrer"
                          className="w-12 h-12 rounded-xl object-cover shrink-0 border border-white/10 grayscale-[20%]"
                        />
                      ) : (
                        <div className="w-12 h-12 rounded-xl bg-white/[0.06] border border-white/10 flex items-center justify-center shrink-0 text-sm font-semibold text-neutral-300">
                          {ch.title.slice(0, 2).toUpperCase()}
                        </div>
                      )}

                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="text-base font-semibold text-white truncate">
                            {ch.title}
                          </h3>
                          <a
                            href={isSafeHttpUrl(ch.url) ? ch.url : '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-neutral-500 hover:text-white transition-colors shrink-0 p-1"
                            title="YouTube"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        </div>

                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-400">
                          {ch.handle && <span className="font-mono text-neutral-300">{ch.handle}</span>}
                          {ch.handle && <span aria-hidden="true">·</span>}
                          <span className="font-mono text-white">
                            {formatCompactNumber(ch.subscriberCount)}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{ch.videoCount} вид.</span>
                          <span aria-hidden="true">·</span>
                          <span>{ch.detectedLang.toUpperCase()}</span>
                        </div>
                      </div>
                    </div>

                    {ch.description && (
                      <div className="mt-3">
                        <p
                          className={`text-xs leading-relaxed text-neutral-300 ${
                            isExpanded ? 'whitespace-pre-line' : 'line-clamp-2'
                          }`}
                        >
                          {ch.description}
                        </p>
                        {ch.description.length > 140 && (
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedId(isExpanded ? null : ch.channelId)
                            }
                            className="mt-1 text-xs text-neutral-400 hover:text-white"
                          >
                            {isExpanded ? 'Свернуть' : 'Полностью'}
                          </button>
                        )}
                      </div>
                    )}

                    {ch.recentVideos.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-1">
                        {ch.recentVideos.map((v, i) => (
                          <div key={v.id} className="flex items-center justify-between gap-2 text-xs">
                            <a
                              href={isSafeHttpUrl(v.url) ? v.url : '#'}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-neutral-300 hover:text-white truncate"
                            >
                              {i + 1}. {v.title}
                            </a>
                            <span className="font-mono text-[11px] text-neutral-500 shrink-0">
                              {v.publishedAt
                                ? new Date(v.publishedAt).toLocaleDateString('ru-RU')
                                : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="mt-3 pt-3 border-t border-white/[0.06]">
                      {ch.linkSources.length > 0 ? (
                        <div className="space-y-1">
                          {ch.linkSources.slice(0, 6).map((item) => {
                            const href =
                              item.url.includes('@') && !item.url.startsWith('http')
                                ? `mailto:${item.url}`
                                : item.url;
                            return (
                              <div
                                key={`${item.url}-${item.source}`}
                                className="flex items-center justify-between gap-2 text-xs"
                              >
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-neutral-200 hover:text-white underline underline-offset-4 truncate"
                                >
                                  {item.url}
                                </a>
                                <span className="text-[11px] text-neutral-500 shrink-0">
                                  {item.source}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="text-xs text-neutral-600">Ссылки не найдены</div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/[0.06]">
                    <button
                      type="button"
                      onClick={() => handleCopyContacts(ch)}
                      className="h-9 px-3 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-xs font-medium text-neutral-200 flex items-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>Копировать</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAddToOutreach(ch)}
                      className="h-9 px-3 rounded-lg bg-white hover:bg-neutral-200 text-xs font-semibold text-black flex items-center gap-1.5 transition-colors whitespace-nowrap"
                    >
                      <UserPlus className="w-3.5 h-3.5" />
                      <span>В рассылку</span>
                    </button>
                  </div>
                </motion.article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
