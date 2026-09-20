// Social graph client: handle resolution, follow/unfollow, relationships, follow
// requests, peer connection lists, and account lock state. Encapsulates the
// "one-tap mutual" semantics meenow uses for its small friend circles. SW-unsafe
// (uses no DOM, but is app-only) — keep separate from pixelfed.ts, which owns the
// post/feed lifecycle and its home-timeline cache.
import type { AuthState } from './auth';

export interface Connection {
  id: string;          // account id on the user's instance (what follow/authorize take)
  displayName: string;
  username: string;
  acct: string;        // "user" (local) or "user@instance" (remote)
  avatarUrl: string;
  url: string;
}

export interface Relationship {
  id: string;
  following: boolean;
  followedBy: boolean;
  requested: boolean;  // your outgoing follow is pending their approval
  blocking: boolean;
  blockedBy: boolean;
}

export type ConnectionKind = 'followers' | 'following';

interface ApiAccount {
  id: string;
  username: string;
  display_name: string;
  acct: string;
  avatar: string;
  url: string;
}

interface ApiRelationship {
  id: string;
  following?: boolean;
  followed_by?: boolean;
  requested?: boolean;
  blocking?: boolean;
  blocked_by?: boolean;
}

function authHeaders(auth: AuthState): HeadersInit {
  return { Authorization: `Bearer ${auth.accessToken}` };
}

function toConnection(a: ApiAccount): Connection {
  return {
    id: a.id,
    displayName: a.display_name || a.username,
    username: a.username,
    acct: a.acct || a.username,
    avatarUrl: a.avatar,
    url: a.url,
  };
}

function toRelationship(r: ApiRelationship): Relationship {
  return {
    id: r.id,
    following: !!r.following,
    followedBy: !!r.followed_by,
    requested: !!r.requested,
    blocking: !!r.blocking,
    blockedBy: !!r.blocked_by,
  };
}

// Resolve "user" or "user@instance" to an account on the user's instance,
// triggering federation via WebFinger (resolve=true). Falls back to the
// lookup endpoint, which is less consistent on Pixelfed. Returns null when no
// exact match is found.
export async function resolveHandle(auth: AuthState, handle: string): Promise<Connection | null> {
  let q = handle.trim().replace(/^@/, '');
  if (!q) return null;
  // A handle qualified with the caller's own instance (e.g. from an invite link
  // built by a same-instance friend) is local: the API returns its acct bare
  // (no domain), so strip the domain here rather than in matchHandle, which
  // otherwise treats any domain-qualified query as remote-only.
  const at = q.lastIndexOf('@');
  if (at > 0 && q.slice(at + 1).toLowerCase() === auth.instance.toLowerCase()) {
    q = q.slice(0, at);
  }

  try {
    const url = new URL(`https://${auth.instance}/api/v1/accounts/search`);
    url.searchParams.set('q', q);
    url.searchParams.set('resolve', 'true');
    url.searchParams.set('limit', '5');
    const res = await fetch(url.toString(), { headers: authHeaders(auth) });
    if (res.ok) {
      const match = matchHandle(await res.json() as ApiAccount[], q);
      if (match) return toConnection(match);
    }
  } catch { /* fall through to lookup */ }

  try {
    const url = new URL(`https://${auth.instance}/api/v1/accounts/lookup`);
    url.searchParams.set('acct', q);
    const res = await fetch(url.toString(), { headers: authHeaders(auth) });
    if (res.ok) return toConnection(await res.json() as ApiAccount);
  } catch { /* ignore */ }

  return null;
}

function matchHandle(accounts: ApiAccount[], q: string): ApiAccount | undefined {
  const lower = q.toLowerCase();
  const byAcct = accounts.find(a => a.acct.toLowerCase() === lower);
  if (byAcct) return byAcct;
  // Only accept a bare-username match when the query carried no domain, so a
  // search for "alice@other" never silently resolves to a local "alice".
  if (!lower.includes('@')) return accounts.find(a => a.username.toLowerCase() === lower);
  return undefined;
}

// Pixelfed doesn't reliably return a usable relationship body from follow/unfollow
// (sometimes empty), which would otherwise throw on res.json() despite the action
// having succeeded and make the button revert as if the tap had failed. Fall back
// to an authoritative relationships lookup when the body doesn't parse.
async function parseRelationship(auth: AuthState, res: Response, accountId: string): Promise<Relationship> {
  try {
    return toRelationship(await res.json() as ApiRelationship);
  } catch {
    const rel = (await fetchRelationships(auth, [accountId])).get(accountId);
    if (rel) return rel;
    throw new Error('No relationship in response');
  }
}

export async function follow(auth: AuthState, accountId: string): Promise<Relationship> {
  const res = await fetch(`https://${auth.instance}/api/v1/accounts/${accountId}/follow`, {
    method: 'POST',
    headers: authHeaders(auth),
  });
  if (!res.ok) throw new Error(`Follow failed (${res.status})`);
  return parseRelationship(auth, res, accountId);
}

export async function unfollow(auth: AuthState, accountId: string): Promise<Relationship> {
  const res = await fetch(`https://${auth.instance}/api/v1/accounts/${accountId}/unfollow`, {
    method: 'POST',
    headers: authHeaders(auth),
  });
  if (!res.ok) throw new Error(`Unfollow failed (${res.status})`);
  return parseRelationship(auth, res, accountId);
}

export async function fetchRelationships(auth: AuthState, ids: string[]): Promise<Map<string, Relationship>> {
  const map = new Map<string, Relationship>();
  const unique = [...new Set(ids)].filter(Boolean);
  for (let i = 0; i < unique.length; i += 40) {
    const chunk = unique.slice(i, i + 40);
    const url = new URL(`https://${auth.instance}/api/v1/accounts/relationships`);
    chunk.forEach(id => url.searchParams.append('id[]', id));
    try {
      const res = await fetch(url.toString(), { headers: authHeaders(auth) });
      if (!res.ok) continue;
      (await res.json() as ApiRelationship[]).forEach(r => map.set(r.id, toRelationship(r)));
    } catch { /* skip this chunk */ }
  }
  return map;
}

export async function fetchFollowRequests(auth: AuthState): Promise<Connection[]> {
  const res = await fetch(`https://${auth.instance}/api/v1/follow_requests?limit=40`, {
    headers: authHeaders(auth),
  });
  if (!res.ok) throw new Error(`Could not load requests (${res.status})`);
  return (await res.json() as ApiAccount[]).map(toConnection);
}

// :id is the requester's account id. The resulting relationship comes from the
// back-follow call in acceptAndBackFollow, not from parsing this response body —
// Pixelfed is inconsistent about what (if anything) this endpoint returns.
export async function authorizeFollowRequest(auth: AuthState, accountId: string): Promise<void> {
  const res = await fetch(`https://${auth.instance}/api/v1/follow_requests/${accountId}/authorize`, {
    method: 'POST',
    headers: authHeaders(auth),
  });
  if (!res.ok) throw new Error(`Authorize failed (${res.status})`);
}

export async function rejectFollowRequest(auth: AuthState, accountId: string): Promise<void> {
  const res = await fetch(`https://${auth.instance}/api/v1/follow_requests/${accountId}/reject`, {
    method: 'POST',
    headers: authHeaders(auth),
  });
  if (!res.ok) throw new Error(`Reject failed (${res.status})`);
}

// Throws on a genuine non-2xx so the user's own circle can show a retry;
// hide_collections returns an empty 200, so peer screens see [] naturally and
// can additionally treat a thrown error as "nothing to show".
export async function fetchConnections(auth: AuthState, accountId: string, kind: ConnectionKind): Promise<Connection[]> {
  const res = await fetch(`https://${auth.instance}/api/v1/accounts/${accountId}/${kind}?limit=40`, {
    headers: authHeaders(auth),
  });
  if (!res.ok) throw new Error(`Could not load ${kind} (${res.status})`);
  return (await res.json() as ApiAccount[]).map(toConnection);
}

export async function fetchMyAccount(auth: AuthState): Promise<{ id: string; acct: string; locked: boolean }> {
  const res = await fetch(`https://${auth.instance}/api/v1/accounts/verify_credentials`, {
    headers: authHeaders(auth),
  });
  if (!res.ok) throw new Error(`Could not load account (${res.status})`);
  const a = await res.json() as { id: string; acct: string; locked?: boolean };
  return { id: a.id, acct: a.acct, locked: !!a.locked };
}

// Meenow's privacy posture in one call: `locked` (approve followers manually)
// plus `is_suggestable` (out of discovery/suggested lists). Both are needed for
// a closed circle; neither implies the other server-side. Locking also hides
// your posts and follower list, so discovery is the remaining way for strangers
// to find you.
//
// `is_suggestable` is the real field: the Mastodon-style `discoverable` in API
// responses is hardcoded true by Pixelfed's AccountTransformer and tells you
// nothing. Invites are unaffected — a ?add= link resolves by handle and sends a
// follow request, which works regardless of either flag.
export async function setAccountPrivacy(auth: AuthState, locked: boolean): Promise<boolean> {
  // Must be urlencoded, not FormData: PHP only parses multipart bodies on POST,
  // so a multipart PATCH is silently ignored — Pixelfed answers 200 with the
  // unchanged profile. URLSearchParams makes fetch send an urlencoded body,
  // which PATCH does parse. (Verified live against pixelfed.social.)
  const body = new URLSearchParams({
    locked: String(locked),
    is_suggestable: String(!locked),
  });
  const res = await fetch(`https://${auth.instance}/api/v1/accounts/update_credentials`, {
    method: 'PATCH',
    headers: authHeaders(auth),
    body,
  });
  if (!res.ok) return false;
  // Pixelfed can answer 200 with an unchanged profile (that silent-ignore is
  // exactly what the urlencoded body above avoids), so trust the echoed
  // state rather than the status code alone. `locked` is the only one of the
  // two fields the response exposes; both travel through the same parser, so
  // a matching echo means the whole body was read and applied.
  try {
    const data = await res.json() as { locked?: boolean };
    return data.locked === locked;
  } catch {
    return false;
  }
}

// --- One-tap mutual helpers (single shared path for every entry point) ---

// Outgoing half: follow them. Their acceptance + back-follow completes the circle.
export function connectTo(auth: AuthState, accountId: string): Promise<Relationship> {
  return follow(auth, accountId);
}

// Accepting an incoming request: authorize them (they can see your posts), then
// auto-follow back (you can see theirs, or it queues if they're also locked).
// If the back-follow fails, the authorize already succeeded — callers surface a
// non-fatal state rather than rolling back.
export async function acceptAndBackFollow(auth: AuthState, accountId: string): Promise<Relationship> {
  await authorizeFollowRequest(auth, accountId);
  return follow(auth, accountId);
}

// --- Pending follow-request count (drives the feed-header badge) ---

let _reqCache: { count: number; fetchedAt: number } | null = null;
const REQ_CACHE_TTL_MS = 30_000;

export async function fetchPendingRequestCount(auth: AuthState): Promise<number> {
  if (_reqCache && Date.now() - _reqCache.fetchedAt < REQ_CACHE_TTL_MS) return _reqCache.count;
  try {
    const count = (await fetchFollowRequests(auth)).length;
    _reqCache = { count, fetchedAt: Date.now() };
    return count;
  } catch {
    return _reqCache?.count ?? 0;
  }
}

export function invalidatePendingRequestCache(): void {
  _reqCache = null;
}
