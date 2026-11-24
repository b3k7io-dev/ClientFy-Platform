import {DateTime} from 'luxon';
import {sanitizeHttpUrl} from './security.ts';
import type {
  ExtractedLinks,
  LinkSourceItem,
  RecentVideoItem,
  SearchFilters,
  YouTubeChannelResult,
} from './types.ts';

export class YouTubeConfigError extends Error {
  code = 'YOUTUBE_API_KEY_MISSING' as const;
  constructor(
    message = 'YOUTUBE_API_KEY не задан на сервере. Добавьте ключ в Secrets/переменные окружения.',
  ) {
    super(message);
    this.name = 'YouTubeConfigError';
  }
}

export class YouTubeApiError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'YouTubeApiError';
    this.status = status;
  }
}

export function isYoutubeConfigured(): boolean {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  return Boolean(key && key !== 'MY_YOUTUBE_API_KEY');
}

const SHORT_MAX_SECONDS = 60;

function parseIso8601DurationToSeconds(iso: string | undefined): number | null {
  if (!iso) return null;
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

export function isShortVideo(durationIso: string | undefined): boolean {
  const secs = parseIso8601DurationToSeconds(durationIso);
  if (secs === null) return false;
  return secs <= SHORT_MAX_SECONDS;
}

export function detectLanguage(text: string, defaultLang = '', country = ''): 'ru' | 'en' | 'other' {
  const langLower = defaultLang.toLowerCase();
  if (langLower.startsWith('ru')) return 'ru';
  if (langLower.startsWith('en')) return 'en';

  const cyrillicMatches = text.match(/[\u0400-\u04FF]/g)?.length ?? 0;
  const latinMatches = text.match(/[a-zA-Z]/g)?.length ?? 0;

  if (cyrillicMatches > 5 && cyrillicMatches >= latinMatches * 0.3) return 'ru';
  if (latinMatches > 10 && cyrillicMatches === 0) return 'en';

  const c = country.toUpperCase();
  if (c === 'RU' || c === 'BY' || c === 'KZ' || c === 'UA') return 'ru';
  if (c === 'US' || c === 'GB' || c === 'CA' || c === 'AU') return 'en';
  return 'other';
}

const NON_PERSONAL_TG = new Set([
  'joinchat',
  'share',
  'iv',
  's',
  'c',
  'addstickers',
  'addemoji',
  'proxy',
  'socks',
  'setlanguage',
]);

export function isPersonalTgUsername(username: string): boolean {
  const clean = (username || '').trim().replace(/^@/, '');
  if (!clean || clean.includes('+')) return false;
  if (NON_PERSONAL_TG.has(clean.toLowerCase())) return false;
  return /^[A-Za-z0-9_]{4,}$/.test(clean);
}

export function extractPersonalTgHandles(urls: string[], text = ''): string[] {
  const found = new Set<string>();
  const blob = `${urls.join('\n')}\n${text}`;
  const tgRe = /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,})/gi;
  let m: RegExpExecArray | null;
  while ((m = tgRe.exec(blob)) !== null) {
    if (m[1] && isPersonalTgUsername(m[1])) {
      found.add(`https://t.me/${m[1]}`);
    }
  }
  const atRe = /(?<![A-Za-z0-9_])@([A-Za-z0-9_]{4,})/g;
  while ((m = atRe.exec(blob)) !== null) {
    if (m[1] && isPersonalTgUsername(m[1]) && !blob.includes(`@${m[1]}.`)) {
      found.add(`https://t.me/${m[1]}`);
    }
  }
  return Array.from(found);
}

function createEmptyLinks(): ExtractedLinks {
  return {
    telegram: [],
    instagram: [],
    tiktok: [],
    discord: [],
    emails: [],
    websites: [],
  };
}

export function extractRawLinksList(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (raw: string) => {
    const cleaned = raw.trim().replace(/[.,;!?]+$/, '');
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(cleaned);
    }
  };

  const urlRegex = /(?:https?:\/\/[^\s)<>"']+|t\.me\/[^\s)<>"']+)/gi;
  for (const m of text.match(urlRegex) ?? []) {
    const normalized = m.toLowerCase().startsWith('t.me/') ? `https://${m}` : m;
    const safe = sanitizeHttpUrl(normalized);
    if (safe) add(safe);
  }

  const tgHandleRegex = /(?<![A-Za-z0-9_.])@([A-Za-z][A-Za-z0-9_]{3,30})\b/g;
  let match: RegExpExecArray | null;
  while ((match = tgHandleRegex.exec(text)) !== null) {
    const handle = match[1];
    if (handle && !text.includes(`@${handle}.`)) {
      add(`https://t.me/${handle}`);
    }
  }

  const emailRegex = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
  for (const m of text.match(emailRegex) ?? []) {
    add(m);
  }

  return out;
}

function classifyLinks(rawLinks: string[]): ExtractedLinks {
  const result = createEmptyLinks();
  const seen = new Set<string>();

  const pushUnique = (arr: string[], val: string) => {
    const k = val.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    arr.push(val);
  };

  for (const link of rawLinks) {
    const lower = link.toLowerCase();
    if (!lower.startsWith('http://') && !lower.startsWith('https://') && link.includes('@')) {
      pushUnique(result.emails, link);
      continue;
    }
    const safe = sanitizeHttpUrl(link);
    if (!safe) continue;
    if (lower.includes('t.me/') || lower.includes('telegram.me/')) {
      pushUnique(result.telegram, safe);
    } else if (lower.includes('instagram.com/')) {
      pushUnique(result.instagram, safe);
    } else if (lower.includes('tiktok.com/')) {
      pushUnique(result.tiktok, safe);
    } else if (lower.includes('discord.gg/') || lower.includes('discord.com/invite/')) {
      pushUnique(result.discord, safe);
    } else if (!lower.includes('youtube.com/') && !lower.includes('youtu.be/')) {
      pushUnique(result.websites, safe);
    }
  }

  return result;
}

interface YtSearchItem {
  id?: {videoId?: string};
  snippet?: {channelId?: string};
}

interface YtChannelItem {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    customUrl?: string;
    country?: string;
    defaultLanguage?: string;
    thumbnails?: {
      medium?: {url?: string};
      default?: {url?: string};
    };
  };
  statistics?: {
    subscriberCount?: string;
    videoCount?: string;
    viewCount?: string;
    hiddenSubscriberCount?: boolean;
  };
  contentDetails?: {
    relatedPlaylists?: {uploads?: string};
  };
}

interface YtVideoItem {
  id: string;
  contentDetails?: {duration?: string};
}

interface YtPlaylistItem {
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    resourceId?: {videoId?: string};
  };
  contentDetails?: {videoId?: string};
}

async function fetchYtJson<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_YOUTUBE_API_KEY') {
    throw new YouTubeConfigError();
  }

  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== '') url.searchParams.set(k, v);
  }
  url.searchParams.set('key', apiKey);

  const response = await fetch(url.toString(), {
    headers: {Accept: 'application/json', 'User-Agent': 'ClientFyWeb/1.0'},
  });

  if (!response.ok) {
    let reason = `HTTP ${response.status}`;
    try {
      const errBody = (await response.json()) as {error?: {message?: string}};
      if (errBody?.error?.message) reason = errBody.error.message;
    } catch {
      // ignore
    }
    throw new YouTubeApiError(`YouTube API: ${reason}`, response.status);
  }

  return (await response.json()) as T;
}

async function getVideoDetailsMap(videoIds: string[]): Promise<Map<string, YtVideoItem>> {
  const out = new Map<string, YtVideoItem>();
  const clean = videoIds.filter(Boolean);
  for (let i = 0; i < clean.length; i += 50) {
    const chunk = clean.slice(i, i + 50);
    if (chunk.length === 0) continue;
    const data = await fetchYtJson<{items?: YtVideoItem[]}>('videos', {
      part: 'contentDetails',
      id: chunk.join(','),
      maxResults: '50',
    });
    for (const item of data.items ?? []) {
      if (item.id) out.set(item.id, item);
    }
  }
  return out;
}

async function getRecentLongVideos(
  uploadsPlaylistId: string | undefined,
  maxResults = 3,
): Promise<Array<{id: string; title: string; description: string; publishedAt: string}>> {
  if (!uploadsPlaylistId) return [];
  try {
    const data = await fetchYtJson<{items?: YtPlaylistItem[]}>('playlistItems', {
      part: 'snippet,contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: '15',
    });
    const items = data.items ?? [];
    const vids = items
      .map((v) => v.snippet?.resourceId?.videoId || v.contentDetails?.videoId || '')
      .filter(Boolean);
    const detailsMap = await getVideoDetailsMap(vids);

    const longItems: Array<{id: string; title: string; description: string; publishedAt: string}> = [];
    for (const v of items) {
      const vid = v.snippet?.resourceId?.videoId || v.contentDetails?.videoId || '';
      if (!vid) continue;
      const det = detailsMap.get(vid);
      if (isShortVideo(det?.contentDetails?.duration)) continue;
      longItems.push({
        id: vid,
        title: v.snippet?.title || '',
        description: v.snippet?.description || '',
        publishedAt: v.snippet?.publishedAt || '',
      });
      if (longItems.length >= maxResults) break;
    }
    return longItems;
  } catch {
    return [];
  }
}

export async function searchYouTubeChannels(filters: SearchFilters): Promise<YouTubeChannelResult[]> {
  const limit = Math.max(1, Math.min(50, Math.trunc(filters.count || 5)));
  const publishedAfter =
    filters.days > 0 ? DateTime.utc().minus({days: filters.days}).toISO() || '' : '';

  const channelIds: string[] = [];
  const seenIds = new Set<string>();
  let nextToken = '';
  let pages = 0;

  while (channelIds.length < limit * 3 && pages < 4) {
    pages += 1;
    const params: Record<string, string> = {
      part: 'snippet',
      q: filters.query.trim(),
      type: 'video',
      order: 'date',
      maxResults: '50',
    };
    if (publishedAfter) params.publishedAfter = publishedAfter;
    if (filters.lang === 'ru' || filters.lang === 'en') {
      params.relevanceLanguage = filters.lang;
    }
    if (nextToken) params.pageToken = nextToken;

    const vdata = await fetchYtJson<{items?: YtSearchItem[]; nextPageToken?: string}>(
      'search',
      params,
    );
    const searchItems = vdata.items ?? [];
    const searchVids = searchItems.map((i) => i.id?.videoId || '').filter(Boolean);
    const details = await getVideoDetailsMap(searchVids);

    for (const item of searchItems) {
      const vid = item.id?.videoId || '';
      if (!vid) continue;
      const det = details.get(vid);
      if (isShortVideo(det?.contentDetails?.duration)) continue;
      const cid = item.snippet?.channelId;
      if (cid && !seenIds.has(cid)) {
        seenIds.add(cid);
        channelIds.push(cid);
      }
    }

    nextToken = vdata.nextPageToken || '';
    if (!nextToken) break;
  }

  const cappedIds = channelIds.slice(0, 50);
  if (cappedIds.length === 0) return [];

  const channelsData = await fetchYtJson<{items?: YtChannelItem[]}>('channels', {
    part: 'snippet,statistics,contentDetails',
    id: cappedIds.join(','),
    maxResults: '50',
  });

  const channelItems = channelsData.items ?? [];

  // Enrich each channel with its 3 recent long videos (matching original youtube.py)
  const enrichedRaw = await Promise.all(
    channelItems.slice(0, Math.min(channelItems.length, limit * 2 + 10)).map(async (ch) => {
      const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
      const recentRaw = await getRecentLongVideos(uploads, 3);
      return {ch, recentRaw};
    }),
  );

  const normalized: YouTubeChannelResult[] = [];

  for (const {ch, recentRaw} of enrichedRaw) {
    const sn = ch.snippet ?? {};
    const st = ch.statistics ?? {};
    const desc = sn.description || '';
    const title = sn.title || 'Без названия';
    const customUrl = sn.customUrl || '';
    const handle = customUrl.startsWith('@') ? customUrl : customUrl ? `@${customUrl}` : '';
    const country = sn.country || '';

    const recentVideos: RecentVideoItem[] = recentRaw.map((v) => {
      const videoLinks = extractRawLinksList(v.description);
      return {
        id: v.id,
        title: v.title,
        publishedAt: v.publishedAt,
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`,
        hasLink: videoLinks.length > 0,
      };
    });

    const channelLinks = extractRawLinksList(desc);
    const linkSources: LinkSourceItem[] = [];
    const seenUrls = new Set<string>();

    for (const url of channelLinks) {
      if (!seenUrls.has(url.toLowerCase())) {
        seenUrls.add(url.toLowerCase());
        linkSources.push({url, source: 'Описание канала'});
      }
    }

    recentRaw.forEach((v, idx) => {
      for (const url of extractRawLinksList(v.description)) {
        if (!seenUrls.has(url.toLowerCase())) {
          seenUrls.add(url.toLowerCase());
          linkSources.push({url, source: `Видео №${idx + 1}`});
        }
      }
    });

    const allRawLinks = linkSources.map((s) => s.url).slice(0, 12);
    const links = classifyLinks(allRawLinks);
    const linkInChannelDescription = channelLinks.length > 0;
    const linkInRecentVideos = recentVideos.some((r) => r.hasLink);

    const subscriberCount = st.hiddenSubscriberCount ? 0 : Number(st.subscriberCount || 0);
    const videoCount = Number(st.videoCount || 0);
    const viewCount = Number(st.viewCount || 0);

    const textBlob = `${title} ${desc} ${recentRaw.map((v) => `${v.title} ${v.description}`).join(' ')}`;
    const detectedLang = detectLanguage(textBlob, sn.defaultLanguage || '', country);

    const rawThumb = sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || '';
    const thumbnailUrl = rawThumb ? sanitizeHttpUrl(rawThumb) || '' : '';

    const item: YouTubeChannelResult = {
      channelId: ch.id,
      title,
      handle,
      customUrl,
      url: customUrl
        ? `https://www.youtube.com/${encodeURIComponent(customUrl)}`
        : `https://www.youtube.com/channel/${encodeURIComponent(ch.id)}`,
      thumbnailUrl,
      description: desc,
      subscriberCount,
      videoCount,
      viewCount,
      country,
      detectedLang,
      recentVideos,
      linkInChannelDescription,
      linkInRecentVideos,
      anyLink: linkInChannelDescription || linkInRecentVideos,
      links,
      linkSources: linkSources.slice(0, 12),
    };

    if (filters.lang !== 'any' && item.detectedLang !== filters.lang) continue;
    if (filters.requireChannelLink && !item.linkInChannelDescription) continue;
    if (filters.requireRecentLink && !item.linkInRecentVideos) continue;
    if (filters.minSubs > 0 && subscriberCount < filters.minSubs) continue;
    if (filters.maxSubs !== null && subscriberCount > filters.maxSubs) continue;

    if (filters.days > 0 && recentVideos.length > 0) {
      const cutoff = DateTime.utc().minus({days: filters.days});
      const hasRecent = recentVideos.some((v) => {
        if (!v.publishedAt) return false;
        const dt = DateTime.fromISO(v.publishedAt);
        return dt.isValid && dt >= cutoff;
      });
      if (!hasRecent) continue;
    }

    normalized.push(item);
  }

  normalized.sort((a, b) => {
    const tsA = a.recentVideos[0]?.publishedAt ? Date.parse(a.recentVideos[0].publishedAt) || 0 : 0;
    const tsB = b.recentVideos[0]?.publishedAt ? Date.parse(b.recentVideos[0].publishedAt) || 0 : 0;
    if (tsB !== tsA) return tsB - tsA;
    return b.subscriberCount - a.subscriberCount;
  });

  return normalized.slice(0, limit);
}
