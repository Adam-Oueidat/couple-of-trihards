import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { DetailedActivity, StravaActivity } from "@trihards/core";

// getDb() reads this lazily on first call and caches the connection, so setting
// it before any test body runs is enough to keep everything in memory.
process.env.TURSO_DATABASE_URL = ":memory:";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../../packages/db/migrations", import.meta.url),
);

let userId: string;
let getPersonalBests: typeof import("./personal-bests").getPersonalBests;
let updatePersonalBests: typeof import("./personal-bests").updatePersonalBests;
let syncYtdPersonalBests: typeof import("./personal-bests").syncYtdPersonalBests;
let pendingRuns: typeof import("./personal-bests").pendingRuns;

beforeAll(async () => {
  const { getDb, users } = await import("@trihards/db");
  const { sql } = await import("drizzle-orm");
  const db = getDb();

  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of text.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
      await db.run(sql.raw(stmt));
    }
  }

  const [u] = await db.insert(users).values({ stravaAthleteId: 1 }).returning({ id: users.id });
  userId = u.id;

  const mod = await import("./personal-bests");
  getPersonalBests = mod.getPersonalBests;
  updatePersonalBests = mod.updatePersonalBests;
  syncYtdPersonalBests = mod.syncYtdPersonalBests;
  pendingRuns = mod.pendingRuns;
});

const TODAY = "2026-08-21";

function run(id: number, date: string, sport = "Run"): StravaActivity {
  return {
    id,
    name: `Run ${id}`,
    sport_type: sport,
    start_date: `${date}T09:00:00Z`,
    start_date_local: `${date}T09:00:00Z`,
  } as StravaActivity;
}

function detail(id: number, date: string, efforts: [string, number][]): DetailedActivity {
  return {
    ...run(id, date),
    best_efforts: efforts.map(([name, moving_time]) => ({
      name,
      distance: 5000,
      moving_time,
    })),
  } as DetailedActivity;
}

describe("pendingRuns", () => {
  it("keeps only run-type activities past the cursor, oldest first", () => {
    const cursor = Date.parse("2026-03-01T00:00:00Z") / 1000;
    const acts = [
      run(1, "2026-05-01"),
      run(2, "2026-02-01"), // before the cursor
      run(3, "2026-04-01", "Ride"), // not a run
      run(4, "2026-04-02", "TrailRun"),
      run(5, "2026-04-03", "Swim"),
    ];
    expect(pendingRuns(acts, cursor).map((a) => a.id)).toEqual([4, 1]);
  });
});

describe("year-to-date scoping", () => {
  it("ignores an activity from before the current year", async () => {
    await updatePersonalBests(userId, detail(100, "2025-11-04", [["5K", 1100]]), TODAY);
    expect(await getPersonalBests(userId, TODAY)).toEqual([]);
  });

  it("lets this year's slower time replace a row carried over from last season", async () => {
    // What the table looks like after a year rollover: the row was written in
    // 2025, when it was current, and is still sitting on the (user, effort) key.
    const { getDb, personalBests } = await import("@trihards/db");
    await getDb().insert(personalBests).values({
      userId,
      effortName: "5K",
      distance: 5000,
      movingTime: 1100,
      activityId: "100",
      activityName: "Last November",
      activityDate: "2025-11-04",
    });
    expect(await getPersonalBests(userId, TODAY)).toEqual([]);

    // A slower 2026 effort must still take over — YTD means "best this year",
    // not "best ever".
    await updatePersonalBests(userId, detail(101, "2026-03-04", [["5K", 1300]]), TODAY);
    const bests = await getPersonalBests(userId, TODAY);
    expect(bests).toHaveLength(1);
    expect(bests[0]).toMatchObject({ name: "5K", moving_time: 1300, activityDate: "2026-03-04" });
  });

  it("keeps the faster of two efforts within the same year", async () => {
    await updatePersonalBests(userId, detail(102, "2026-04-01", [["10K", 2500]]), TODAY);
    await updatePersonalBests(userId, detail(103, "2026-05-01", [["10K", 2600]]), TODAY);
    const tenK = (await getPersonalBests(userId, TODAY)).find((p) => p.name === "10K");
    expect(tenK).toMatchObject({ moving_time: 2500, activityDate: "2026-04-01" });
  });
});

describe("syncYtdPersonalBests", () => {
  it("walks the year in batches and resumes where it stopped", async () => {
    const { getDb, users } = await import("@trihards/db");
    const db = getDb();
    const [u] = await db.insert(users).values({ stravaAthleteId: 2 }).returning({ id: users.id });

    const activities = [
      run(201, "2026-02-10"),
      run(202, "2026-03-10"),
      run(203, "2026-04-10"),
      run(204, "2026-04-11", "Ride"), // never fetched
      run(205, "2025-12-20"), // last year, out of window
    ];
    const times: Record<number, number> = { 201: 1500, 202: 1400, 203: 1450 };
    const fetched: number[] = [];
    const fetchDetail = async (id: number) => {
      fetched.push(id);
      return detail(id, activities.find((a) => a.id === id)!.start_date.slice(0, 10), [
        ["1 mile", times[id]],
      ]);
    };

    const first = await syncYtdPersonalBests(u.id, activities, fetchDetail, 2);
    expect(first).toMatchObject({ processed: 2, remaining: 1, done: false, rateLimited: false });

    const second = await syncYtdPersonalBests(u.id, activities, fetchDetail, 2);
    expect(second).toMatchObject({ processed: 1, remaining: 0, done: true });

    // Oldest-first, runs only, and the 2025 activity never fetched.
    expect(fetched).toEqual([201, 202, 203]);

    const bests = await getPersonalBests(u.id, TODAY);
    expect(bests).toHaveLength(1);
    expect(bests[0]).toMatchObject({ name: "1 mile", moving_time: 1400 });

    // A third pass has nothing left to do and spends no API calls.
    const third = await syncYtdPersonalBests(u.id, activities, fetchDetail, 2);
    expect(third).toMatchObject({ processed: 0, done: true });
    expect(fetched).toHaveLength(3);
  });

  it("stops on a Strava rate limit without losing the work already done", async () => {
    const { getDb, users } = await import("@trihards/db");
    const db = getDb();
    const [u] = await db.insert(users).values({ stravaAthleteId: 3 }).returning({ id: users.id });

    const activities = [run(301, "2026-02-10"), run(302, "2026-03-10"), run(303, "2026-04-10")];
    let calls = 0;
    const fetchDetail = async (id: number) => {
      calls++;
      if (calls > 1) throw new Error("Strava API error 429: Too Many Requests");
      return detail(id, "2026-02-10", [["400m", 70]]);
    };

    const result = await syncYtdPersonalBests(u.id, activities, fetchDetail, 10);
    expect(result).toMatchObject({ processed: 1, rateLimited: true, done: false });
    expect(await getPersonalBests(u.id, TODAY)).toHaveLength(1);

    // The cursor advanced past the one that succeeded, so a retry starts at 302.
    const retried: number[] = [];
    await syncYtdPersonalBests(
      u.id,
      activities,
      async (id) => {
        retried.push(id);
        return detail(id, "2026-03-10", [["400m", 68]]);
      },
      10,
    );
    expect(retried).toEqual([302, 303]);
  });
});
