// Grid screen: archive of the authenticated user's own meenow photos in a 3-column grid grouped by month.
// Older pages lazy-load via an IntersectionObserver sentinel as the user scrolls.
import { CHEVRON_LEFT_ICON } from '../icons';
import type { AuthState } from '../api/auth';
import { fetchMyPostsPage, type FeedPost, type MyPostsPage } from '../api/pixelfed';

export function renderGrid(
  auth: AuthState,
  onOpenPost: (post: FeedPost) => void,
  onBack: () => void,
  initialScrollY = 0,
): HTMLElement {
  const root = document.createElement('div');
  root.id = 'screen-grid';
  root.className = 'min-h-dvh flex flex-col bg-cream';

  const header = document.createElement('header');
  header.className = 'sticky top-0 z-10 bg-cream/95 backdrop-blur-sm flex items-center gap-3 px-4 pb-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] border-b border-ink/10';

  const backBtn = document.createElement('button');
  // [&>svg]:size-5 gives the chevron an explicit size; without it WebKit collapses
  // a viewBox-only SVG to 0×0 as a flex item, hiding the back button on iOS.
  backBtn.className = 'flex items-center gap-1 text-sm text-gold font-medium w-8 h-8 -ml-1 [&>svg]:size-5';
  backBtn.setAttribute('aria-label', 'Back to feed');
  backBtn.innerHTML = CHEVRON_LEFT_ICON;
  backBtn.addEventListener('click', onBack);
  header.appendChild(backBtn);

  const title = document.createElement('h1');
  title.className = 'text-base font-semibold text-ink';
  title.textContent = 'My Photos';
  header.appendChild(title);

  root.appendChild(header);

  const content = document.createElement('div');
  content.className = 'flex-1';
  root.appendChild(content);

  loadGridContent(content, auth, onOpenPost, initialScrollY);
  return root;
}

async function loadGridContent(
  container: HTMLElement,
  auth: AuthState,
  onOpenPost: (post: FeedPost) => void,
  initialScrollY: number,
): Promise<void> {
  container.innerHTML = `
    <div class="flex items-center justify-center py-20">
      <div class="w-8 h-8 spinner"></div>
    </div>
  `;

  let page: MyPostsPage;
  try {
    page = await fetchMyPostsPage(auth);
  } catch {
    if (!container.isConnected) return;
    container.innerHTML = `
      <div class="flex flex-col items-center py-16 gap-3 text-center px-6">
        <p class="text-sm text-ink/50">Could not load photos.</p>
        <button id="btn-grid-retry" class="text-sm text-gold underline underline-offset-2">Retry</button>
      </div>
    `;
    container.querySelector('#btn-grid-retry')?.addEventListener('click', () => loadGridContent(container, auth, onOpenPost, initialScrollY));
    return;
  }

  if (!container.isConnected) return;
  container.innerHTML = '';

  if (page.posts.length === 0 && !page.hasMore) {
    showEmpty(container);
    return;
  }

  const sections = document.createElement('div');
  container.appendChild(sections);
  renderMonthSections(sections, page.posts, onOpenPost);

  if (initialScrollY) requestAnimationFrame(() => window.scrollTo(0, initialScrollY));

  if (!page.hasMore) return;

  // Sentinel + footer row: spinner while a page loads, retry on failure.
  const footer = document.createElement('div');
  footer.className = 'flex items-center justify-center py-6 min-h-16';
  container.appendChild(footer);

  let fetching = false;
  const loadMore = async (): Promise<void> => {
    if (fetching) return;
    fetching = true;
    footer.innerHTML = '<div class="w-6 h-6 spinner"></div>';
    try {
      const next = await fetchMyPostsPage(auth);
      if (!container.isConnected) { observer.disconnect(); return; }
      renderMonthSections(sections, next.posts, onOpenPost);
      if (next.hasMore) {
        footer.innerHTML = '';
        // observe() delivers an initial record, re-evaluating a sentinel that
        // stayed in view (short content) so paging continues without a scroll.
        observer.unobserve(footer);
        observer.observe(footer);
      } else {
        observer.disconnect();
        footer.remove();
        if (next.posts.length === 0) showEmpty(container);
      }
    } catch {
      if (!container.isConnected) { observer.disconnect(); return; }
      footer.innerHTML = `
        <div class="flex flex-col items-center gap-2 text-center">
          <p class="text-sm text-ink/50">Could not load more photos.</p>
          <button class="text-sm text-gold underline underline-offset-2">Retry</button>
        </div>
      `;
      footer.querySelector('button')?.addEventListener('click', () => loadMore());
    } finally {
      fetching = false;
    }
  };

  const observer = new IntersectionObserver(entries => {
    if (!container.isConnected) { observer.disconnect(); return; }
    if (entries.some(e => e.isIntersecting)) void loadMore();
  }, { rootMargin: '600px' });
  observer.observe(footer);
}

function showEmpty(container: HTMLElement): void {
  container.innerHTML = `
    <div class="flex flex-col items-center py-16 gap-4 text-ink/40 text-center px-6">
      <p class="text-sm">No meenow photos yet.</p>
    </div>
  `;
}

function renderMonthSections(
  sections: HTMLElement,
  posts: FeedPost[],
  onOpenPost: (post: FeedPost) => void,
): void {
  sections.innerHTML = '';
  const byMonth = groupByMonth(posts);
  for (const [monthKey, group] of byMonth) {
    const section = document.createElement('div');

    const heading = document.createElement('h2');
    heading.className = 'text-xs font-semibold text-ink/40 px-4 pt-4 pb-2 uppercase tracking-wider';
    heading.textContent = formatMonthYear(monthKey);
    section.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-3 gap-0.5';
    for (const post of group) {
      const cell = document.createElement('button');
      cell.className = 'aspect-square overflow-hidden bg-gold-light';
      cell.setAttribute('aria-label', `Photo from ${formatMonthYear(monthKey)}`);
      const img = document.createElement('img');
      img.src = post.compositeUrl;
      img.className = 'w-full h-full object-cover';
      img.alt = '';
      img.loading = 'lazy';
      cell.appendChild(img);
      cell.addEventListener('click', () => onOpenPost(post));
      grid.appendChild(cell);
    }
    section.appendChild(grid);
    sections.appendChild(section);
  }
}

function groupByMonth(posts: FeedPost[]): Map<string, FeedPost[]> {
  const map = new Map<string, FeedPost[]>();
  for (const post of posts) {
    const key = `${post.createdAt.getFullYear()}-${String(post.createdAt.getMonth() + 1).padStart(2, '0')}`;
    const group = map.get(key);
    if (group) group.push(post);
    else map.set(key, [post]);
  }
  return map;
}

function formatMonthYear(key: string): string {
  const [year, month] = key.split('-');
  return new Date(Number(year), Number(month) - 1, 1)
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
