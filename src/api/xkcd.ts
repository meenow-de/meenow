// Second daily bonus card: the current xkcd comic. xkcd's API has no CORS
// headers, so a cron step (scripts/fetch-xkcd.mjs, run by send-tick.yml)
// mirrors it into xkcd.json in the (public) push relay repo, read here via
// raw.githubusercontent.com — CORS-enabled, no auth, ~5 min CDN cache.
//
// SECURITY: anyone holding the client-shipped relay token can write to the
// relay repo — the mirrored JSON is untrusted user input. Every field is
// validated here: the image URL is allowlisted to https://imgs.xkcd.com,
// the comic link is constructed from the validated integer `num` (never read
// from the file), and text fields are length-capped and only ever rendered
// via textContent.

export interface XkcdBonus {
  num: number;
  title: string;
  img: string;
  alt: string;
}

const MIRROR_URL = 'https://raw.githubusercontent.com/meenow-de/meenow-push/refs/heads/main/xkcd.json';

const CACHE_KEY = 'meenow:xkcd-bonus';
const MAX_TEXT_LEN = 1000;

interface CachedXkcd {
  date: string;
  bonus: XkcdBonus | null;
}

function todayKey(now: Date): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

export function comicUrl(bonus: XkcdBonus): string {
  return `https://xkcd.com/${bonus.num}/`;
}

// The untrusted-input boundary: rejects the whole payload unless every field
// is exactly what the mirror script produces.
function sanitize(data: unknown): XkcdBonus | null {
  if (typeof data !== 'object' || data === null) return null;
  const { num, title, img, alt } = data as Record<string, unknown>;
  if (!Number.isInteger(num) || (num as number) <= 0) return null;
  if (typeof img !== 'string') return null;
  try {
    const url = new URL(img);
    if (url.protocol !== 'https:' || url.hostname !== 'imgs.xkcd.com') return null;
  } catch {
    return null;
  }
  if (typeof title !== 'string' || typeof alt !== 'string') return null;
  return {
    num: num as number,
    title: title.slice(0, MAX_TEXT_LEN),
    img,
    alt: alt.slice(0, MAX_TEXT_LEN),
  };
}

export async function fetchXkcdBonus(): Promise<XkcdBonus | null> {
  const date = todayKey(new Date());
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as CachedXkcd | null;
    if (cached?.date === date) return sanitize(cached.bonus);
  } catch { /* ignore corrupt cache */ }

  let bonus: XkcdBonus | null = null;
  try {
    const res = await fetch(MIRROR_URL);
    if (!res.ok) return null; // don't cache transient failures
    bonus = sanitize(await res.json());
  } catch {
    return null;
  }

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ date, bonus } satisfies CachedXkcd));
  } catch { /* storage full — just refetch next time */ }
  return bonus;
}
