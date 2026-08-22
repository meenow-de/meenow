// Feed screen: main home feed showing today's meenow posts from followed accounts.
import { SLEEPING_CAT, SPEECH_BUBBLE_ICON, GRID_ICON, PEOPLE_ICON } from '../icons';
import { clearAuth, getAuthState, type AuthState } from '../api/auth';
import { MAX_POSTS_PER_TRIGGER } from '../state';
import { fetchMeenowFeed, type FeedPost } from '../api/pixelfed';
import { fetchDailyBonus, type DailyBonus } from '../api/dailyBonus';
import { fetchPendingRequestCount } from '../api/social';
import { getLastTriggerTime, getNextTriggerTime, formatShortDateTime, formatCountdown, formatRelativeTime } from '../timer';

export function renderFeed(onRequestCapture: () => void, postCount: number, onOpenPost: (post: FeedPost) => void, onOpenGrid: () => void, onOpenCircle: () => void, onOpenPeer: (account: FeedPost['account']) => void, onPostCountChange: (count: number) => void): HTMLElement {
  const auth = getAuthState();
  const el = document.createElement('div');
  el.className = 'min-h-dvh flex flex-col bg-cream';
  el.id = 'screen-feed';

  const header = document.createElement('header');
  header.className = 'sticky top-0 z-10 bg-cream/95 backdrop-blur-sm flex items-center justify-between px-5 pb-4 pt-[calc(env(safe-area-inset-top,0px)+1rem)] border-b border-ink/10';
  const atQuota = postCount >= MAX_POSTS_PER_TRIGGER;
  header.innerHTML = `
    <h1 class="text-xl font-semibold tracking-tight text-ink">meenow</h1>
    <div class="flex items-center gap-3">
      ${!atQuota ? `<button id="btn-post-again" class="text-sm font-semibold text-gold">+ Post</button>` : ''}
      <span id="header-status" class="text-xs text-ink/40">${!atQuota ? `${postCount}/${MAX_POSTS_PER_TRIGGER} posted` : ''}</span>
      <button id="btn-open-circle" class="relative w-6 h-6 text-ink/50 hover:text-ink transition-colors" aria-label="Your circle">${PEOPLE_ICON}</button>
      <button id="btn-open-grid" class="w-6 h-6 text-ink/50 hover:text-ink transition-colors" aria-label="My Photos">${GRID_ICON}</button>
    </div>
  `;

  if (atQuota) {
    const statusEl = header.querySelector('#header-status')!;
    const nextTrigger = getNextTriggerTime();
    const updateCountdown = (): void => {
      const ms = nextTrigger.getTime() - Date.now();
      statusEl.textContent = ms > 0 ? `next post in ${formatCountdown(ms)}` : '';
    };
    updateCountdown();
    const intervalId = setInterval(() => {
      if (!statusEl.isConnected) { clearInterval(intervalId); return; }
      updateCountdown();
    }, 1000);
  }

  el.appendChild(header);

  // Wrapper around the post list + footer so pull-to-refresh can translate the
  // feed while the sticky header stays fixed and the spinner rides behind it.
  const body = document.createElement('div');

  const content = document.createElement('div');
  content.id = 'feed-content';
  body.appendChild(content);

  const footer = document.createElement('footer');
  footer.className = 'py-6 text-center text-xs text-ink/25 space-y-2';

  const visibility = document.createElement('p');
  visibility.className = 'text-ink/40';
  visibility.textContent = "Your followers can see today’s posts in meenow and on Pixelfed";
  footer.appendChild(visibility);

  const credit = document.createElement('p');
  credit.innerHTML = `Meenow is an experimental side project by <a href="https://rauhe.eu" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2">Hannes Rauhe</a>`;
  footer.appendChild(credit);

  const period = document.createElement('p');
  const last = getLastTriggerTime();
  const next = getNextTriggerTime();
  period.textContent = `Trigger period: ${formatShortDateTime(last)} → ${formatShortDateTime(next)}`;
  footer.appendChild(period);

  const logoutBtn = document.createElement('button');
  logoutBtn.className = 'text-ink/30 hover:text-ink/60 transition-colors';
  logoutBtn.textContent = 'disconnect';
  logoutBtn.addEventListener('click', () => { clearAuth(); window.location.reload(); });
  footer.appendChild(logoutBtn);

  body.appendChild(footer);
  el.appendChild(body);

  header.querySelector('#btn-post-again')?.addEventListener('click', onRequestCapture);
  header.querySelector('#btn-open-grid')?.addEventListener('click', onOpenGrid);
  header.querySelector('#btn-open-circle')?.addEventListener('click', onOpenCircle);

  if (auth) {
    setupRefresh(el, body, content, auth, postCount, onOpenPost, onOpenPeer, onPostCountChange);
    loadFeed(content, auth, postCount, onOpenPost, onOpenPeer, onPostCountChange);
    // Mark the circle icon when follow requests are waiting.
    void fetchPendingRequestCount(auth).then(count => {
      const circleBtn = header.querySelector('#btn-open-circle');
      if (count > 0 && circleBtn && circleBtn.isConnected) {
        const dot = document.createElement('span');
        dot.className = 'absolute -top-0.5 -right-0.5 w-2 h-2 bg-gold rounded-full';
        circleBtn.appendChild(dot);
      }
    });
  }
  return el;
}

// Pull-to-refresh + foreground refresh. iOS standalone PWAs have no native
// pull-to-refresh, and Android's is disabled via overscroll-behavior (style.css),
// so this custom gesture is the single source of truth on both platforms.
function setupRefresh(el: HTMLElement, body: HTMLElement, content: HTMLElement, auth: AuthState, postCount: number, onOpenPost: (post: FeedPost) => void, onOpenPeer: (account: FeedPost['account']) => void, onPostCountChange: (count: number) => void): void {
  const PULL_THRESHOLD = 70; // px of (damped) pull needed to trigger a refresh
  const PULL_MAX = 110;
  let refreshing = false;

  // px the spinner sits tucked up behind the header at rest; it slides out from
  // under the bar as the feed is pulled down past this offset.
  const SPINNER_HIDE = 36;

  const indicator = document.createElement('div');
  // z-0 keeps the spinner behind the sticky header (z-10) so it is masked at
  // rest, while — being positioned — it still paints above the static feed body.
  indicator.className = 'fixed left-1/2 z-0 pointer-events-none top-[calc(env(safe-area-inset-top,0px)+4rem)]';
  indicator.style.opacity = '0';
  indicator.style.transform = `translateX(-50%) translateY(-${SPINNER_HIDE}px) scale(0.6)`;
  indicator.innerHTML = '<div class="w-7 h-7 spinner"></div>';
  el.appendChild(indicator);

  const setPull = (d: number): void => {
    const p = Math.min(1, d / PULL_THRESHOLD);
    indicator.style.opacity = String(p);
    indicator.style.transform = `translateX(-50%) translateY(${d - SPINNER_HIDE}px) scale(${0.6 + 0.4 * p})`;
    body.style.transform = `translateY(${d}px)`;
  };
  const resetPull = (): void => {
    indicator.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    indicator.style.opacity = '0';
    indicator.style.transform = `translateX(-50%) translateY(-${SPINNER_HIDE}px) scale(0.6)`;
    body.style.transition = 'transform 0.2s ease';
    body.style.transform = 'translateY(0)';
    // Clear the feed transform at rest so it never establishes a containing block.
    setTimeout(() => { indicator.style.transition = ''; body.style.transition = ''; body.style.transform = ''; }, 220);
  };

  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    indicator.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    indicator.style.opacity = '1';
    // Hold the spinner just below the bar while the feed snaps back and reloads.
    indicator.style.transform = `translateX(-50%) translateY(${Math.round(PULL_THRESHOLD * 0.4)}px) scale(1)`;
    body.style.transition = 'transform 0.2s ease';
    body.style.transform = 'translateY(0)';
    try {
      await loadFeed(content, auth, postCount, onOpenPost, onOpenPeer, onPostCountChange, true, true);
    } finally {
      resetPull();
      refreshing = false;
    }
  };

  let startY = 0;
  let pulling = false;
  let dist = 0;
  el.addEventListener('touchstart', (e: TouchEvent) => {
    if (refreshing) return;
    const top = document.scrollingElement?.scrollTop ?? window.scrollY;
    if (top <= 0) { startY = e.touches[0].clientY; pulling = true; dist = 0; }
  }, { passive: true });
  el.addEventListener('touchmove', (e: TouchEvent) => {
    if (!pulling || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) { dist = 0; setPull(0); return; }
    // Claim the downward pull so the browser cannot also run its native
    // pull-to-refresh; only when genuinely pulling down from the top, so normal
    // scrolling is never blocked. Requires a non-passive listener.
    e.preventDefault();
    indicator.style.transition = '';
    body.style.transition = '';
    dist = Math.min(PULL_MAX, dy * 0.5);
    setPull(dist);
  }, { passive: false });
  el.addEventListener('touchend', () => {
    if (!pulling) return;
    pulling = false;
    if (dist >= PULL_THRESHOLD) void refresh();
    else resetPull();
    dist = 0;
  });

  // Refresh when the app/tab returns to the foreground. Self-cleans once the
  // feed element is no longer in the DOM (next event after unmount).
  const onPageShow = (e: PageTransitionEvent): void => { if (e.persisted) onForeground(); };
  function onForeground(): void {
    if (!el.isConnected) {
      document.removeEventListener('visibilitychange', onForeground);
      window.removeEventListener('pageshow', onPageShow);
      return;
    }
    if (document.visibilityState === 'visible') void refresh();
  }
  document.addEventListener('visibilitychange', onForeground);
  window.addEventListener('pageshow', onPageShow);
}

// `silent` skips the full-screen spinner and keeps the existing cards on screen
// (used by pull-to-refresh and foreground refresh, where the loading cue lives
// elsewhere); on failure it leaves the current feed untouched.
// `force` bypasses the home-timeline cache TTL (explicit user refresh).
async function loadFeed(container: HTMLElement, auth: AuthState, postCount: number, onOpenPost: (post: FeedPost) => void, onOpenPeer: (account: FeedPost['account']) => void, onPostCountChange: (count: number) => void, silent = false, force = false): Promise<void> {

  if (!silent) {
    container.innerHTML = `
      <div class="flex items-center justify-center py-20">
        <div class="w-8 h-8 spinner"></div>
      </div>
    `;
  }

  let posts: FeedPost[];
  try {
    posts = await fetchMeenowFeed(auth, force);
  } catch {
    if (silent) return;
    container.innerHTML = `
      <div class="flex flex-col items-center py-16 gap-3 text-center px-6">
        <p class="text-sm text-ink/50">Could not load the feed.</p>
        <button id="btn-feed-retry" class="text-sm text-gold underline underline-offset-2">Retry</button>
      </div>
    `;
    container.querySelector('#btn-feed-retry')?.addEventListener('click', () => loadFeed(container, auth, postCount, onOpenPost, onOpenPeer, onPostCountChange));
    return;
  }

  // Reconcile the header count with the fresh timeline data: the count fetched
  // at page load can be stale (e.g. that fetch failed), which would leave the
  // header at 0/N and the feed blurred even though the user has posted.
  if (auth.accountId) {
    onPostCountChange(posts.filter(p => p.account.id === auth.accountId).length);
    if (!container.isConnected) return; // count change remounted the feed
  }

  container.innerHTML = '';

  if (posts.length === 0) {
    container.innerHTML = `
      <div class="flex flex-col items-center py-16 gap-4 text-ink/40 text-center px-6">
        <div class="w-36 h-24">${SLEEPING_CAT}</div>
        <p class="text-sm">No meenow posts from friends yet today.</p>
      </div>
    `;
  } else {
    const unblurred = postCount > 0;
    posts.forEach(post => container.appendChild(makePostCard(post, unblurred, auth, onOpenPost, onOpenPeer)));
  }

  // Daily bonus card (Wikimedia picture of the day) fills the
  // bottom of the feed — especially valuable while the circle is quiet. Fully
  // best-effort: on failure the placeholder just stays empty.
  const bonusSlot = document.createElement('div');
  container.appendChild(bonusSlot);
  void fetchDailyBonus().then(bonus => {
    if (bonus && bonusSlot.isConnected) bonusSlot.replaceWith(makeBonusCard(bonus));
  });
}

function makeBonusCard(bonus: DailyBonus): HTMLElement {
  const card = document.createElement('article');
  card.className = 'border-b border-t border-ink/8';

  const header = document.createElement('div');
  header.className = 'flex items-center gap-3 px-4 py-3';

  const badge = document.createElement('div');
  badge.className = 'w-9 h-9 rounded-full bg-gold-light shrink-0 flex items-center justify-center text-lg';
  badge.textContent = '🌍';
  header.appendChild(badge);

  const info = document.createElement('div');
  info.className = 'flex-1 min-w-0';

  const nameEl = document.createElement('p');
  nameEl.className = 'text-sm font-medium text-ink truncate';
  nameEl.textContent = 'Picture of the day';
  info.appendChild(nameEl);

  const metaEl = document.createElement('p');
  metaEl.className = 'text-xs text-ink/40 truncate';
  metaEl.textContent = bonus.imageCredit ? `Wikimedia Commons · ${bonus.imageCredit}` : 'Wikimedia Commons';
  info.appendChild(metaEl);

  header.appendChild(info);
  card.appendChild(header);

  const link = document.createElement('a');
  link.href = bonus.imageLink || 'https://commons.wikimedia.org/wiki/Main_Page';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const photo = document.createElement('img');
  photo.src = bonus.imageUrl;
  photo.className = 'w-full block';
  photo.alt = bonus.imageTitle;
  photo.loading = 'lazy';
  link.appendChild(photo);
  card.appendChild(link);

  const meta = document.createElement('div');
  meta.className = 'px-4 pt-2 pb-3 flex flex-col gap-1.5';
  const captionText = bonus.description || bonus.imageTitle;
  if (captionText) {
    const caption = document.createElement('p');
    caption.className = 'text-sm text-ink leading-relaxed';
    caption.textContent = captionText;
    meta.appendChild(caption);
  }
  const moreLink = document.createElement('a');
  moreLink.href = link.href;
  moreLink.target = '_blank';
  moreLink.rel = 'noopener noreferrer';
  moreLink.className = 'text-xs text-gold';
  moreLink.textContent = 'More on Wikimedia Commons →';
  meta.appendChild(moreLink);
  card.appendChild(meta);

  return card;
}

function makePostCard(post: FeedPost, unblurred: boolean, auth: AuthState, onOpenPost: (post: FeedPost) => void, onOpenPeer: (account: FeedPost['account']) => void): HTMLElement {
  const card = document.createElement('article');
  card.className = 'border-b border-ink/8';

  // Header
  const header = document.createElement('div');
  header.className = 'flex items-center gap-3 px-4 py-3';

  const avatar = document.createElement('img');
  avatar.src = post.account.avatarUrl;
  avatar.className = 'w-9 h-9 rounded-full object-cover bg-gold-light shrink-0';
  avatar.alt = '';
  header.appendChild(avatar);

  const info = document.createElement('div');
  info.className = 'flex-1 min-w-0';

  const nameEl = document.createElement('p');
  nameEl.className = 'text-sm font-medium text-ink truncate';
  nameEl.textContent = post.account.displayName;
  info.appendChild(nameEl);

  const metaEl = document.createElement('p');
  metaEl.className = 'text-xs text-ink/40';
  metaEl.textContent = `@${post.account.username} · ${formatRelativeTime(post.createdAt)}`;
  info.appendChild(metaEl);

  header.appendChild(info);
  if (post.account.id !== auth.accountId) {
    header.classList.add('cursor-pointer');
    header.addEventListener('click', () => onOpenPeer(post.account));
  }
  card.appendChild(header);

  // Image wrapper
  const imgWrapper = document.createElement('div');
  imgWrapper.className = 'relative overflow-hidden cursor-pointer';

  const photo = document.createElement('img');
  photo.src = post.compositeUrl;
  photo.className = `w-full block ${unblurred ? '' : 'blur-2xl scale-110'}`;
  photo.alt = 'meenow photo';
  photo.loading = 'lazy';
  imgWrapper.appendChild(photo);

  if (!unblurred) {
    const overlay = document.createElement('div');
    overlay.className = 'absolute inset-0 flex items-center justify-center bg-black/10';
    const label = document.createElement('span');
    label.className = 'text-white text-sm font-medium drop-shadow-md bg-black/35 rounded-full px-4 py-2';
    label.textContent = 'Post yours to unblur';
    overlay.appendChild(label);
    imgWrapper.appendChild(overlay);
  } else {
    imgWrapper.addEventListener('click', () => onOpenPost(post));
  }

  card.appendChild(imgWrapper);

  if (post.statusText || post.location) {
    const meta = document.createElement('div');
    meta.className = 'px-4 pt-2 pb-1 flex flex-col gap-2';
    if (post.statusText) {
      const textEl = document.createElement('p');
      textEl.className = 'text-sm text-ink leading-relaxed whitespace-pre-line';
      textEl.textContent = post.statusText;
      meta.appendChild(textEl);
    }
    if (post.location) {
      const pill = document.createElement('span');
      pill.className = 'inline-block text-xs text-gold border border-gold/30 rounded-full px-3 py-1.5';
      pill.textContent = `📍 ${post.location}`;
      meta.appendChild(pill);
    }
    card.appendChild(meta);
  }

  if (post.replyCount > 0) {
    const cardFooter = document.createElement('div');
    cardFooter.className = 'flex items-center gap-1.5 px-4 py-2.5 text-xs text-ink/40';
    const iconEl = document.createElement('span');
    iconEl.className = 'w-3.5 h-3.5 shrink-0';
    iconEl.innerHTML = SPEECH_BUBBLE_ICON;
    cardFooter.appendChild(iconEl);
    const countEl = document.createElement('span');
    countEl.textContent = `${post.replyCount}`;
    cardFooter.appendChild(countEl);
    // Open the detail (with replies) on tap, gated like the photo so a blurred
    // feed stays unreachable until the user posts.
    if (unblurred) {
      cardFooter.classList.add('cursor-pointer');
      cardFooter.addEventListener('click', () => onOpenPost(post));
    }
    card.appendChild(cardFooter);
  }

  return card;
}
