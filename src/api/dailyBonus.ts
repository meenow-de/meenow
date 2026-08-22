// Daily bonus card content: Wikimedia's featured Picture of the Day.
// Free-licensed content, CORS-enabled, no auth needed. Best-effort like the
// Nominatim lookup in capture.ts — failures yield null and the feed simply
// renders without the card.

export interface DailyBonus {
  imageUrl: string;
  imageTitle: string;
  imageLink: string;
  imageCredit: string;
  description: string;
}

const CACHE_KEY = 'meenow:daily-bonus';

interface CachedBonus {
  date: string;
  bonus: DailyBonus | null;
}

function todayKey(now: Date): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

export async function fetchDailyBonus(): Promise<DailyBonus | null> {
  const date = todayKey(new Date());
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as CachedBonus | null;
    // A cached entry without `description` predates the current card shape.
    if (cached?.date === date && (cached.bonus === null || 'description' in cached.bonus)) {
      return cached.bonus;
    }
  } catch { /* ignore corrupt cache */ }

  let bonus: DailyBonus | null = null;
  try {
    const path = date.replace(/-/g, '/');
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/feed/featured/${path}`);
    if (!res.ok) return null; // don't cache transient failures
    const data = await res.json();

    const image = data.image;
    const imageUrl = image?.thumbnail?.source ?? '';
    if (imageUrl) {
      bonus = {
        imageUrl,
        imageTitle: (image?.title ?? '').replace(/^File:/, '').replace(/\.\w+$/, '').replace(/_/g, ' '),
        imageLink: image?.file_page ?? '',
        imageCredit: image?.artist?.text ?? '',
        description: (image?.description?.text ?? '').trim(),
      };
    }
  } catch {
    return null;
  }

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ date, bonus } satisfies CachedBonus));
  } catch { /* storage full — just refetch next time */ }
  return bonus;
}
