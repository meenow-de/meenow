import './style.css';
import { getAuthState, handleOAuthCallback } from './api/auth';
import { getTodayTrigger, computeState, type AppState } from './timer';
import { postsToday, hasEverPosted, syncPostCount } from './state';
import { fetchTodayPostCount } from './api/pixelfed';
import { renderCountdown, updateCountdownDisplay } from './screens/countdown';
import { renderCapture } from './screens/capture';
import { renderFeed } from './screens/feed';
import { renderLogin } from './screens/login';
import { renderInstallNudge, removeInstallNudge } from './components/installNudge';

const app = document.getElementById('app')!;
type Screen = AppState | 'login' | 'capturing';
let activeScreen: Screen | null = null;
let tickId: number | null = null;

const DEV_HOSTNAMES = new Set(['dev.meenow.de', 'localhost', '127.0.0.1']);
if (DEV_HOSTNAMES.has(window.location.hostname)) {
  const badge = document.createElement('div');
  badge.textContent = 'dev';
  badge.className = 'fixed bottom-3 right-3 bg-gold text-white text-xs font-semibold px-2 py-0.5 rounded-full z-50 opacity-75 pointer-events-none select-none';
  document.body.appendChild(badge);
}

function mountCapture(): void {
  activeScreen = 'capturing';
  app.innerHTML = '';
  removeInstallNudge();
  app.appendChild(renderCapture(() => { activeScreen = null; }));
}

function mount(screen: AppState | 'login'): void {
  app.innerHTML = '';
  if (screen === 'login') app.appendChild(renderLogin());
  else if (screen === 'before_trigger') app.appendChild(renderCountdown());
  else if (screen === 'awaiting_capture') {
    removeInstallNudge();
    app.appendChild(renderCapture(() => { activeScreen = null; }));
    return;
  } else {
    app.appendChild(renderFeed(mountCapture));
  }
  renderInstallNudge();
}

function tick(): void {
  if (activeScreen === 'capturing') return;

  const trigger = getTodayTrigger();
  const auth = getAuthState();
  const screen: AppState | 'login' = auth
    ? computeState(trigger, postsToday(), !hasEverPosted())
    : 'login';

  if ((screen as Screen) !== activeScreen) {
    activeScreen = screen;
    mount(screen);
  }

  if (screen === 'before_trigger') {
    updateCountdownDisplay(trigger);
  }
}

async function init(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (code) {
    history.replaceState({}, '', window.location.pathname);
    try {
      await handleOAuthCallback(code);
    } catch (err) {
      console.error('OAuth callback error:', err);
    }
  }

  tick();
  tickId = window.setInterval(tick, 1000);

  // Sync today's post count from server so second devices start with the right state.
  const auth = getAuthState();
  if (auth && postsToday() === 0) {
    fetchTodayPostCount(auth).then(syncPostCount).catch(() => {});
  }
}

init();

if (import.meta.hot) {
  import.meta.hot.dispose(() => { if (tickId !== null) clearInterval(tickId); });
}
