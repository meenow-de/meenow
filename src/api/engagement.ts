// SW-safe Pixelfed reads used by the push handler to build post-posting digests.
// Pure fetch only — no DOM or localStorage — so it can run inside the service worker.
import { getLastTriggerTime } from '../timer';
import type { StoredAuth } from '../idb';

interface NotifStatus {
  tags?: { name: string }[];
}

interface MastodonNotification {
  id: string;
  type: string;
  status?: NotifStatus;
}

interface TimelineStatus {
  created_at: string;
  account: { id: string };
  media_attachments: unknown[];
  tags: { name: string }[];
}

function hasMeenowTag(tags?: { name: string }[]): boolean {
  return !!tags?.some(t => t.name.toLowerCase() === 'meenowapp');
}

export interface NewEngagement {
  likes: number;
  reblogs: number;
  replies: number;
  newestId?: string;
}

// Reactions on the user's own meenow posts since the last seen notification.
// Returns zero counts (and no newestId) when the endpoint is unavailable.
export async function fetchNewEngagement(auth: StoredAuth, sinceId?: string): Promise<NewEngagement> {
  const empty: NewEngagement = { likes: 0, reblogs: 0, replies: 0 };
  const params = new URLSearchParams({ limit: '40' });
  if (sinceId) params.set('since_id', sinceId);
  try {
    const res = await fetch(`https://${auth.instance}/api/v1/notifications?${params}`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (!res.ok) return empty;
    const notifs = await res.json() as MastodonNotification[];
    if (!Array.isArray(notifs) || notifs.length === 0) return empty;

    const relevant = notifs.filter(n =>
      (n.type === 'favourite' || n.type === 'reblog' || n.type === 'mention') &&
      hasMeenowTag(n.status?.tags)
    );
    return {
      likes: relevant.filter(n => n.type === 'favourite').length,
      reblogs: relevant.filter(n => n.type === 'reblog').length,
      replies: relevant.filter(n => n.type === 'mention').length,
      newestId: notifs[0].id,
    };
  } catch {
    return empty;
  }
}

// Distinct accounts other than the user that posted a meenow in the current period.
export async function fetchFriendsPostedCount(auth: StoredAuth): Promise<number> {
  const cutoff = getLastTriggerTime().getTime();
  try {
    // no-store keeps this SW-side fetch from reading or repopulating the HTTP
    // cache entry for the same URL the app's feed load uses.
    const res = await fetch(`https://${auth.instance}/api/v1/timelines/home?limit=40`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
      cache: 'no-store',
    });
    if (!res.ok) return 0;
    const statuses = await res.json() as TimelineStatus[];
    if (!Array.isArray(statuses)) return 0;
    const accounts = new Set<string>();
    for (const s of statuses) {
      if (
        s.account.id !== auth.accountId &&
        new Date(s.created_at).getTime() >= cutoff &&
        s.media_attachments.length > 0 &&
        hasMeenowTag(s.tags)
      ) {
        accounts.add(s.account.id);
      }
    }
    return accounts.size;
  } catch {
    return 0;
  }
}
