// Push notifications: VAPID subscription registration, permission request, and relay-repo subscription management.
import { getPushSubFilename, setPushSubFilename, clearPushSubFilename, isPwaInstalled, isPwaSubbed, setPwaSubbed, clearPwaSubbed, getStoredVapidKey, setStoredVapidKey, getSyncedTz, setSyncedTz } from './state';

// These are injected at build time from GitHub repo secrets (VITE_* prefix).
// Each deployed instance (dev.meenow.de, meenow.de) has its own secret values,
// which keeps their VAPID keys and subscription sets isolated.
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
const PUSH_RELAY_TOKEN = import.meta.env.VITE_PUSH_RELAY_TOKEN as string | undefined;
const PUSH_RELAY_REPO = 'meenow-de/meenow-push';
// e.g. 'subscriptions/dev' or 'subscriptions/prod'
const PUSH_SUBS_PATH = import.meta.env.VITE_PUSH_SUBS_PATH as string | undefined;

function deviceTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Subscription file content: PushSubscription JSON plus the device IANA timezone,
// which the send script uses to gate ticks to this device's local trigger window.
function subFileContent(sub: PushSubscription): string {
  return btoa(JSON.stringify({ ...sub.toJSON(), tz: deviceTz() }));
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isPushSupported(): boolean {
  return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
}

// Clears the app-icon badge set by the SW's daily reminder. No-op where unsupported.
export function clearAppBadge(): void {
  const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
  void nav.clearAppBadge?.().catch(() => {});
}

export async function isNotificationsEnabled(): Promise<boolean> {
  if (!isPushSupported() || Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.ready;
  return !!(await reg.pushManager.getSubscription());
}

export async function enableNotifications(): Promise<'granted' | 'denied' | 'error'> {
  if (!VAPID_PUBLIC_KEY || !PUSH_RELAY_TOKEN || !PUSH_SUBS_PATH) {
    console.error('[notifications] Push config env vars not set');
    return 'error';
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  const reg = await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    } catch (err) {
      console.error('[notifications] pushManager.subscribe failed', err);
      return 'error';
    }
  }

  // Reuse the filename written on the previous registration to avoid accumulating
  // duplicate files in the subscriptions repo for the same browser.
  const existingFile = getPushSubFilename();
  if (existingFile) {
    setStoredVapidKey(VAPID_PUBLIC_KEY);
    void syncSubscriptionTz();
    return 'granted';
  }

  const filename = `${PUSH_SUBS_PATH}/${crypto.randomUUID()}.json`;
  const content = subFileContent(sub);
  const res = await fetch(
    `https://api.github.com/repos/${PUSH_RELAY_REPO}/contents/${filename}`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${PUSH_RELAY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'Add subscription', content }),
    }
  );

  if (!res.ok) {
    console.error('[notifications] Failed to register subscription', res.status, await res.text());
    return 'error';
  }

  setPushSubFilename(filename);
  isPwaInstalled() ? setPwaSubbed() : clearPwaSubbed();
  setStoredVapidKey(VAPID_PUBLIC_KEY);
  setSyncedTz(deviceTz());
  return 'granted';
}

// On first launch as an installed PWA, the existing push subscription was
// created in a browser tab — Chrome routes its notifications to Chrome rather
// than to the PWA. Unsubscribe and re-subscribe so the new subscription is
// associated with the standalone context, which makes Android attribute
// notifications to the installed app instead.
export async function resubscribeAsPwa(): Promise<void> {
  if (!VAPID_PUBLIC_KEY || !PUSH_RELAY_TOKEN || !PUSH_SUBS_PATH) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) await existing.unsubscribe();

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    clearPushSubFilename();
    const filename = `${PUSH_SUBS_PATH}/${crypto.randomUUID()}.json`;
    const content = subFileContent(sub);
    const res = await fetch(
      `https://api.github.com/repos/${PUSH_RELAY_REPO}/contents/${filename}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${PUSH_RELAY_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Add subscription', content }),
      }
    );

    if (res.ok) {
      setPushSubFilename(filename);
      isPwaInstalled() ? setPwaSubbed() : clearPwaSubbed();
      setStoredVapidKey(VAPID_PUBLIC_KEY);
      setSyncedTz(deviceTz());
    }
  } catch {
    // Silent failure — will retry on the next launch.
  }
}

// Rewrites the relay subscription file when the device timezone differs from the
// one last written (travel, or a legacy file from before the tz field existed),
// so the send script gates ticks to the correct local trigger window. Failures
// are silent and retried on the next launch.
export async function syncSubscriptionTz(): Promise<void> {
  if (!VAPID_PUBLIC_KEY || !PUSH_RELAY_TOKEN || !PUSH_SUBS_PATH) return;
  if (Notification.permission !== 'granted') return;
  const filename = getPushSubFilename();
  if (!filename || getSyncedTz() === deviceTz()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;

    const url = `https://api.github.com/repos/${PUSH_RELAY_REPO}/contents/${filename}`;
    const headers = {
      'Authorization': `Bearer ${PUSH_RELAY_TOKEN}`,
      'Content-Type': 'application/json',
    };
    // Updating an existing file needs its blob sha; a 404 (pruned by the cron)
    // falls through to a sha-less PUT that re-creates the file.
    let sha: string | undefined;
    const getRes = await fetch(url, { headers });
    if (getRes.ok) sha = ((await getRes.json()) as { sha?: string }).sha;
    else {
      console.log(`meenow: relay subscription GET failed (${getRes.status}) for ${filename}`);
      if (getRes.status !== 404) return;
    }

    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: 'Update subscription timezone',
        content: subFileContent(sub),
        ...(sha && { sha }),
      }),
    });
    if (res.ok) setSyncedTz(deviceTz());
  } catch {
    // Silent failure — will retry on the next launch.
  }
}

// Returns true if the push subscription needs to be recreated — either because
// the VAPID key was rotated or because the subscription was created in a browser
// tab and needs to be re-created in the installed PWA context.
// Also bootstraps meenow:vapid-key on first call so future rotations are detectable.
function shouldResubscribe(): boolean {
  if (!VAPID_PUBLIC_KEY || Notification.permission !== 'granted') return false;
  const stored = getStoredVapidKey();
  if (!stored) {
    // No stored key means we can't verify whether the existing subscription
    // matches the current key — re-subscribe unconditionally so any previously
    // rotated key is corrected. setStoredVapidKey is called by resubscribeAsPwa
    // on success, so it gets recorded after the re-subscribe completes.
    return true;
  }
  if (stored !== VAPID_PUBLIC_KEY) return true;        // key rotated
  if (isPwaInstalled() && !isPwaSubbed()) return true; // PWA routing mismatch
  return false;
}

export async function resubscribeIfNeeded(): Promise<void> {
  if (shouldResubscribe()) await resubscribeAsPwa();
}
