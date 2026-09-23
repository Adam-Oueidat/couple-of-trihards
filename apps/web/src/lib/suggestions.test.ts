import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type {
  PlanOverrideMap,
  SuggestedSession,
  SuggestInput,
  TrainingPlan,
} from "@trihards/core";

// getDb() reads this lazily on first call and caches the connection, so setting
// it before any test body runs is enough to keep everything in memory.
process.env.TURSO_DATABASE_URL = ":memory:";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../../packages/db/migrations", import.meta.url),
);

type Mod = typeof import("./suggestions");
type Workouts = typeof import("./workouts");
type Overrides = typeof import("./plan-overrides");

let mod: Mod;
let workouts: Workouts;
let overrides: Overrides;
let core: typeof import("@trihards/core");
let nextAthlete = 7000;

beforeAll(async () => {
  const { getDb } = await import("@trihards/db");
  const { sql } = await import("drizzle-orm");
  const db = getDb();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of text.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
      await db.run(sql.raw(stmt));
    }
  }
  mod = await import("./suggestions");
  workouts = await import("./workouts");
  overrides = await import("./plan-overrides");
  core = await import("@trihards/core");
});

async function newUser(): Promise<string> {
  const { getDb, users } = await import("@trihards/db");
  const [u] = await getDb()
    .insert(users)
    .values({ stravaAthleteId: nextAthlete++ })
    .returning({ id: users.id });
  return u.id;
}

const TODAY = "2026-09-22"; // Tuesday
const TOMORROW = "2026-09-23";

const INTERVALS: SuggestedSession = {
  name: "6 x 400 m",
  discipline: "run",
  kind: "intervals",
  durationMin: 55,
  steps: [{ label: "6 x 400 m", detail: "5 km race effort" }],
  blocks: [],
  threshold: { kind: "effort" },
  summary: "6 x 400 m",
};

function longRunTomorrow(): TrainingPlan {
  return core.buildTrainingPlan({
    name: "Block",
    source: "runna",
    discipline: "run",
    startDate: "2026-09-01",
    raceDate: "2026-11-01",
    raceName: "Race",
    sessions: [{ date: TOMORROW, name: "Progressive Long Run", type: "long", km: 17 }],
  });
}

async function input(userId: string, plan: TrainingPlan | null): Promise<SuggestInput & { date: string }> {
  return {
    activities: [],
    trainingLoad: [],
    plan,
    overrides: await overrides.getOverrides(userId),
    customWorkouts: await workouts.getWorkouts(userId),
    zones: core.resolveZoneModel(null, null),
    today: TODAY,
    date: TODAY,
  };
}

describe("accepting a hard session with clashes", () => {
  it("adds the pick and moves tomorrow's session where it was asked to", async () => {
    const userId = await newUser();
    const plan = longRunTomorrow();
    const id = plan.sessions[0].id;

    const result = await mod.acceptSuggestion(userId, await input(userId, plan), INTERVALS, {
      [id]: "move",
    });

    const saved: PlanOverrideMap = await overrides.getOverrides(userId);
    expect(saved[id].newDate).toBe("2026-09-24");
    expect(saved[id].reason).toContain("6 x 400 m");
    expect((await workouts.getWorkouts(userId)).map((w) => [w.date, w.name])).toEqual([
      [TODAY, "6 x 400 m"],
    ]);
    expect(result.changes).toEqual([
      "Added 6 x 400 m on Tuesday.",
      "Moved Progressive Long Run to Thursday.",
    ]);
  });

  it("keeps an athlete's earlier edits when it skips a session", async () => {
    const userId = await newUser();
    const plan = longRunTomorrow();
    const id = plan.sessions[0].id;
    await overrides.setOverride(userId, {
      sessionId: id,
      originalDate: TOMORROW,
      newDate: TOMORROW,
      name: "Club long run",
    });

    await mod.acceptSuggestion(userId, await input(userId, plan), INTERVALS, { [id]: "ease" });

    const saved = (await overrides.getOverrides(userId))[id];
    expect(saved.skipped).toBe(true);
    expect(saved.name).toBe("Club long run");
    const added = (await workouts.getWorkouts(userId)).map((w) => [w.date, w.name]);
    expect(added).toContainEqual([TOMORROW, "8 km easy run"]);
  });

  it("writes nothing when a clash has no answer from the athlete", async () => {
    // A clash that appeared after the athlete was asked must not be quietly
    // "kept" — they never saw it.
    const userId = await newUser();
    await expect(
      mod.acceptSuggestion(userId, await input(userId, longRunTomorrow()), INTERVALS, {}),
    ).rejects.toBeInstanceOf(mod.StaleConflictError);
    expect(await workouts.getWorkouts(userId)).toEqual([]);
    expect(await overrides.getOverrides(userId)).toEqual({});
  });

  it("rejects a choice that is not on offer", async () => {
    const userId = await newUser();
    const plan = longRunTomorrow();
    await expect(
      mod.acceptSuggestion(userId, await input(userId, plan), INTERVALS, {
        [plan.sessions[0].id]: "replace", // only offered for the same day
      }),
    ).rejects.toBeInstanceOf(mod.StaleConflictError);
  });

  it("moves the athlete's own calendar workout too", async () => {
    const userId = await newUser();
    const w = await workouts.addWorkout(
      userId,
      { date: TOMORROW, discipline: "ride", name: "4 x 8 min threshold", durationMin: 60 },
      "athlete",
    );

    await mod.acceptSuggestion(userId, await input(userId, null), INTERVALS, { [w.id]: "move" });

    const rows = await workouts.getWorkouts(userId);
    expect(rows.find((r) => r.id === w.id)?.date).toBe("2026-09-24");
  });
});

describe("validating a posted session", () => {
  it("rejects an unknown kind", () => {
    expect(() => mod.validateSuggestedSession({ ...INTERVALS, kind: "sprint" })).toThrow();
  });

  it("rejects an unknown resolution", () => {
    expect(() => mod.validateResolutions({ a: "delete" })).toThrow();
  });
});
