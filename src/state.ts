// Persistent local state: localStorage helpers for notification dismiss, install dismiss, and push subscription filename.
export const MAX_POSTS_PER_TRIGGER = 2;

export function isNotificationNudgeDismissed(): boolean {
  const raw = localStorage.getItem('meenow:notif-dismiss');
  if (!raw) return false;
  return Date.now() - Number(raw) < 30 * 24 * 60 * 60 * 1000;
}

export function dismissNotificationNudge(): void {
  localStorage.setItem('meenow:notif-dismiss', String(Date.now()));
}

// Tracks the filename written to the subscriptions repo so we don't create
// duplicate files if the user re-enables notifications on the same device.
export function getPushSubFilename(): string | null {
  return localStorage.getItem('meenow:push-sub-file');
}

export function setPushSubFilename(filename: string): void {
  localStorage.setItem('meenow:push-sub-file', filename);
}

export function clearPushSubFilename(): void {
  localStorage.removeItem('meenow:push-sub-file');
}

// Set when the active push subscription was created in PWA standalone mode.
// Until this is set, the subscription was created in a browser tab and Chrome
// routes its notifications to Chrome rather than to the installed PWA.
export function isPwaSubbed(): boolean {
  return localStorage.getItem('meenow:pwa-subbed') === 'true';
}

export function setPwaSubbed(): void {
  localStorage.setItem('meenow:pwa-subbed', 'true');
}

export function clearPwaSubbed(): void {
  localStorage.removeItem('meenow:pwa-subbed');
}

// Stores the VAPID public key used when the active push subscription was created.
// On app load, a mismatch against the build-time key indicates key rotation and
// triggers an automatic re-subscribe with the new key.
export function getStoredVapidKey(): string | null {
  return localStorage.getItem('meenow:vapid-key');
}

export function setStoredVapidKey(key: string): void {
  localStorage.setItem('meenow:vapid-key', key);
}

// IANA timezone last successfully written into the relay subscription file.
// A mismatch with the device timezone on app load (travel, or a legacy file
// written before the tz field existed) triggers syncSubscriptionTz().
export function getSyncedTz(): string | null {
  return localStorage.getItem('meenow:tz');
}

export function setSyncedTz(tz: string): void {
  localStorage.setItem('meenow:tz', tz);
}

// Records that the account has been ensured "locked" (manually approve followers,
// hidden from discovery) for an instance, so the Circle screen doesn't re-PATCH on
// every open. Cleared on logout so a fresh login re-applies. Instance-scoped
// because creds are per-instance.
// v2: v1 was written against a PATCH that Pixelfed silently ignored (multipart on
// PATCH), so it recorded a success that never happened. Bumping the key makes every
// install re-apply once and pick up both the working PATCH and the discovery flag.
const LOCKED_APPLIED_PREFIX = 'meenow:locked-applied:v2:';

export function isLockedApplied(instance: string): boolean {
  return localStorage.getItem(`${LOCKED_APPLIED_PREFIX}${instance}`) === 'true';
}

export function setLockedApplied(instance: string): void {
  localStorage.setItem(`${LOCKED_APPLIED_PREFIX}${instance}`, 'true');
}

export function clearLockedApplied(instance: string): void {
  localStorage.removeItem(`${LOCKED_APPLIED_PREFIX}${instance}`);
  localStorage.removeItem(`meenow:locked-applied:${instance}`);
}

// A handle from an invite deep link (?add=) that must survive the OAuth redirect
// when the recipient is not yet logged in (redirect_uri carries no query string).
export function getPendingAdd(): string | null {
  return localStorage.getItem('meenow:pending-add');
}

export function setPendingAdd(handle: string): void {
  localStorage.setItem('meenow:pending-add', handle);
}

export function clearPendingAdd(): void {
  localStorage.removeItem('meenow:pending-add');
}

export function isInstallDismissed(): boolean {
  const raw = localStorage.getItem('meenow:install-dismiss');
  if (!raw) return false;
  return Date.now() - Number(raw) < 7 * 24 * 60 * 60 * 1000;
}

export function dismissInstall(): void {
  localStorage.setItem('meenow:install-dismiss', String(Date.now()));
}

export function isPwaInstalled(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// iPadOS reports itself as MacIntel; the touch-point check tells it apart.
export function isIOS(): boolean {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}
