export interface TelegramWebAppInstance {
  initData: string;
  initDataUnsafe?: {
    user?: {
      id: number;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
  };
  platform?: string;
  ready: () => void;
  expand: () => void;
  openTelegramLink?: (url: string) => void;
  openInvoice?: (url: string, callback?: (status: 'paid' | 'cancelled' | 'failed' | 'pending') => void) => void;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebAppInstance;
    };
  }
}

export function getTelegramWebApp(): TelegramWebAppInstance | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

export function initTelegramWebApp(): void {
  const tg = getTelegramWebApp();
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
  } catch {
    // ignore SDK errors outside Telegram container
  }
}

export function getTelegramInitData(): string {
  const tg = getTelegramWebApp();
  return tg?.initData?.trim() || '';
}
