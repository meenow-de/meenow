import { localDateString } from './timer';

const PREFIX = 'meenow:';
export const MAX_POSTS_PER_TRIGGER = 2;

export function postsToday(): number {
  return Number(localStorage.getItem(`${PREFIX}posts:${localDateString()}`) ?? '0');
}

export function markPostedToday(): void {
  localStorage.setItem(`${PREFIX}posts:${localDateString()}`, String(postsToday() + 1));
}

export function hasEverPosted(): boolean {
  return Object.keys(localStorage).some(k => k.startsWith(`${PREFIX}posts:`));
}

export function isInstallDismissed(): boolean {
  const raw = localStorage.getItem(`${PREFIX}install-dismiss`);
  if (!raw) return false;
  return Date.now() - Number(raw) < 7 * 24 * 60 * 60 * 1000;
}

export function dismissInstall(): void {
  localStorage.setItem(`${PREFIX}install-dismiss`, String(Date.now()));
}

export function isPwaInstalled(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function syncPostCount(serverCount: number): void {
  const local = postsToday();
  if (serverCount > local) {
    localStorage.setItem(
      `${PREFIX}posts:${localDateString()}`,
      String(Math.min(serverCount, MAX_POSTS_PER_TRIGGER)),
    );
  }
}

