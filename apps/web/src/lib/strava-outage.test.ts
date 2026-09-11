import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StravaActivity } from "@trihards/core";
import type { StravaIdentity } from "./strava";

// Reproduces the 2026-09-11 outage: Strava returned 503 on /athlete/activities,
// the daily sync had already deleted the cached row, and the dashboard render
// threw with nothing left to fall back on. Each test below pins one half of the
// fix — the cache must survive an upstream failure, and transient 5xx must be
// retried rather than surfaced.

process.env.TURSO_DATABASE_URL = ":memory:";

vi.mock("./strava-tokens", () => ({
  getValidAccessToken: async (userId: string) => `token-${userId}`,
}));

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../../packages/db/migrations", import.meta.url),
);

const ATHLETE = 4242;
const IDENTITY: StravaIdentity = { userId: "user-1", stravaAthleteId: ATHLETE };
const WEEKS = 52;
const CACHE_KEY = `activities:${WEEKS}`;

// One UTC-offset-zero activity, so the athlete's "local day" is plain UTC and
// the staleness check is decided purely by the fetchedAt stamp we set.
const CACHED: StravaActivity[] = [
  {
    id: 1,
    name: "Yesterday's run",
    sport_type: "Run",
    type: "Run",
    start_date: "2026-09-10T08:00:00Z",
    start_date_local: "2026-09-10T08:00:00Z",
    distance: 10000,
    moving_time: 3000,
  } as unknown as StravaActivity,
];

let db: Awaited<ReturnType<typeof import("@trihards/db").getDb>>;
let stravaCache: typeof import("@trihards/db").stravaCache;

beforeAll(async () => {
  const dbMod = await import("@trihards/db");
  const { sql } = await import("drizzle-orm");
  db = dbMod.getDb();
  stravaCache = dbMod.stravaCache;

  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of text.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
      await db.run(sql.raw(stmt));
    }
  }
});

/** Seed the durable cache with a row synced `daysAgo` days back. */
async function seedCache(daysAgo: number) {
  const { eq } = await import("drizzle-orm");
  await db.delete(stravaCache).where(eq(stravaCache.athleteId, ATHLETE));
  await db.insert(stravaCache).values({
    athleteId: ATHLETE,
    cacheKey: CACHE_KEY,
    data: JSON.stringify(CACHED),
    fetchedAt: Math.floor(Date.now() / 1000) - daysAgo * 24 * 3600,
  });
}

async function cachedRowCount(): Promise<number> {
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ key: stravaCache.cacheKey })
    .from(stravaCache)
    .where(eq(stravaCache.athleteId, ATHLETE));
  return rows.length;
}

function stravaDown(status = 503) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL) => {
    calls.push(url.toString());
    // Strava serves a branded HTML page on 5xx, not JSON.
    return new Response("<!DOCTYPE html><html><title>Strava is temporarily unavailable</title>" + "x".repeat(8000) + "</html>", {
      status,
      headers: { "Content-Type": "text/html" },
    });
  });
  return calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("daily sync when Strava is down", () => {
  it("serves the cached activities instead of throwing", async () => {
    await seedCache(2); // stale: last synced two days ago
    stravaDown();
    const { getActivitiesWithDailySync } = await import("./strava");

    const result = await getActivitiesWithDailySync(IDENTITY, WEEKS);

    expect(result.activities).toHaveLength(1);
    expect(result.activities[0].name).toBe("Yesterday's run");
    expect(result.stale).toBe(true);
  });

  it("leaves the cached row intact so the next reload still works", async () => {
    await seedCache(2);
    stravaDown();
    const { getActivitiesWithDailySync } = await import("./strava");

    await getActivitiesWithDailySync(IDENTITY, WEEKS);

    // The original bug: invalidate ran before the fetch, so a 503 left zero
    // rows and every subsequent render re-attempted the same failing call.
    expect(await cachedRowCount()).toBeGreaterThan(0);

    const second = await getActivitiesWithDailySync(IDENTITY, WEEKS);
    expect(second.activities).toHaveLength(1);
    expect(second.stale).toBe(true);
  });

  it("reports fresh data as not stale when Strava answers", async () => {
    await seedCache(2);
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { getActivitiesWithDailySync } = await import("./strava");

    const result = await getActivitiesWithDailySync(IDENTITY, WEEKS);
    expect(result.stale).toBe(false);
  });

  it("does not call Strava at all when the cache is from today", async () => {
    await seedCache(0);
    const calls = stravaDown();
    const { getActivitiesWithDailySync } = await import("./strava");

    const result = await getActivitiesWithDailySync(IDENTITY, WEEKS);

    expect(calls).toHaveLength(0);
    expect(result.stale).toBe(false);
  });
});

describe("stravaFetch retries", () => {
  it("retries a 5xx and succeeds on the second attempt", async () => {
    await seedCache(2);
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      if (n === 1) return new Response("<html>down</html>", { status: 503 });
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const { getActivitiesWithDailySync } = await import("./strava");

    const result = await getActivitiesWithDailySync(IDENTITY, WEEKS);

    expect(n).toBe(2);
    expect(result.stale).toBe(false);
  });

  it("gives up after the retry budget and falls back to cache", async () => {
    await seedCache(2);
    const calls = stravaDown();
    const { getActivitiesWithDailySync } = await import("./strava");

    const result = await getActivitiesWithDailySync(IDENTITY, WEEKS);

    expect(calls).toHaveLength(3); // initial + 2 retries
    expect(result.stale).toBe(true);
  });

  it("does not retry a 429 — the rate-limit window is far longer than a backoff", async () => {
    await seedCache(2);
    const calls = stravaDown(429);
    const { getActivitiesWithDailySync } = await import("./strava");

    const result = await getActivitiesWithDailySync(IDENTITY, WEEKS);

    expect(calls).toHaveLength(1);
    expect(result.stale).toBe(true);
  });

  it("does not retry a 401 — a bad token will not fix itself", async () => {
    await seedCache(2);
    const calls = stravaDown(401);
    const { getActivitiesWithDailySync } = await import("./strava");

    await getActivitiesWithDailySync(IDENTITY, WEEKS);

    expect(calls).toHaveLength(1);
  });

  it("truncates the upstream body instead of carrying 8KB of HTML", async () => {
    const { eq } = await import("drizzle-orm");
    await db.delete(stravaCache).where(eq(stravaCache.athleteId, ATHLETE));
    stravaDown(); // 8KB+ of Strava's outage page
    const { getRecentActivities } = await import("./strava");

    // With no cached row there is nothing to fall back to, so the error
    // surfaces — which is the only way to read the message the logger records.
    const err = await getRecentActivities(IDENTITY, WEEKS).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    // 300 chars of body + the status prefix and the "(N chars)" suffix.
    expect((err as Error).message.length).toBeLessThan(400);
    expect((err as Error).message).toContain("Strava API error 503");
    expect((err as Error).message).toContain("8076 chars");
  });
});
