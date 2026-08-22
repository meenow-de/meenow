// App entry point: screen mounting/routing, tick loop, overlay navigation (capture, post-detail, grid).
declare const __GIT_HASH__: string;

import './style.css';
import { getAuthState, handleOAuthCallback, dropTokenIfScopesStale } from './api/auth';
import { getLastTriggerTime, type AppState } from './timer';
import { MAX_POSTS_PER_TRIGGER, getPendingAdd, setPendingAdd, clearPendingAdd, clearPwaSubbed } from './state';
import { fetchTodayPostCount, deletePost, removePostFromCache, resetMyPostsPagerIfStale } from './api/pixelfed';
import type { Connection } from './api/social';
import { renderCapture, stopCaptureStreams } from './screens/capture';
import { renderFeed } from './screens/feed';
import { renderGrid } from './screens/grid';
import { renderCircle } from './screens/circle';
import { renderPeerConnections } from './screens/peerConnections';
import { renderConnectLanding } from './screens/connectLanding';
import { renderLogin } from './screens/login';
import { renderPostDetail } from './screens/postDetail';
import type { FeedPost } from './api/pixelfed';
import { renderInstallNudge, removeInstallNudge } from './components/installNudge';
import { renderNotificationNudge, removeNotificationNudge } from './components/notificationNudge';
import { registerSW } from 'virtual:pwa-register';
import { idbSet, IDB_KEYS } from './idb';
import { resubscribeIfNeeded, syncSubscriptionTz, clearAppBadge } from './notifications';

const app = document.getElementById('app')!;
type Screen = AppState | 'login' | 'capturing' | 'post_detail' | 'grid' | 'circle' | 'peer' | 'connect';
const BASE_SCREENS = new Set<Screen>(['feed', 'login']);
let activeScreen: Screen | null = null;
let tickId: number | null = null;

// Post count for the current trigger period. Fetched from the server on every
// page load so multi-device state is always up-to-date — no localStorage cache.
let periodPostCount = 0;

// Tracks the boundary of the last known trigger period so the tick loop can
// detect when a new period starts (trigger fires while the app is open) and
// reset the in-memory count without requiring a page reload.
let lastKnownTriggerMs = getLastTriggerTime().getTime();

const DEV_HOSTNAMES = new Set(['dev.meenow.de', 'localhost', '127.0.0.1']);
if (DEV_HOSTNAMES.has(window.location.hostname)) {
  const badge = document.createElement('div');
  badge.textContent = `dev ${__GIT_HASH__}`;
  badge.className = 'fixed bottom-3 right-3 bg-gold text-white text-xs font-semibold px-2 py-0.5 rounded-full z-50 opacity-75 pointer-events-none select-none';
  document.body.appendChild(badge);
  // Keep the dev mirror out of search results (the index.html/robots.txt is shared with prod).
  const noindex = document.createElement('meta');
  noindex.name = 'robots';
  noindex.content = 'noindex, nofollow';
  document.head.appendChild(noindex);
}

function showUpdateBanner(updateSW: (reloadPage?: boolean) => Promise<void>): void {
  if (document.getElementById('update-nudge')) return;
  const banner = document.createElement('div');
  banner.id = 'update-nudge';
  banner.className = [
    'fixed top-0 left-0 right-0 z-50',
    'bg-ink text-cream',
    'px-5 pb-4',
    'flex items-start gap-4',
    'border-b border-white/10',
  ].join(' ');
  // Clear the standalone status-bar / display-cutout inset (index.html sets
  // viewport-fit=cover) so the Refresh button is never under the status bar.
  banner.style.paddingTop = 'calc(env(safe-area-inset-top, 0px) + 1rem)';
  banner.innerHTML = `
    <div class="flex-1 min-w-0">
      <p class="text-sm font-medium leading-snug">New version available</p>
      <p id="update-status" class="text-xs text-cream/55 mt-0.5 leading-snug">Refresh to get the latest update.</p>
    </div>
    <button id="btn-update" class="shrink-0 bg-gold text-ink rounded-full px-4 py-1.5 text-sm font-medium">Refresh</button>
    <button id="btn-dismiss-update" class="shrink-0 text-cream/40 text-xl leading-none" aria-label="Dismiss">&times;</button>
  `;
  document.body.appendChild(banner);

  const btn = banner.querySelector<HTMLButtonElement>('#btn-update')!;
  const status = banner.querySelector<HTMLParagraphElement>('#update-status')!;
  btn.addEventListener('click', () => void applyUpdate(btn, status, updateSW));
  banner.querySelector('#btn-dismiss-update')?.addEventListener('click', () => banner.remove());
}

// Drive the reload ourselves rather than relying on vite-plugin-pwa's
// isUpdate-gated reload, which does not fire reliably in an installed PWA. The
// SKIP_WAITING handshake and its reload triggers (controllerchange, or the new
// worker reaching 'activated') are armed BEFORE updateSW runs, so a fast
// activation cannot fire before we are listening. If activation never happens
// we do NOT blindly reload: reloading into the still-old controller masks the
// failure (and on dev scrolls away the lifecycle trace). We reload only when
// the controller actually changed, otherwise we tell the user to relaunch the
// app. On dev hostnames the banner subtitle shows a live lifecycle trace.
async function applyUpdate(
  btn: HTMLButtonElement,
  status: HTMLParagraphElement,
  updateSW: (reloadPage?: boolean) => Promise<void>,
): Promise<void> {
  btn.disabled = true;
  btn.textContent = 'Updating…';

  const isDev = DEV_HOSTNAMES.has(window.location.hostname);
  const trace = (msg: string): void => {
    if (!isDev) return;
    status.textContent = status.textContent ? `${status.textContent} → ${msg}` : msg;
  };
  if (isDev) status.textContent = '';
  trace('start');

  const hasSW = 'serviceWorker' in navigator;
  const startController = hasSW ? navigator.serviceWorker.controller : null;

  let reloaded = false;
  const reloadOnce = (reason: string): void => {
    if (reloaded) return;
    reloaded = true;
    trace(`reloading (${reason})`);
    window.location.reload();
  };

  if (hasSW) {
    navigator.serviceWorker.addEventListener(
      'controllerchange', () => reloadOnce('controllerchange'), { once: true });
  }

  // Last resort: only reload if the new worker actually took control. Reloading
  // unconditionally would re-load the stale controller and look like a no-op.
  window.setTimeout(() => {
    if (reloaded) return;
    const controller = hasSW ? navigator.serviceWorker.controller : null;
    if (controller && controller !== startController) {
      reloadOnce('controller changed');
      return;
    }
    trace('stalled');
    btn.disabled = false;
    btn.textContent = 'Reopen app';
    const note = 'Update didn’t apply — fully close the app and reopen to finish.';
    status.textContent = isDev && status.textContent ? `${status.textContent} → ${note}` : note;
  }, 10000);

  if (hasSW) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sw = reg?.waiting ?? reg?.installing ?? null;
      if (sw) {
        trace(`${reg?.waiting ? 'waiting' : 'installing'} (${sw.state})`);
        sw.addEventListener('statechange', () => {
          trace(sw.state);
          if (sw.state === 'activated') reloadOnce('activated');
        });
        sw.postMessage({ type: 'SKIP_WAITING' });
      } else {
        trace('no waiting/installing worker found');
      }
    } catch { trace('getRegistration failed'); }
  }

  // Best-effort: let the plugin run its own handshake too, but we drive reload.
  try {
    await updateSW(false);
  } catch { /* our own signals still guarantee progress */ }
}

const updateSW = registerSW({
  onNeedRefresh() { showUpdateBanner(updateSW); },
});

function onPosted(): void {
  if (periodPostCount === 0) {
    void idbSet(IDB_KEYS.postedTriggerMs, getLastTriggerTime().getTime());
  }
  periodPostCount = Math.min(periodPostCount + 1, MAX_POSTS_PER_TRIGGER);
  clearAppBadge();
}

// Called by the feed with a fresh own-post count after every successful feed
// load, so a stale count (e.g. the page-load fetch failed) is corrected on
// pull-to-refresh / foreground refresh instead of persisting until reload.
function onPostCountRefresh(count: number): void {
  const clamped = Math.min(count, MAX_POSTS_PER_TRIGGER);
  if (clamped === periodPostCount) return;
  if (periodPostCount === 0 && clamped > 0) {
    void idbSet(IDB_KEYS.postedTriggerMs, getLastTriggerTime().getTime());
  }
  periodPostCount = clamped;
  if (activeScreen === 'feed') mount('feed');
}

function mountCapture(): void {
  activeScreen = 'capturing';
  app.innerHTML = '';
  removeInstallNudge();
  removeNotificationNudge();

  history.pushState({ screen: 'capturing' }, '');

  // Stop the camera here too: hardware back exits without going through the
  // capture screen's own cancel handler.
  const onPopState = () => { stopCaptureStreams(); activeScreen = null; tick(); };
  window.addEventListener('popstate', onPopState, { once: true });

  const close = () => { history.back(); };
  app.appendChild(renderCapture(periodPostCount, onPosted, close, close));
}

// Converts a post author into the Connection shape the peer screen expects.
function toPeer(a: FeedPost['account']): Connection {
  return { id: a.id, displayName: a.displayName, username: a.username, acct: a.acct, avatarUrl: a.avatarUrl, url: a.url };
}

// Post detail with nested peer navigation (same pattern as mountGrid →
// mountPostDetail): hardware back from the author's peer screen returns to the
// detail view, not the screen below it.
function mountPostDetail(post: FeedPost, onClose?: () => void): void {
  const auth = getAuthState();
  if (!auth) return;
  activeScreen = 'post_detail';
  app.innerHTML = '';
  removeInstallNudge();
  removeNotificationNudge();

  history.pushState({ screen: 'post_detail' }, '');

  const returnTo = onClose ?? tick;
  let popHandler: (() => void) | null = null;
  const installPop = (): void => {
    popHandler = () => { popHandler = null; activeScreen = null; returnTo(); };
    window.addEventListener('popstate', popHandler, { once: true });
  };

  const onDeletePost = async (): Promise<void> => {
    await deletePost(auth, post.id);
    removePostFromCache(post.id);
    history.back();
  };

  const openPeer = (a: FeedPost['account']): void => {
    if (popHandler) { window.removeEventListener('popstate', popHandler); popHandler = null; }
    mountPeerConnections(toPeer(a), () => {
      activeScreen = 'post_detail';
      app.innerHTML = '';
      installPop();
      app.appendChild(renderDetail());
    });
  };

  const renderDetail = (): HTMLElement => renderPostDetail(post, auth, () => {
    history.back();
  }, onDeletePost, openPeer);

  installPop();

  let el: HTMLElement;
  try {
    el = renderDetail();
  } catch {
    if (popHandler) { window.removeEventListener('popstate', popHandler); popHandler = null; }
    history.back();
    activeScreen = null;
    return;
  }

  app.appendChild(el);
}

function mountGrid(): void {
  const auth = getAuthState();
  if (!auth) return;
  activeScreen = 'grid';
  app.innerHTML = '';
  removeInstallNudge();
  removeNotificationNudge();
  resetMyPostsPagerIfStale();

  history.pushState({ screen: 'grid' }, '');

  let popHandler: (() => void) | null = null;
  let gridScrollY = 0;

  const installPop = (): void => {
    popHandler = () => { popHandler = null; activeScreen = null; tick(); };
    window.addEventListener('popstate', popHandler, { once: true });
  };

  const openPost = (post: FeedPost): void => {
    gridScrollY = window.scrollY;
    if (popHandler) { window.removeEventListener('popstate', popHandler); popHandler = null; }
    mountPostDetail(post, () => {
      activeScreen = 'grid';
      app.innerHTML = '';
      installPop();
      app.appendChild(renderGrid(auth, openPost, onBack, gridScrollY));
    });
  };

  const onBack = (): void => {
    history.back();
  };

  installPop();
  app.appendChild(renderGrid(auth, openPost, onBack));
}

// The circle hub, with nested peer-connection navigation (same pattern as
// mountGrid → mountPostDetail): hardware back from a peer list returns to the
// circle, not the feed.
function mountCircle(): void {
  const auth = getAuthState();
  if (!auth) return;
  activeScreen = 'circle';
  app.innerHTML = '';
  removeInstallNudge();
  removeNotificationNudge();

  history.pushState({ screen: 'circle' }, '');

  let popHandler: (() => void) | null = null;
  const installPop = (): void => {
    popHandler = () => { popHandler = null; activeScreen = null; tick(); };
    window.addEventListener('popstate', popHandler, { once: true });
  };

  const openPeer = (peer: Connection): void => {
    if (popHandler) { window.removeEventListener('popstate', popHandler); popHandler = null; }
    mountPeerConnections(peer, () => {
      activeScreen = 'circle';
      app.innerHTML = '';
      installPop();
      app.appendChild(renderCircle(auth, onBack, openPeer));
    });
  };

  const onBack = (): void => { history.back(); };

  installPop();
  app.appendChild(renderCircle(auth, onBack, openPeer));
}

function mountPeerConnections(peer: Connection, onClose?: () => void): void {
  const auth = getAuthState();
  if (!auth) return;
  activeScreen = 'peer';
  app.innerHTML = '';
  removeInstallNudge();
  removeNotificationNudge();

  history.pushState({ screen: 'peer' }, '');

  const returnTo = onClose ?? tick;
  const onPopState = () => { activeScreen = null; returnTo(); };
  window.addEventListener('popstate', onPopState, { once: true });

  app.appendChild(renderPeerConnections(auth, peer, () => { history.back(); }));
}

function mountConnectLanding(handle: string): void {
  const auth = getAuthState();
  if (!auth) return;
  activeScreen = 'connect';
  app.innerHTML = '';
  removeInstallNudge();
  removeNotificationNudge();

  history.pushState({ screen: 'connect' }, '');

  const onPopState = () => { activeScreen = null; tick(); };
  window.addEventListener('popstate', onPopState, { once: true });

  app.appendChild(renderConnectLanding(auth, handle, () => { history.back(); }));
}

function mount(screen: AppState | 'login'): void {
  app.innerHTML = '';
  if (screen === 'login') {
    // No bottom install banner here — the login wizard has a dedicated install step.
    removeNotificationNudge();
    removeInstallNudge();
    app.appendChild(renderLogin());
  } else {
    app.appendChild(renderFeed(mountCapture, periodPostCount, mountPostDetail, mountGrid, mountCircle, a => mountPeerConnections(toPeer(a)), onPostCountRefresh));
    // Show only one bottom banner — both are fixed bottom-0 and would overlap.
    const installShown = renderInstallNudge();
    if (!installShown) void renderNotificationNudge();
  }
}

function tick(): void {
  if (!BASE_SCREENS.has(activeScreen as Screen) && activeScreen !== null) return;

  // Detect when a new trigger period starts while the app is open (e.g. trigger
  // fires at 3 PM while the user is on the countdown after posting twice).
  const currentTriggerMs = getLastTriggerTime().getTime();
  if (currentTriggerMs !== lastKnownTriggerMs) {
    lastKnownTriggerMs = currentTriggerMs;
    periodPostCount = 0;
  }

  const auth = getAuthState();
  const screen: AppState | 'login' = auth ? 'feed' : 'login';

  if ((screen as Screen) !== activeScreen) {
    activeScreen = screen;
    mount(screen);
  }
}

// Trap the hardware/gesture back button on the resting feed/login screen. The
// overlay mounters each push a history entry and pop it on back; the resting
// screen has none, so without this a back gesture navigates out of the SPA
// entirely (on iOS, into a blank Safari tab with no way back). We seed one
// baseline entry and re-seed it whenever a back lands on a base screen,
// absorbing the gesture so the user stays in the app. When an overlay is active
// it registers its own popstate handler (fired after this one) and owns the
// event, so we defer by re-seeding only for base screens.
function installBackTrap(): void {
  history.pushState({ screen: 'base' }, '');
  window.addEventListener('popstate', () => {
    if (BASE_SCREENS.has(activeScreen as Screen)) {
      history.pushState({ screen: 'base' }, '');
    }
  });
}

async function init(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const add = params.get('add');
  // Set by the daily-reminder notification tap (issue #56) to open capture.
  const action = params.get('action');
  if (code || add || action) {
    history.replaceState({}, '', window.location.pathname);
  }
  if (code) {
    try {
      await handleOAuthCallback(code);
    } catch (err) {
      console.error('OAuth callback error:', err);
    }
  }
  // Persist an invite handle so it survives the OAuth redirect (redirect_uri has
  // no query string); it is consumed below once authenticated.
  if (add) setPendingAdd(add);

  // One-time migration: tokens minted before the `follow` scope was requested
  // can't perform relationship writes, so drop them and let the login screen
  // prompt a single re-authentication with the current scopes.
  dropTokenIfScopesStale();

  // A (re)install invalidates the PWA-routing flag: the surviving push
  // subscription belongs to the previous install's context (localStorage
  // outlives the WebAPK, so the flag would otherwise stay stale and Chrome
  // keeps showing the notifications), so the first standalone launch after
  // install must re-subscribe.
  window.addEventListener('appinstalled', clearPwaSubbed);

  // Re-subscribe if the VAPID key was rotated or if the subscription was created
  // in a browser tab and needs to be re-created in the installed PWA context.
  // The tz sync runs after: a fresh re-subscribe already writes the timezone,
  // and running both concurrently would race on the subscription filename.
  void resubscribeIfNeeded().then(() => syncSubscriptionTz());

  // Opening the app answers the daily-reminder badge regardless of posting.
  clearAppBadge();

  // Fetch the authoritative post count for the current trigger period from the
  // server before starting the tick loop. This ensures multi-device state is
  // correct from the first render without any localStorage synchronisation logic.
  const auth = getAuthState();
  if (auth) {
    // Mirror auth into IndexedDB so the service worker can fetch engagement on
    // wake (it cannot read localStorage).
    void idbSet(IDB_KEYS.auth, { instance: auth.instance, accessToken: auth.accessToken, accountId: auth.accountId });
    app.innerHTML = `
      <div class="flex items-center justify-center min-h-dvh">
        <div class="w-8 h-8 spinner"></div>
      </div>
    `;
    try {
      periodPostCount = Math.min(await fetchTodayPostCount(auth), MAX_POSTS_PER_TRIGGER);
      if (periodPostCount > 0) {
        void idbSet(IDB_KEYS.postedTriggerMs, getLastTriggerTime().getTime());
      }
    } catch {
      periodPostCount = 0;
    }
  }

  installBackTrap();
  tick();
  tickId = window.setInterval(tick, 1000);

  // Once authenticated and the feed is up, open the invite landing for any
  // handle carried in via ?add= (directly, or through the login redirect).
  const pendingAdd = getPendingAdd();
  if (pendingAdd && getAuthState()) {
    clearPendingAdd();
    mountConnectLanding(pendingAdd);
  }

  // A daily-reminder notification tap on a cold start lands here via
  // ?action=capture; open capture on top of the now-mounted feed (issue #56).
  if (action === 'capture' && getAuthState()) {
    mountCapture();
  }

  // Warm case: the app was already open when the notification was tapped, so the
  // service worker focuses the window and posts the intent instead.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
      if (e.data?.type === 'notification-action' && e.data.action === 'capture'
          && getAuthState() && activeScreen !== 'capturing') {
        mountCapture();
      }
    });
  }
}

init();

if (import.meta.hot) {
  import.meta.hot.dispose(() => { if (tickId !== null) clearInterval(tickId); });
}
