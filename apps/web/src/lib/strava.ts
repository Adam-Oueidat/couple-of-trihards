import {
  AthleteDetail,
  AthleteStats,
  AthleteZones,
  DetailedActivity,
  StravaActivity,
  StravaTokens,
  StreamSet,
  createLogger,
} from "@trihards/core";
import { and, eq } from "drizzle-orm";
import { getDb, stravaCache } from "@trihards/db";
import { getValidAccessToken } from "./strava-tokens";
import { localDateOf, resolveToday } from "./coach-dates";

const log = createLogger("strava");

const STRAVA_API = "https://www.strava.com/api/v3";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";

// Strava returns a branded HTML outage page (~8KB) on 5xx, which used to be
// logged whole and buried every other line in CloudWatch. Nothing past the
// first line is diagnostic — the status code is the signal.
const MAX_LOGGED_BODY = 300;

function truncate(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_LOGGED_BODY
    ? `${oneLine.slice(0, MAX_LOGGED_BODY)}… (${oneLine.length} chars)`
    : oneLine;
}

// Two retries, ~1.2s of total added latency in the worst case. Strava's 5xx
// blips are typically seconds long, so this hides most of them entirely.
//
// 429 is deliberately NOT retried: Strava's limit is 100 reads per 15 minutes,
// so a retry seconds later cannot succeed and only spends more of the budget.
// It fails fast and surfaces instead.
const RETRYABLE_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = [300, 900];

function isRetryable(status: number): boolean {
  return status >= 500 && status < 600;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// In-memory TTL cache for per-activity responses (detail, streams) that are
// triggered by opening an activity, not by a page refresh. Cleared on server
// restart, which is fine. The dashboard render-path responses use the durable
// DB-backed cache below instead (dbCached) so a plain reload never hits Strava.
const apiCache = new Map<string, { data: unknown; expires: number }>();

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = apiCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data as T;
  const data = await fn();
  apiCache.set(key, { data, expires: Date.now() + ttlMs });
  return data;
}

// Durable, persistent-until-invalidated cache for the dashboard render path.
// Backed by the database (not an in-memory Map) so it survives server restarts
// and is shared across serverless instances — this is what makes a plain
// browser reload re-serve cached data instead of spending Strava rate-limit
// budget (100 reads / 15 min). A new Strava fetch happens only when there is no
// row yet (first load after a server restart, or right after invalidation) or
// after invalidateAthleteCache drops the athlete's rows.
// The cached payload together with the Unix-seconds stamp of the Strava fetch
// that produced it. Both come out of the one row, so callers that need the
// timestamp (the dashboard's "Synced …" label, the daily-sync check) read it
// from the same query rather than going back for a second look.
interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

async function dbCachedEntry<T>(
  athleteId: number,
  cacheKey: string,
  fn: () => Promise<T>
): Promise<CacheEntry<T>> {
  const db = getDb();
  const [hit] = await db
    .select({ data: stravaCache.data, fetchedAt: stravaCache.fetchedAt })
    .from(stravaCache)
    .where(and(eq(stravaCache.athleteId, athleteId), eq(stravaCache.cacheKey, cacheKey)));
  if (hit) return { data: JSON.parse(hit.data) as T, fetchedAt: hit.fetchedAt };

  return writeCacheEntry(athleteId, cacheKey, await fn());
}

// Upsert one cache row and report the stamp written. Split out of
// dbCachedEntry so a refresh can overwrite a row in place: the old row stays
// readable until the replacement is in hand, which is what lets an upstream
// outage fall back to it (see getActivitiesWithDailySync).
async function writeCacheEntry<T>(
  athleteId: number,
  cacheKey: string,
  data: T,
): Promise<CacheEntry<T>> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const serialized = JSON.stringify(data);
  await db
    .insert(stravaCache)
    .values({ athleteId, cacheKey, data: serialized, fetchedAt: now })
    .onConflictDoUpdate({
      target: [stravaCache.athleteId, stravaCache.cacheKey],
      set: { data: serialized, fetchedAt: now },
    });
  return { data, fetchedAt: now };
}

async function dbCached<T>(
  athleteId: number,
  cacheKey: string,
  fn: () => Promise<T>
): Promise<T> {
  return (await dbCachedEntry(athleteId, cacheKey, fn)).data;
}

/**
 * The caller whose Strava data we are fetching.
 *
 * Both ids travel together deliberately: `userId` selects the credentials and
 * every database row, `athleteId` keys the response cache. They used to be
 * resolved from two different places — `auth.userId` for our tables and the
 * session cookie for Strava — which meant a request could read one user's plan
 * while fetching another user's activities.
 */
export interface StravaIdentity {
  userId: string;
  stravaAthleteId: number;
}

// Drops every cached Strava response for one athlete so the next render
// refetches live data. This is the ONLY way the dashboard's data refreshes:
// it's called by the manual "Sync" action (refreshDashboard) and on a fresh
// OAuth login (auth callback). Rows are otherwise persistent, so a plain
// browser refresh re-serves the cache and stays within Strava's rate limits.
export async function invalidateAthleteCache(athleteId: number): Promise<void> {
  const db = getDb();
  await db.delete(stravaCache).where(eq(stravaCache.athleteId, athleteId));
}

// Serves cached activities, but if the last sync happened on an earlier
// athlete-local day, invalidates once and refetches live — a daily auto-sync
// that mirrors the coach's new-day reset (app/api/chat/route.ts). This is the
// only automatic refresh: within the same local day the check is false, so a
// plain reload keeps re-serving the cache and stays off Strava's rate limit.
// The initial read comes from the DB cache (no Strava call), so a stale day
// costs exactly one live refetch. Returns the (possibly refreshed) activities
// and last-sync timestamp (Unix seconds; null before any row exists).
export async function getActivitiesWithDailySync(
  identity: StravaIdentity,
  weeks = 12,
): Promise<{ activities: StravaActivity[]; fetchedAt: number; stale: boolean }> {
  const { stravaAthleteId: athleteId } = identity;
  // One query, not two: the activities and the stamp of the sync that produced
  // them live in the same row. Reading them separately meant a second round
  // trip that re-scanned the largest row we store just to pick one integer off
  // it — and it sat on the dashboard's critical path.
  const entry = await recentActivitiesEntry(identity, weeks);

  // Server render has no client-sent date, so "today" is derived from the
  // athlete's activity-based UTC offset (same as the rest of the dashboard).
  const today = resolveToday(undefined, entry.data);
  if (localDateOf(entry.fetchedAt, entry.data) === today) {
    return { activities: entry.data, fetchedAt: entry.fetchedAt, stale: false };
  }

  // A new day: try to refresh. If Strava is unreachable this is NOT fatal —
  // yesterday's activities are still a correct, complete answer, just one sync
  // behind, so we serve them and flag the page as stale rather than throwing
  // the whole dashboard away over an upstream blip.
  try {
    const fresh = await refreshActivitiesCache(identity, weeks);
    return { activities: fresh.data, fetchedAt: fresh.fetchedAt, stale: false };
  } catch (err) {
    log.warn("daily sync failed, serving cached activities", {
      athleteId,
      cachedAt: entry.fetchedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    return { activities: entry.data, fetchedAt: entry.fetchedAt, stale: true };
  }
}

export function getStravaAuthUrl(state?: string): string {
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID!,
    redirect_uri: process.env.STRAVA_REDIRECT_URI!,
    response_type: "code",
    approval_prompt: "auto",
    // profile:read_all is required for /athlete/zones (HR zones) and to
    // receive weight/FTP fields on /athlete.
    scope: "read,activity:read_all,profile:read_all",
  });
  // CSRF defense: a signed state, echoed back by Strava and verified against a
  // browser cookie in the callback, so a forged callback can't log a victim in.
  if (state) params.set("state", state);
  return `https://www.strava.com/oauth/authorize?${params}`;
}

export async function exchangeCodeForTokens(code: string): Promise<StravaTokens> {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
    athlete_id: data.athlete.id,
    athlete_firstname: data.athlete.firstname,
    athlete_lastname: data.athlete.lastname,
    athlete_profile: data.athlete.profile_medium,
  };
}

async function stravaFetch<T>(
  userId: string,
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const token = await getValidAccessToken(userId);
  const url = new URL(`${STRAVA_API}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= RETRYABLE_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_BACKOFF_MS[attempt - 1]);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        next: { revalidate: 0 },
      });
    } catch (err) {
      // DNS/TCP/TLS failure — no response at all. Worth another try.
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn("strava fetch failed", { path, attempt, error: lastError.message });
      continue;
    }

    if (res.ok) {
      log.debug("strava fetch ok", { path, status: res.status, attempt });
      return res.json();
    }

    const err = await res.text();
    lastError = new Error(`Strava API error ${res.status}: ${truncate(err)}`);

    if (!isRetryable(res.status) || attempt === RETRYABLE_ATTEMPTS) {
      log.error("strava API error", {
        path,
        status: res.status,
        attempt,
        body: truncate(err),
      });
      throw lastError;
    }

    log.warn("strava API error, retrying", { path, status: res.status, attempt });
  }

  throw lastError ?? new Error(`Strava request to ${path} failed`);
}

// Strava's summary-activity payload carries ~58 fields per activity (map
// polylines, lat/lng arrays, device/upload metadata, kudos counts, …). We only
// consume the ~20 declared on StravaActivity, so we project down to those before
// anything caches or persists the result. This keeps the durable strava_cache
// rows ~65% smaller — the activities:* row is by far the largest thing we store.
// Anything the app reads is in StravaActivity by construction; to surface a new
// field, add it here and to the interface (and re-sync to backfill cached rows).
function toStravaActivity(a: StravaActivity): StravaActivity {
  return {
    id: a.id,
    name: a.name,
    sport_type: a.sport_type,
    type: a.type,
    start_date: a.start_date,
    start_date_local: a.start_date_local,
    distance: a.distance,
    moving_time: a.moving_time,
    elapsed_time: a.elapsed_time,
    total_elevation_gain: a.total_elevation_gain,
    average_speed: a.average_speed,
    max_speed: a.max_speed,
    average_heartrate: a.average_heartrate,
    max_heartrate: a.max_heartrate,
    suffer_score: a.suffer_score,
    kilojoules: a.kilojoules,
    average_watts: a.average_watts,
    weighted_average_watts: a.weighted_average_watts,
    trainer: a.trainer,
    manual: a.manual,
  };
}

async function getActivities(
  userId: string,
  page = 1,
  perPage = 50,
  after?: number
): Promise<StravaActivity[]> {
  const params: Record<string, string> = {
    page: String(page),
    per_page: String(perPage),
  };
  if (after) params.after = String(after);
  const raw = await stravaFetch<StravaActivity[]>(userId, "/athlete/activities", params);
  return raw.map(toStravaActivity);
}

export async function getActivityDetail(
  { userId, stravaAthleteId: athleteId }: StravaIdentity,
  id: number,
): Promise<DetailedActivity> {
  // Keyed by athlete as well as activity. Strava would reject one athlete's
  // token for another athlete's private activity, but a cache hit never reaches
  // Strava — an unkeyed `detail:${id}` serves athlete A's private payload to
  // athlete B for the full TTL. Callers must still authorize the id itself
  // (see lib/activity-access.ts); this only stops the cache from leaking.
  return cached(`detail:${athleteId}:${id}`, 60 * 60_000, async () => {
    return stravaFetch<DetailedActivity>(userId, `/activities/${id}`);
  });
}

// Athlete detail/zones/stats back the dashboard's Fitness Profile, which is
// re-fetched on every dashboard load. Cache persistently (sync only on login or
// the "Sync" button) for the same reason as getRecentActivities — a plain
// refresh must not hit Strava. invalidateAthleteCache drops these rows.
export async function getAthleteDetail({
  userId,
  stravaAthleteId: athleteId,
}: StravaIdentity): Promise<AthleteDetail> {
  return dbCached(athleteId, "athlete-detail", () =>
    stravaFetch<AthleteDetail>(userId, "/athlete"),
  );
}

export async function getAthleteZones({
  userId,
  stravaAthleteId: athleteId,
}: StravaIdentity): Promise<AthleteZones> {
  return dbCached(athleteId, "athlete-zones", () =>
    stravaFetch<AthleteZones>(userId, "/athlete/zones"),
  );
}

export async function getAthleteStats({
  userId,
  stravaAthleteId: athleteId,
}: StravaIdentity): Promise<AthleteStats> {
  return dbCached(athleteId, "athlete-stats", () =>
    stravaFetch<AthleteStats>(userId, `/athletes/${athleteId}/stats`),
  );
}

export async function getActivityStreams(
  { userId, stravaAthleteId: athleteId }: StravaIdentity,
  id: number,
): Promise<StreamSet | null> {
  // Athlete-scoped for the same reason as getActivityDetail above.
  return cached(`streams:${athleteId}:${id}`, 60 * 60_000, async () => {
    try {
      return await stravaFetch<StreamSet>(userId, `/activities/${id}/streams`, {
        keys: "time,distance,heartrate,velocity_smooth,altitude,watts",
        key_by_type: "true",
      });
    } catch {
      // Manual activities and some swims have no streams (Strava returns 404)
      return null;
    }
  });
}

// Fetch activities from the past N weeks. Cached persistently per athlete in the
// database: the dashboard renders from this on every browser refresh, so we
// deliberately do NOT auto-expire it. A new Strava fetch happens only when (a)
// there is no cached row yet (first load, or right after a fresh OAuth login —
// see the auth callback, which invalidates this athlete's cache), or (b) the
// user presses the dashboard "Sync" button (refreshDashboard ->
// invalidateAthleteCache). This keeps plain refreshes off Strava's rate limit.
export async function getRecentActivities(
  identity: StravaIdentity,
  weeks = 12,
): Promise<StravaActivity[]> {
  return (await recentActivitiesEntry(identity, weeks)).data;
}

/** As getRecentActivities, but also reports when the cached row was synced. */
async function recentActivitiesEntry(
  { userId, stravaAthleteId: athleteId }: StravaIdentity,
  weeks: number,
): Promise<CacheEntry<StravaActivity[]>> {
  return dbCachedEntry(athleteId, `activities:${weeks}`, () =>
    fetchActivitiesLive(userId, weeks),
  );
}

/** Every page of the athlete's last N weeks, straight from Strava. Throws if
 *  Strava is unreachable — callers decide whether that is fatal. */
async function fetchActivitiesLive(
  userId: string,
  weeks: number,
): Promise<StravaActivity[]> {
  const after = Math.floor(Date.now() / 1000) - weeks * 7 * 24 * 3600;
  const all: StravaActivity[] = [];
  let page = 1;

  while (true) {
    const batch = await getActivities(userId, page, 100, after);
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  // Strava returns oldest-first when filtering with `after`; normalize to newest-first
  return all.sort(
    (a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime()
  );
}

/**
 * Refetch this athlete's activities and replace the cached row — fetch first,
 * write second, and never delete in between.
 *
 * The ordering is the whole point. The previous row is the only copy of this
 * athlete's history we hold, so dropping it before the network call means a
 * Strava outage leaves us with nothing to render and every subsequent reload
 * re-attempts the same failing fetch. Fetching first makes an outage a no-op:
 * the throw propagates, the old row is untouched, and the caller keeps serving
 * it. Throws when Strava is unreachable.
 */
export async function refreshActivitiesCache(
  identity: StravaIdentity,
  weeks: number,
): Promise<CacheEntry<StravaActivity[]>> {
  const fresh = await fetchActivitiesLive(identity.userId, weeks);
  // Only now is it safe to drop the athlete's other derived rows (stats,
  // zones): we already hold the replacement for the row that matters.
  await invalidateAthleteCache(identity.stravaAthleteId);
  return writeCacheEntry(
    identity.stravaAthleteId,
    `activities:${weeks}`,
    fresh,
  );
}
