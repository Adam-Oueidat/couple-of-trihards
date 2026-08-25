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
import { getSession } from "./session";
import { refreshStravaTokens, tokensNeedRefresh } from "./strava-auth";
import { localDateOf, resolveToday } from "./coach-dates";

const log = createLogger("strava");

const STRAVA_API = "https://www.strava.com/api/v3";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";

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
async function dbCached<T>(
  athleteId: number,
  cacheKey: string,
  fn: () => Promise<T>
): Promise<T> {
  const db = getDb();
  const [hit] = await db
    .select({ data: stravaCache.data })
    .from(stravaCache)
    .where(and(eq(stravaCache.athleteId, athleteId), eq(stravaCache.cacheKey, cacheKey)));
  if (hit) return JSON.parse(hit.data) as T;

  const data = await fn();
  const now = Math.floor(Date.now() / 1000);
  const serialized = JSON.stringify(data);
  await db
    .insert(stravaCache)
    .values({ athleteId, cacheKey, data: serialized, fetchedAt: now })
    .onConflictDoUpdate({
      target: [stravaCache.athleteId, stravaCache.cacheKey],
      set: { data: serialized, fetchedAt: now },
    });
  return data;
}

// Unix-seconds timestamp of when an athlete's cached row was last fetched from
// Strava, or null if there is no cached row yet. Drives the dashboard's "Synced
// …" label so it reflects the real last sync (login / Sync button) and stays put
// across plain browser refreshes, which re-serve the cache without refetching.
export async function getCacheFetchedAt(
  athleteId: number,
  cacheKey: string
): Promise<number | null> {
  const db = getDb();
  const [hit] = await db
    .select({ fetchedAt: stravaCache.fetchedAt })
    .from(stravaCache)
    .where(and(eq(stravaCache.athleteId, athleteId), eq(stravaCache.cacheKey, cacheKey)));
  return hit?.fetchedAt ?? null;
}

async function requireAthleteId(): Promise<number> {
  const session = await getSession();
  const id = session.tokens?.athlete_id;
  if (!id) throw new Error("Not authenticated");
  return id;
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
  athleteId: number,
  weeks = 12,
): Promise<{ activities: StravaActivity[]; fetchedAt: number | null }> {
  const key = `activities:${weeks}`;
  let activities = await getRecentActivities(weeks);
  let fetchedAt = await getCacheFetchedAt(athleteId, key);

  // Server render has no client-sent date, so "today" is derived from the
  // athlete's activity-based UTC offset (same as the rest of the dashboard).
  const today = resolveToday(undefined, activities);
  if (fetchedAt != null && localDateOf(fetchedAt, activities) !== today) {
    await invalidateAthleteCache(athleteId);
    activities = await getRecentActivities(weeks);
    fetchedAt = await getCacheFetchedAt(athleteId, key);
  }

  return { activities, fetchedAt };
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

// Returns a valid access token, refreshing if needed.
// Token refresh is normally handled by src/proxy.ts (Server Components
// cannot write cookies); this is a fallback for paths the proxy misses.
export async function getValidAccessToken(): Promise<string> {
  const session = await getSession();
  if (!session.tokens) throw new Error("Not authenticated");

  if (tokensNeedRefresh(session.tokens.expires_at)) {
    log.info("refreshing Strava token", {
      athleteId: session.tokens.athlete_id,
      expiresAt: session.tokens.expires_at,
    });
    const refreshed = await refreshStravaTokens(session.tokens.refresh_token);
    session.tokens = { ...session.tokens, ...refreshed };
    try {
      await session.save();
    } catch {
      // Called during a Server Component render, where cookies can't be
      // written. The refreshed token is still used for this request; the
      // proxy will persist new tokens on the next request.
      log.debug("token refresh saved in-memory only (server component)");
    }
    return refreshed.access_token;
  }

  return session.tokens.access_token;
}

async function stravaFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  const token = await getValidAccessToken();
  const url = new URL(`${STRAVA_API}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    const err = await res.text();
    log.error("strava API error", { path, status: res.status, body: err });
    throw new Error(`Strava API error ${res.status}: ${err}`);
  }

  log.debug("strava fetch ok", { path, status: res.status });
  return res.json();
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
  page = 1,
  perPage = 50,
  after?: number
): Promise<StravaActivity[]> {
  const params: Record<string, string> = {
    page: String(page),
    per_page: String(perPage),
  };
  if (after) params.after = String(after);
  const raw = await stravaFetch<StravaActivity[]>("/athlete/activities", params);
  return raw.map(toStravaActivity);
}

export async function getActivityDetail(id: number): Promise<DetailedActivity> {
  // Keyed by athlete as well as activity. Strava would reject one athlete's
  // token for another athlete's private activity, but a cache hit never reaches
  // Strava — an unkeyed `detail:${id}` serves athlete A's private payload to
  // athlete B for the full TTL. Callers must still authorize the id itself
  // (see lib/activity-access.ts); this only stops the cache from leaking.
  const athleteId = await requireAthleteId();
  return cached(`detail:${athleteId}:${id}`, 60 * 60_000, async () => {
    return stravaFetch<DetailedActivity>(`/activities/${id}`);
  });
}

// Athlete detail/zones/stats back the dashboard's Fitness Profile, which is
// re-fetched on every dashboard load. Cache persistently (sync only on login or
// the "Sync" button) for the same reason as getRecentActivities — a plain
// refresh must not hit Strava. invalidateAthleteCache drops these rows.
export async function getAthleteDetail(): Promise<AthleteDetail> {
  const id = await requireAthleteId();
  return dbCached(id, "athlete-detail", () => stravaFetch<AthleteDetail>("/athlete"));
}

export async function getAthleteZones(): Promise<AthleteZones> {
  const id = await requireAthleteId();
  return dbCached(id, "athlete-zones", () => stravaFetch<AthleteZones>("/athlete/zones"));
}

export async function getAthleteStats(): Promise<AthleteStats> {
  const id = await requireAthleteId();
  return dbCached(id, "athlete-stats", () =>
    stravaFetch<AthleteStats>(`/athletes/${id}/stats`)
  );
}

export async function getActivityStreams(id: number): Promise<StreamSet | null> {
  // Athlete-scoped for the same reason as getActivityDetail above.
  const athleteId = await requireAthleteId();
  return cached(`streams:${athleteId}:${id}`, 60 * 60_000, async () => {
    try {
      return await stravaFetch<StreamSet>(`/activities/${id}/streams`, {
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
export async function getRecentActivities(weeks = 12): Promise<StravaActivity[]> {
  const athleteId = await requireAthleteId();

  return dbCached(athleteId, `activities:${weeks}`, async () => {
    const after = Math.floor(Date.now() / 1000) - weeks * 7 * 24 * 3600;
    const all: StravaActivity[] = [];
    let page = 1;

    while (true) {
      const batch = await getActivities(page, 100, after);
      all.push(...batch);
      if (batch.length < 100) break;
      page++;
    }

    // Strava returns oldest-first when filtering with `after`; normalize to newest-first
    return all.sort(
      (a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime()
    );
  });
}
