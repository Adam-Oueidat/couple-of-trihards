import {
  AthleteDetail,
  AthleteStats,
  AthleteZones,
  DetailedActivity,
  StravaActivity,
  StravaAthlete,
  StravaTokens,
  StreamSet,
  createLogger,
} from "@trihards/core";
import { getSession } from "./session";
import { refreshStravaTokens, tokensNeedRefresh } from "./strava-auth";

const log = createLogger("strava");

const STRAVA_API = "https://www.strava.com/api/v3";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";

// In-memory TTL cache to avoid hammering Strava's rate limits
// (100 reads / 15 min). Cleared on server restart, which is fine.
const apiCache = new Map<string, { data: unknown; expires: number }>();

// Sentinel TTL marking an entry as "persistent until explicitly invalidated".
// Stored as Infinity in `expires`, so it never lapses on a timer — a plain
// browser refresh re-serves the cached value instead of spending Strava
// rate-limit budget. Persistent entries are only dropped by
// invalidateAthleteCache (the dashboard "Sync" button or a fresh OAuth login)
// or a server restart. This is what enforces the sync-only-on-login-or-button
// behavior on the dashboard render path (see getRecentActivities below).
const PERSISTENT = Number.POSITIVE_INFINITY;

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = apiCache.get(key);
  // PERSISTENT entries store Infinity as `expires`, so this keeps them
  // indefinitely; only invalidation evicts them.
  if (hit && hit.expires > Date.now()) return hit.data as T;
  const data = await fn();
  apiCache.set(key, {
    data,
    expires: ttlMs === PERSISTENT ? PERSISTENT : Date.now() + ttlMs,
  });
  return data;
}

// Drops every cached Strava response for one athlete so the next render
// refetches live data. This is the ONLY way the dashboard's data refreshes:
// it's called by the manual "Sync" action (refreshDashboard) and on a fresh
// OAuth login (auth callback). Those entries are otherwise persistent, so a
// plain browser refresh re-serves the cache and stays within Strava's rate
// limits (100 reads / 15 min).
export function invalidateAthleteCache(athleteId: number | string): void {
  // `activities:` keys carry a `:weeks` suffix, so match by prefix. The athlete
  // detail/zones/stats keys end at the id, so match exactly — a prefix match
  // would also evict another athlete whose id starts with this one (e.g. 12
  // vs 123), since apiCache is shared across all athletes.
  const activitiesPrefix = `activities:${athleteId}:`;
  const exactKeys = new Set([
    `athlete-detail:${athleteId}`,
    `athlete-zones:${athleteId}`,
    `athlete-stats:${athleteId}`,
  ]);
  for (const key of apiCache.keys()) {
    if (key.startsWith(activitiesPrefix) || exactKeys.has(key)) apiCache.delete(key);
  }
}

export function getStravaAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID!,
    redirect_uri: process.env.STRAVA_REDIRECT_URI!,
    response_type: "code",
    approval_prompt: "auto",
    // profile:read_all is required for /athlete/zones (HR zones) and to
    // receive weight/FTP fields on /athlete.
    scope: "read,activity:read_all,profile:read_all",
  });
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

export async function getAthlete(): Promise<StravaAthlete> {
  return stravaFetch<StravaAthlete>("/athlete");
}

export async function getActivities(
  page = 1,
  perPage = 50,
  after?: number
): Promise<StravaActivity[]> {
  const params: Record<string, string> = {
    page: String(page),
    per_page: String(perPage),
  };
  if (after) params.after = String(after);
  return stravaFetch<StravaActivity[]>("/athlete/activities", params);
}

export async function getActivityDetail(id: number): Promise<DetailedActivity> {
  return cached(`detail:${id}`, 60 * 60_000, async () => {
    return stravaFetch<DetailedActivity>(`/activities/${id}`);
  });
}

// Athlete detail/zones/stats back the dashboard's Fitness Profile, which is
// re-fetched on every dashboard load. Cache persistently (sync only on login or
// the "Sync" button) for the same reason as getRecentActivities — a plain
// refresh must not hit Strava. invalidateAthleteCache evicts these keys.
export async function getAthleteDetail(): Promise<AthleteDetail> {
  const session = await getSession();
  const id = session.tokens?.athlete_id ?? "anon";
  return cached(`athlete-detail:${id}`, PERSISTENT, () =>
    stravaFetch<AthleteDetail>("/athlete")
  );
}

export async function getAthleteZones(): Promise<AthleteZones> {
  const session = await getSession();
  const id = session.tokens?.athlete_id ?? "anon";
  return cached(`athlete-zones:${id}`, PERSISTENT, () =>
    stravaFetch<AthleteZones>("/athlete/zones")
  );
}

export async function getAthleteStats(): Promise<AthleteStats> {
  const session = await getSession();
  const id = session.tokens?.athlete_id;
  if (!id) throw new Error("Not authenticated");
  return cached(`athlete-stats:${id}`, PERSISTENT, () =>
    stravaFetch<AthleteStats>(`/athletes/${id}/stats`)
  );
}

export async function getActivityStreams(id: number): Promise<StreamSet | null> {
  return cached(`streams:${id}`, 60 * 60_000, async () => {
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

// Fetch activities from the past N weeks. Cached persistently per athlete:
// the dashboard renders from this on every browser refresh, so we deliberately
// do NOT auto-expire it. A new Strava fetch happens only when (a) there is no
// cached entry yet (first load, server restart, or right after a fresh OAuth
// login — see the auth callback, which invalidates this athlete's cache), or
// (b) the user presses the dashboard "Sync" button (refreshDashboard ->
// invalidateAthleteCache). This keeps plain refreshes off Strava's rate limit.
export async function getRecentActivities(weeks = 12): Promise<StravaActivity[]> {
  const session = await getSession();
  const athleteId = session.tokens?.athlete_id ?? "unknown";

  return cached(`activities:${athleteId}:${weeks}`, PERSISTENT, async () => {
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
