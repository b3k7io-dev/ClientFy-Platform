import React, {useEffect, useState} from 'react';
import {motion} from 'motion/react';
import {History, ArrowUpRight, Search} from 'lucide-react';
import {apiRequest, ApiError} from '../api';
import type {
  SearchFilters,
  SearchHistoryFull,
  SearchHistorySummary,
  YouTubeChannelResult,
} from '../types';

interface HistoryViewProps {
  token: string;
  onRestoreSearch: (filters: SearchFilters, results: YouTubeChannelResult[]) => void;
  onGoToSearch: () => void;
  onNotify: (msg: string, tone?: 'info' | 'error') => void;
}

export function HistoryView({
  token,
  onRestoreSearch,
  onGoToSearch,
  onNotify,
}: HistoryViewProps) {
  const [entries, setEntries] = useState<SearchHistorySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingEntryId, setLoadingEntryId] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    apiRequest<{entries: SearchHistorySummary[]}>('/api/history', {token})
      .then((res) => {
        if (active) setEntries(res.entries);
      })
      .catch((err) => {
        if (active) {
          onNotify(err instanceof ApiError ? err.message : 'Ошибка загрузки истории', 'error');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token, onNotify]);

  const filtered = entries.filter((item) =>
    item.filters.query.toLowerCase().includes(filterQuery.trim().toLowerCase()),
  );

  const grouped = filtered.reduce<Record<string, SearchHistorySummary[]>>((acc, item) => {
    if (!acc[item.ptDate]) acc[item.ptDate] = [];
    acc[item.ptDate].push(item);
    return acc;
  }, {});

  const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

  const handleOpenEntry = async (id: string) => {
    setLoadingEntryId(id);
    try {
      const res = await apiRequest<{entry: SearchHistoryFull}>(`/api/history/${id}`, {token});
      onRestoreSearch(res.entry.filters, res.entry.results);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'Не удалось открыть подборку', 'error');
    } finally {
      setLoadingEntryId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="liquid-glass rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-white">История</h1>

        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-neutral-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="Фильтр..."
            className="rgb-focus-ring w-full h-10 pl-9 pr-3 rounded-xl bg-black/50 border border-white/10 text-xs text-white placeholder:text-neutral-600 focus:outline-none"
          />
        </div>
      </div>

      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="liquid-glass-subtle rounded-2xl h-20 animate-pulse" />
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="liquid-glass-subtle rounded-2xl p-10 text-center">
          <History className="w-7 h-7 text-neutral-600 mx-auto" />
          <div className="mt-3 text-sm font-medium text-neutral-300">
            {entries.length === 0 ? 'История пуста' : 'Ничего не найдено'}
          </div>
          <button
            type="button"
            onClick={onGoToSearch}
            className="mt-4 h-9 px-4 rounded-xl bg-white hover:bg-neutral-200 text-black text-xs font-semibold transition-colors"
          >
            К поиску
          </button>
        </div>
      )}

      {!loading &&
        sortedDates.map((dateStr, groupIdx) => (
          <motion.section
            key={dateStr}
            initial={{opacity: 0, y: 8}}
            animate={{opacity: 1, y: 0}}
            transition={{duration: 0.2, delay: groupIdx * 0.04}}
            className="space-y-2.5"
          >
            <div className="text-xs font-mono text-neutral-500 px-1">
              {dateStr} · {grouped[dateStr].length}
            </div>

            <div className="liquid-glass rounded-2xl divide-y divide-white/[0.06]">
              {grouped[dateStr].map((item) => (
                <div
                  key={item.id}
                  className="p-4 sm:px-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-white/[0.02] transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate">
                      {item.filters.query}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-neutral-400">
                      <span className="font-mono text-neutral-200">
                        {item.totalFound} кан.
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {item.filters.days > 0 ? `${item.filters.days} дн.` : 'Все'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{item.filters.lang.toUpperCase()}</span>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={loadingEntryId === item.id}
                    onClick={() => handleOpenEntry(item.id)}
                    className="h-9 px-3.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-xs font-medium text-white flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 self-start sm:self-center"
                  >
                    <span>{loadingEntryId === item.id ? 'Загрузка...' : 'Открыть'}</span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </motion.section>
        ))}
    </div>
  );
}
