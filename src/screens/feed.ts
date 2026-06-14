import { SLEEPING_CAT } from '../icons';
import { clearAuth, getAuthState, type AuthState } from '../api/auth';
import { postsToday, MAX_POSTS_PER_TRIGGER } from '../state';
import { fetchMeenowFeed, type FeedPost } from '../api/pixelfed';

export function renderFeed(onRequestCapture: () => void): HTMLElement {
  const auth = getAuthState();
  const el = document.createElement('div');
  el.className = 'min-h-dvh flex flex-col bg-cream';
  el.id = 'screen-feed';

  const header = document.createElement('header');
  header.className = 'sticky top-0 z-10 bg-cream/95 backdrop-blur-sm flex items-center justify-between px-5 py-4 border-b border-ink/10';
  const count = postsToday();
  header.innerHTML = `
    <h1 class="text-xl font-semibold tracking-tight text-ink">meenow</h1>
    <div class="flex items-center gap-3">
      ${count < MAX_POSTS_PER_TRIGGER
        ? `<button id="btn-post-again" class="text-sm font-semibold text-gold">+ Post</button>`
        : ''}
      <span class="text-xs text-ink/40">${count}/${MAX_POSTS_PER_TRIGGER} posted</span>
    </div>
  `;
  el.appendChild(header);

  const content = document.createElement('div');
  content.id = 'feed-content';
  el.appendChild(content);

  const footer = document.createElement('footer');
  footer.className = 'py-6 text-center text-xs text-ink/25 space-y-2';

  const credit = document.createElement('p');
  credit.innerHTML = `Meenow is an experimental side project by <a href="https://rauhe.eu" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2">Hannes Rauhe</a>`;
  footer.appendChild(credit);

  const logoutBtn = document.createElement('button');
  logoutBtn.className = 'text-ink/30 hover:text-ink/60 transition-colors';
  logoutBtn.textContent = 'disconnect';
  logoutBtn.addEventListener('click', () => { clearAuth(); window.location.reload(); });
  footer.appendChild(logoutBtn);

  el.appendChild(footer);

  header.querySelector('#btn-post-again')?.addEventListener('click', () => {
    onRequestCapture();
  });

  loadFeed(content, auth);
  return el;
}

function formatRelativeTime(d: Date): string {
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

async function loadFeed(container: HTMLElement, auth: AuthState | null): Promise<void> {
  if (!auth) return;

  container.innerHTML = `
    <div class="flex items-center justify-center py-20">
      <div class="w-8 h-8 border-[3px] border-gold/30 border-t-gold rounded-full animate-spin"></div>
    </div>
  `;

  let posts: FeedPost[];
  try {
    posts = await fetchMeenowFeed(auth);
  } catch {
    container.innerHTML = `
      <div class="flex flex-col items-center py-16 gap-3 text-center px-6">
        <p class="text-sm text-ink/50">Could not load the feed.</p>
        <button id="btn-feed-retry" class="text-sm text-gold underline underline-offset-2">Retry</button>
      </div>
    `;
    container.querySelector('#btn-feed-retry')?.addEventListener('click', () => loadFeed(container, auth));
    return;
  }

  container.innerHTML = '';

  if (posts.length === 0) {
    container.innerHTML = `
      <div class="flex flex-col items-center py-16 gap-4 text-ink/40 text-center px-6">
        <div class="w-36 h-24">${SLEEPING_CAT}</div>
        <p class="text-sm">No meenow posts from friends yet today.</p>
      </div>
    `;
    return;
  }

  const unblurred = postsToday() > 0;
  posts.forEach(post => container.appendChild(makePostCard(post, unblurred)));
}

function makePostCard(post: FeedPost, unblurred: boolean): HTMLElement {
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
    if (post.allMediaUrls.length > 1) {
      const badge = document.createElement('a');
      badge.href = post.url;
      badge.target = '_blank';
      badge.rel = 'noopener noreferrer';
      badge.className = 'absolute top-3 right-3 bg-black/40 text-white text-xs px-2.5 py-1 rounded-full backdrop-blur-sm';
      badge.textContent = `${post.allMediaUrls.length} photos`;
      imgWrapper.appendChild(badge);
    }
    imgWrapper.addEventListener('click', () => window.open(post.url, '_blank', 'noopener,noreferrer'));
  }

  card.appendChild(imgWrapper);
  return card;
}
