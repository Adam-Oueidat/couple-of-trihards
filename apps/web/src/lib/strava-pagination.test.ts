import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StravaIdentity } from "./strava";

// The dashboard's cold sync used to walk Strava's pages one at a time, putting
// 4x the per-page latency on the critical path. These pin the concurrent
// replacement: same activities out, but the pages overlap in time.

process.env.TURSO_DATABASE_URL = ":memory:";

vi.mock("./strava-tokens", () => ({
  getValidAccessToken: async (userId: string) => `token-${userId}`,
}));

const IDENTITY: StravaIdentity = { userId: "u1", stravaAthleteId: 7 };
const PAGE_SIZE = 100;
const LATENCY_MS = 60;

function activity(id: number): Record<string, unknown> {
  return {
    id,
    name: `Activity ${id}`,
    sport_type: "Run",
    type: "Run",
    // Descending dates so id order and time order agree.
    start_date: new Date(Date.UTC(2026, 0, 1) + id * 3600_000).toISOString(),
    start_date_local: new Date(Date.UTC(2026, 0, 1) + id * 3600_000).toISOString(),
    distance: 1000,
    moving_time: 300,
  };
}

/** Serve `total` activities, 100 per page, recording when each call starts. */
function stravaWith(total: number) {
  const starts: number[] = [];
  const t0 = Date.now();
  vi.stubGlobal("fetch", async (url: string | URL) => {
    starts.push(Date.now() - t0);
    const page = Number(new URL(url.toString()).searchParams.get("page") ?? "1");
    await new Promise((r) => setTimeout(r, LATENCY_MS));
    const from = (page - 1) * PAGE_SIZE;
    const slice = from >= total ? [] : Array.from(
      { length: Math.min(PAGE_SIZE, total - from) },
      (_, i) => activity(from + i),
    );
    return new Response(JSON.stringify(slice), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return starts;
}

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../../packages/db/migrations", import.meta.url),
);

let db: ReturnType<typeof import("@trihards/db").getDb>;
let stravaCache: typeof import("@trihards/db").stravaCache;

beforeAll(async () => {
  const dbMod = await import("@trihards/db");
  const { sql } = await import("drizzle-orm");
  db = dbMod.getDb();
  stravaCache = dbMod.stravaCache;
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of text.split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean)) {
      await db.run(sql.raw(stmt));
    }
  }
});

// The durable cache would otherwise answer every test after the first, so the
// row is cleared rather than the module reset (resetModules would hand us a
// fresh, unmigrated in-memory database).
beforeEach(async () => {
  vi.unstubAllGlobals();
  const { eq } = await import("drizzle-orm");
  await db.delete(stravaCache).where(eq(stravaCache.athleteId, IDENTITY.stravaAthleteId));
});

describe("activity pagination", () => {
  it("fetches the window concurrently, not one page after another", async () => {
    const starts = stravaWith(350);
    const { getRecentActivities } = await import("./strava");

    const began = Date.now();
    const activities = await getRecentActivities(IDENTITY, 52);
    const elapsed = Date.now() - began;

    expect(activities).toHaveLength(350);

    // The four pages must overlap: all start before the first one returns.
    expect(starts.slice(0, 4).every((s) => s < LATENCY_MS)).toBe(true);

    // Sequential would be >= 4 x LATENCY. Concurrent is ~1 x (plus overhead).
    expect(elapsed).toBeLessThan(LATENCY_MS * 3);
  });

  it("returns every activity exactly once", async () => {
    stravaWith(350);
    const { getRecentActivities } = await import("./strava");

    const activities = await getRecentActivities(IDENTITY, 52);
    const ids = activities.map((a) => a.id);

    expect(new Set(ids).size).toBe(350);
  });

  it("keeps going past the first window when there are more pages", async () => {
    stravaWith(520); // 6 pages — needs a second window
    const { getRecentActivities } = await import("./strava");

    const activities = await getRecentActivities(IDENTITY, 52);
    expect(activities).toHaveLength(520);
  });

  it("handles an exact multiple of the page size", async () => {
    // 400 = exactly 4 full pages. The end lands on a window boundary, so the
    // loop must issue one more window and see it come back empty.
    stravaWith(400);
    const { getRecentActivities } = await import("./strava");

    const activities = await getRecentActivities(IDENTITY, 52);
    expect(activities).toHaveLength(400);
  });

  it("handles an athlete with no activities", async () => {
    stravaWith(0);
    const { getRecentActivities } = await import("./strava");

    expect(await getRecentActivities(IDENTITY, 52)).toEqual([]);
  });

  it("de-duplicates a row that lands on two pages mid-upload", async () => {
    // Simulates an upload shifting pagination: page 2 repeats page 1's last row.
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const page = Number(new URL(url.toString()).searchParams.get("page") ?? "1");
      if (page === 1) return json(Array.from({ length: 100 }, (_, i) => activity(i)));
      if (page === 2) return json([activity(99), ...Array.from({ length: 20 }, (_, i) => activity(100 + i))]);
      return json([]);
    });
    const { getRecentActivities } = await import("./strava");

    const activities = await getRecentActivities(IDENTITY, 52);
    const ids = activities.map((a) => a.id);

    expect(ids.length).toBe(new Set(ids).size);
    expect(activities).toHaveLength(120);
  });

  it("returns newest first", async () => {
    stravaWith(150);
    const { getRecentActivities } = await import("./strava");

    const activities = await getRecentActivities(IDENTITY, 52);
    const times = activities.map((a) => new Date(a.start_date).getTime());

    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
