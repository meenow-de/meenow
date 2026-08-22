// Pixelfed/Mastodon API client: media upload, posting, home timeline cache, feed filtering, post context, replies, and user's own posts.
import type { AuthState } from './auth';
import { patchAccountId } from './auth';
import { getLastTriggerTime } from '../timer';
import { MAX_POSTS_PER_TRIGGER } from '../state';
import { idbGet, IDB_KEYS } from '../idb';

// --- Mastodon/Pixelfed API types ---

interface MastodonAccount {
  id: string;
  username: string;
  acct: string;
  display_name: string;
  avatar: string;
  url: string;
}

interface MastodonMediaAttachment {
  id: string;
  url: string;
  preview_url: string;
}

interface MastodonTag {
  name: string;
}

interface MastodonStatus {
  id: string;
  url: string;
  created_at: string;
  replies_count: number;
  content: string;
  account: MastodonAccount;
  media_attachments: MastodonMediaAttachment[];
  tags: MastodonTag[];
}

// --- Public types ---

export interface FeedPost {
  id: string;
  url: string;
  createdAt: Date;
  replyCount: number;
  statusText: string;
  location: string;
  account: {
    id: string;
    displayName: string;
    username: string;
    acct: string;
    avatarUrl: string;
    url: string;
  };
  compositeUrl: string;
  allMediaUrls: string[];
}

export interface MastodonReply {
  id: string;
  created_at: string;
  account: {
    display_name: string;
    username: string;
    avatar: string;
  };
  content: string;
}

interface PostContext {
  ancestors: MastodonReply[];
  descendants: MastodonReply[];
}

// --- Upload / post ---

const RETRY_DELAYS_MS = [1000, 2000];

// Retries transport-level failures (TypeError: the request never reached the
// server) with backoff, and a 5xx response once. 4xx returns immediately.
async function fetchRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500 || attempt >= 1) return res;
    } catch (err) {
      if (!(err instanceof TypeError) || attempt >= RETRY_DELAYS_MS.length) throw err;
    }
    await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]));
  }
}

// Upload progress carried across manual retries: media already uploaded are
// not re-uploaded, and the idempotency key prevents a duplicate status.
export interface PostProgress {
  compositeId?: string;
  backId?: string;
  frontId?: string;
  idemKey?: string;
}

async function uploadOne(auth: AuthState, blob: Blob, description: string): Promise<string> {
  const form = new FormData();
  form.append('file', blob, 'meenow.jpg');
  form.append('description', description);

  const res = await fetchRetry(`https://${auth.instance}/api/v1/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.accessToken}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Media upload failed (${res.status})`);
  const media = await res.json() as { id: string; url: string | null };

  if (media.url !== null) return media.id;

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const poll = await fetchRetry(`https://${auth.instance}/api/v1/media/${media.id}`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (!poll.ok) throw new Error(`Media poll failed (${poll.status})`);
    const m = await poll.json() as { url: string | null };
    if (m.url !== null) return media.id;
  }
  throw new Error('Media processing timed out');
}

export async function postMeenow(
  auth: AuthState,
  composite: Blob,
  backPhoto: Blob,
  frontPhoto: Blob,
  statusText?: string,
  progress: PostProgress = {},
): Promise<string> {
  // Upload composite first so it gets the lowest attachment ID and appears first in the gallery
  progress.compositeId ??= await uploadOne(auth, composite, 'meenow — daily photo');
  [progress.backId, progress.frontId] = await Promise.all([
    progress.backId ?? uploadOne(auth, backPhoto, 'meenow — surroundings'),
    progress.frontId ?? uploadOne(auth, frontPhoto, 'meenow — selfie'),
  ]);

  progress.idemKey ??= crypto.randomUUID();
  const status = statusText ? `${statusText}\n\n#meenowApp` : '#meenowApp';
  const res = await fetchRetry(`https://${auth.instance}/api/v1/statuses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': progress.idemKey,
    },
    body: JSON.stringify({
      status,
      media_ids: [progress.compositeId, progress.backId, progress.frontId],
      visibility: 'private',
    }),
  });
  if (!res.ok) throw new Error(`Post failed (${res.status})`);
  const statusData = await res.json() as MastodonStatus;
  // Pixelfed's create-status response can omit the parsed hashtags, which would
  // make the new post fail the feed's #meenowApp filter (and stay hidden through
  // pull-to-refresh, since the cache dedups by id) until a full reload rebuilds
  // the cache from the timeline. We know we just posted it with the tag, so
  // ensure it is present on the object we cache.
  if (!(statusData.tags ?? []).some(t => t.name.toLowerCase() === 'meenowapp')) {
    statusData.tags = [...(statusData.tags ?? []), { name: 'meenowApp' }];
  }
  // Prepend the new post so the feed shows it immediately without a re-fetch.
  // newestId advances so the next incremental fetch uses it as since_id.
  if (_homeCache) {
    _homeCache.statuses = [statusData, ..._homeCache.statuses];
    if (isNewerId(statusData.id, _homeCache.newestId)) _homeCache.newestId = statusData.id;
  } else {
    // No cache yet (e.g. posting before the first feed fetch resolved): seed one
    // so the post shows immediately. newestId stays empty so the next fetch is a
    // full one that backfills friends' posts; fetchedAt 0 makes it fire at once.
    _homeCache = { statuses: [statusData], newestId: '', fetchedAt: 0 };
  }
  return statusData.url;
}

// Numeric ID compare — string compare is wrong for differing lengths ("9" > "100").
function isNewerId(a: string, b: string): boolean {
  if (!b) return true;
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return a > b;
  }
}

// --- Feed ---

// Session-level home timeline cache. The first call does a full fetch; subsequent
// calls within HOME_CACHE_TTL_MS return the cached data directly. After the TTL,
// an incremental fetch with since_id is attempted; incoming posts are deduplicated
// by ID before merging because Pixelfed may return the full list regardless.
// _homePending deduplicates concurrent callers during the initial page-load sequence.
const HOME_TIMELINE_LIMIT = 40;
const HOME_CACHE_TTL_MS = 10_000;
// Cap the cache so incremental since_id prepends can't grow it unbounded.
const HOME_CACHE_MAX = HOME_TIMELINE_LIMIT * 3;
interface HomeCache { statuses: MastodonStatus[]; newestId: string; fetchedAt: number }
let _homeCache: HomeCache | null = null;
let _homePending: Promise<MastodonStatus[]> | null = null;

// `force` skips the TTL short-circuit (explicit user refresh); the fetch itself
// stays incremental via since_id and concurrent callers still share _homePending.
function fetchHomeTimeline(auth: AuthState, force = false): Promise<MastodonStatus[]> {
  if (_homePending) return _homePending;
  if (!force && _homeCache && Date.now() - _homeCache.fetchedAt < HOME_CACHE_TTL_MS) {
    return Promise.resolve(_homeCache.statuses);
  }

  const url = _homeCache?.newestId
    ? `https://${auth.instance}/api/v1/timelines/home?limit=${HOME_TIMELINE_LIMIT}&since_id=${_homeCache.newestId}`
    : `https://${auth.instance}/api/v1/timelines/home?limit=${HOME_TIMELINE_LIMIT}`;

  // no-store: the full-page URL is identical on every launch, so a stale HTTP
  // cache hit would render an old snapshot missing the newest posts (the user's
  // own post first among them, which also re-blurs the feed via the count).
  _homePending = fetch(url, { headers: { Authorization: `Bearer ${auth.accessToken}` }, cache: 'no-store' })
    .then(r => {
      // A failed fetch must reject, not resolve empty: an empty result would be
      // cached and render as a legitimately empty feed / zero post count.
      if (!r.ok) throw new Error(`Home timeline fetch failed (${r.status})`);
      return r.json() as Promise<MastodonStatus[]>;
    })
    .then(incoming => {
      const now = Date.now();
      if (_homeCache) {
        const seen = new Set(_homeCache.statuses.map(s => s.id));
        const fresh = incoming.filter(s => !seen.has(s.id));
        if (fresh.length > 0) {
          _homeCache.statuses = [...fresh, ..._homeCache.statuses].slice(0, HOME_CACHE_MAX);
          _homeCache.newestId = fresh[0].id;
        }
        _homeCache.fetchedAt = now;
      } else {
        _homeCache = { statuses: incoming, newestId: incoming[0]?.id ?? '', fetchedAt: now };
      }
      _homePending = null;
      return _homeCache.statuses;
    })
    .catch(err => { _homePending = null; throw err; });

  return _homePending;
}

async function resolveAccountId(auth: AuthState): Promise<string | undefined> {
  if (auth.accountId) return auth.accountId;
  try {
    const res = await fetch(`https://${auth.instance}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (res.ok) {
      const { id } = await res.json() as { id: string };
      patchAccountId(auth.instance, id);
      return id;
    }
  } catch { /* ignore */ }
  return undefined;
}

function hasMeenowTag(s: MastodonStatus): boolean {
  return (s.tags ?? []).some(t => t.name.toLowerCase() === 'meenowapp');
}

function parseStatusParts(htmlContent: string): { caption: string; location: string } {
  const div = document.createElement('div');
  div.innerHTML = htmlContent;
  div.querySelectorAll('a').forEach(a => {
    if ((a.textContent ?? '').replace(/[^a-z]/gi, '').toLowerCase() === 'meenowapp') {
      a.remove();
    }
  });
  div.querySelectorAll('p').forEach(p => {
    p.prepend(document.createTextNode('\n'));
  });
  const full = (div.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
  const lines = full.split('\n');
  const locIdx = lines.findIndex(l => l.startsWith('📍'));
  if (locIdx === -1) return { caption: full, location: '' };
  const location = lines[locIdx].replace(/^📍\s*/, '').trim();
  lines.splice(locIdx, 1);
  return { caption: lines.join('\n').trim(), location };
}

function toFeedPost(s: MastodonStatus): FeedPost {
  const { caption, location } = parseStatusParts(s.content);
  return {
    id: s.id,
    url: s.url,
    createdAt: new Date(s.created_at),
    replyCount: s.replies_count,
    statusText: caption,
    location,
    account: {
      id: s.account.id,
      displayName: s.account.display_name || s.account.username,
      username: s.account.username,
      acct: s.account.acct || s.account.username,
      avatarUrl: s.account.avatar,
      url: s.account.url,
    },
    compositeUrl: s.media_attachments[0]?.url ?? '',
    allMediaUrls: s.media_attachments.map(m => m.url),
  };
}

function triggerArchive(auth: AuthState, statuses: MastodonStatus[]): void {
  if (!auth.accountId) return;
  const cutoff = getLastTriggerTime();
  Promise.allSettled(
    statuses
      .filter(s =>
        s.account.id === auth.accountId &&
        hasMeenowTag(s) &&
        s.media_attachments.length > 0 &&
        new Date(s.created_at) < cutoff
      )
      .map(s =>
        fetch(`https://${auth.instance}/api/v1.1/archive/add/${s.id}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.accessToken}` },
        })
      )
  );
}

export async function fetchMeenowFeed(auth: AuthState, force = false): Promise<FeedPost[]> {
  const cutoff = getLastTriggerTime().getTime();
  const statuses = await fetchHomeTimeline(auth, force);
  triggerArchive(auth, statuses);
  const sorted = statuses
    .filter(s =>
      new Date(s.created_at).getTime() >= cutoff &&
      s.media_attachments.length > 0 &&
      hasMeenowTag(s)
    )
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  // Cap each account to MAX_POSTS_PER_TRIGGER newest posts to prevent bypassing
  // the limit by posting directly on Pixelfed with the tag.
  const seenCount = new Map<string, number>();
  return sorted
    .filter(s => {
      const count = seenCount.get(s.account.id) ?? 0;
      if (count >= MAX_POSTS_PER_TRIGGER) return false;
      seenCount.set(s.account.id, count + 1);
      return true;
    })
    .map(toFeedPost);
}

export async function fetchTodayPostCount(auth: AuthState): Promise<number> {
  const accountId = await resolveAccountId(auth);
  if (!accountId) return 0;
  const periodStart = getLastTriggerTime().getTime();
  const countOwn = (statuses: MastodonStatus[]): number =>
    statuses.filter(s =>
      s.account.id === accountId &&
      new Date(s.created_at).getTime() >= periodStart &&
      hasMeenowTag(s)
    ).length;
  try {
    let count = countOwn(await fetchHomeTimeline(auth));
    if (count === 0 && await idbGet<number>(IDB_KEYS.postedTriggerMs) === periodStart) {
      // This device posted in the current period but the timeline snapshot
      // lacks the post — the full-page response was stale (e.g. a server-side
      // timeline cache). One forced since_id refetch recovers it, the same way
      // pull-to-refresh does; the merge also heals _homeCache for the feed.
      count = countOwn(await fetchHomeTimeline(auth, true));
    }
    return count;
  } catch {
    return 0;
  }
}

async function fetchArchivedStatuses(auth: AuthState): Promise<MastodonStatus[]> {
  try {
    const res = await fetch(`https://${auth.instance}/api/v1.1/archive/list`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
    });
    if (!res.ok) return [];
    // Pixelfed returns a paginated envelope { data: [...] }; plain arrays are also handled.
    const json = await res.json() as MastodonStatus[] | { data: MastodonStatus[] };
    return Array.isArray(json) ? json : (json.data ?? []);
  } catch {
    return [];
  }
}

export async function fetchMyAllPosts(auth: AuthState): Promise<FeedPost[]> {
  const accountId = await resolveAccountId(auth);
  if (!accountId) return [];
  const url = new URL(`https://${auth.instance}/api/v1/accounts/${accountId}/statuses`);
  url.searchParams.set('limit', String(HOME_TIMELINE_LIMIT));
  url.searchParams.set('only_media', 'true');

  const [res, archived] = await Promise.all([
    fetch(url.toString(), { headers: { Authorization: `Bearer ${auth.accessToken}` } }),
    fetchArchivedStatuses(auth),
  ]);
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
  const statuses = await res.json() as MastodonStatus[];

  triggerArchive(auth, statuses);

  const seen = new Set(statuses.map(s => s.id));
  const merged = [...statuses, ...archived.filter(s => !seen.has(s.id))];

  return merged
    .filter(s => hasMeenowTag(s) && s.media_attachments.length > 0)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map(toFeedPost);
}

export async function fetchPostContext(auth: AuthState, statusId: string): Promise<PostContext> {
  const res = await fetch(`https://${auth.instance}/api/v1/statuses/${statusId}/context`, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  });
  if (!res.ok) throw new Error(`Context fetch failed (${res.status})`);
  const raw = await res.json() as { ancestors?: MastodonReply[]; descendants?: MastodonReply[] };
  return { ancestors: raw.ancestors ?? [], descendants: raw.descendants ?? [] };
}

export async function postReply(auth: AuthState, inReplyToId: string, content: string): Promise<void> {
  const res = await fetch(`https://${auth.instance}/api/v1/statuses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status: content,
      in_reply_to_id: inReplyToId,
      visibility: 'private',
    }),
  });
  if (!res.ok) throw new Error(`Reply failed (${res.status})`);
}

export async function deletePost(auth: AuthState, statusId: string): Promise<void> {
  const res = await fetch(`https://${auth.instance}/api/v1/statuses/${statusId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  });
  if (!res.ok) throw new Error(`Delete failed (${res.status})`);
}

export function removePostFromCache(postId: string): void {
  if (_homeCache) {
    _homeCache.statuses = _homeCache.statuses.filter(s => s.id !== postId);
  }
}
