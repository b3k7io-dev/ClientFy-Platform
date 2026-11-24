export type UserRole = 'user' | 'admin';
export type PlanId = 'free' | 'pro' | 'max';
export type PaymentMethod = 'visa' | 'stars' | 'ton' | 'gram';
export type PaymentStatus = 'pending' | 'approved' | 'rejected';
export type PromoType = 'requests' | 'subscription';

export interface QuotaSummary {
  ptDate: string;
  resetAtIso: string;
  secondsUntilReset: number;
  planId: PlanId;
  planName: string;
  subscriptionUntil: string | null;
  subscriptionActive: boolean;
  dailyLimit: number;
  usedToday: number;
  remainingDaily: number;
  bonusRequests: number;
  totalAvailable: number;
}

export interface BotRuntimeStatus {
  running: boolean;
  username: string | null;
  mode: 'polling' | 'webhook' | 'idle';
  lastError: string | null;
}

export interface StarOrder {
  id: string;
  userId: string;
  username: string;
  planId: 'pro' | 'max';
  starsAmount: number;
  status: 'pending' | 'paid' | 'expired';
  telegramUserId: string | null;
  telegramChargeId: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface PublicUserProfile {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  blocked: boolean;
  planId: PlanId;
  subscriptionUntil: string | null;
  bonusRequests: number;
  telegramId?: string | null;
  telegramUsername?: string | null;
  isOwner?: boolean;
  createdAt: string;
  lastActiveAt: string;
  quota: QuotaSummary;
}

export interface AuthStatusResponse {
  adminConfigured: boolean;
  needsAdminClaim: boolean;
  envAdminActive: boolean;
  hasYoutubeKey: boolean;
  hasMtprotoConfig?: boolean;
  botStatus: BotRuntimeStatus;
  user: PublicUserProfile | null;
}

export interface SearchFilters {
  query: string;
  days: number;
  count: number;
  minSubs: number;
  maxSubs: number | null;
  lang: 'any' | 'ru' | 'en';
  requireChannelLink: boolean;
  requireRecentLink: boolean;
}

export interface RecentVideoItem {
  id: string;
  title: string;
  publishedAt: string;
  url: string;
  hasLink: boolean;
}

export interface LinkSourceItem {
  url: string;
  source: string;
}

export interface ExtractedLinks {
  telegram: string[];
  instagram: string[];
  tiktok: string[];
  discord: string[];
  emails: string[];
  websites: string[];
}

export interface YouTubeChannelResult {
  channelId: string;
  title: string;
  handle: string;
  customUrl: string;
  url: string;
  thumbnailUrl: string;
  description: string;
  subscriberCount: number;
  videoCount: number;
  viewCount: number;
  country: string;
  detectedLang: 'ru' | 'en' | 'other';
  recentVideos: RecentVideoItem[];
  linkInChannelDescription: boolean;
  linkInRecentVideos: boolean;
  anyLink: boolean;
  links: ExtractedLinks;
  linkSources: LinkSourceItem[];
}

export interface SearchHistorySummary {
  id: string;
  ptDate: string;
  createdAt: string;
  filters: SearchFilters;
  totalFound: number;
  stats?: {
    inDescription: number;
    onlyInVideos: number;
    noLinks: number;
  };
}

export interface SearchHistoryFull extends SearchHistorySummary {
  results: YouTubeChannelResult[];
}

export interface PlanDefinition {
  id: PlanId;
  name: string;
  audience: string;
  priceUsd: number;
  priceStars: number;
  dailyLimit: number;
  durationDays: number;
  maxResultsPerSearch: number;
  outreachEnabled: boolean;
  exportEnabled: boolean;
  highlights: string[];
}

export interface PaymentDetails {
  visaCardDetails: string;
  tonWalletAddress: string;
  gramWalletAddress: string;
  supportContact: string;
  channelUrl: string;
}

export interface PaymentApplication {
  id: string;
  userId: string;
  username: string;
  planId: PlanId;
  method: PaymentMethod;
  amountLabel: string;
  comment: string;
  receiptDataUrl: string | null;
  receiptName: string | null;
  status: PaymentStatus;
  adminNote: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export interface PromoCodeRecord {
  code: string;
  type: PromoType;
  value: number;
  plan: 'pro' | 'max';
  maxUses: number;
  usedBy: string[];
  active: boolean;
  createdAt: string;
}

export interface OutreachContact {
  id: string;
  channelId: string;
  channelTitle: string;
  channelUrl: string;
  handle: string;
  contactValue: string;
  contactType: 'telegram' | 'email' | 'website' | 'social';
  subscriberCount: number;
  status: 'queued' | 'sent' | 'skipped';
  addedAt: string;
  sentAt: string | null;
}

export interface OutreachTemplate {
  id: string;
  name: string;
  body: string;
  updatedAt: string;
}

export interface SentOutreachLog {
  id: string;
  contactId: string;
  channelTitle: string;
  contactValue: string;
  templateName: string;
  status: 'sent' | 'failed';
  detail: string;
  timestamp: string;
}

export interface UserbotAccountStatus {
  apiConfigured: boolean;
  connected: boolean;
  phoneMasked: string | null;
  displayName: string | null;
  username: string | null;
  connectedAt: string | null;
  pendingStep: 'idle' | 'code' | 'password';
  campaignRunning: boolean;
}

export interface OutreachPayload {
  contacts: OutreachContact[];
  templates: OutreachTemplate[];
  sentLogs: SentOutreachLog[];
  telegramAccount?: UserbotAccountStatus;
  campaign: {
    running: boolean;
    stopRequested: boolean;
    templateId: string | null;
    topics: string[];
    delaySecondsMin: number;
    delaySecondsMax: number;
    sentCount: number;
    failedCount: number;
    lastMessage: string;
    startedAt: string | null;
    finishedAt: string | null;
  };
}

export interface AdminOverview {
  totalUsers: number;
  activeSubscribers: number;
  blockedUsers: number;
  searchesToday: number;
  totalHistoryEntries: number;
  pendingPayments: number;
  activePromos: number;
  hasYoutubeKey: boolean;
  botStatus?: BotRuntimeStatus;
  ptDate: string;
}

export interface AppSettings {
  freeDailyLimit: number;
  proDailyLimit: number;
  maxDailyLimit: number;
  proPriceUsd: number;
  proPriceStars: number;
  maxPriceUsd: number;
  maxPriceStars: number;
  visaCardDetails: string;
  tonWalletAddress: string;
  gramWalletAddress: string;
  supportContact: string;
  channelUrl: string;
}
