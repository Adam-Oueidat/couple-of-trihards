import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

process.env.TURSO_DATABASE_URL = ":memory:";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../packages/db/migrations", import.meta.url));

let plans: typeof import("./training-plans");
let db: ReturnType<typeof import("@trihards/db").getDb>;
let schema: typeof import("@trihards/db");

beforeAll(async () => {
  schema = await import("@trihards/db");
  const { sql } = await import("drizzle-orm");
  db = schema.getDb();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const stmt of text.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
      await db.run(sql.raw(stmt));
    }
  }
  plans = await import("./training-plans");
});

async function user(athleteId: number): Promise<string> {
  const [u] = await db.insert(schema.users).values({ stravaAthleteId: athleteId }).returning({ id: schema.users.id });
  return u.id;
}

const run = (date: string, name: string) => ({ date, name, type: "easy" as const, km: 8 });

async function insertPlan(userId: string, createdOn: string, startDate: string, sessions: ReturnType<typeof run>[]) {
  await db.insert(schema.trainingPlans).values({
    id: crypto.randomUUID(),
    userId,
    name: `Plan from ${startDate}`,
    source: "Test",
    discipline: "run",
    startDate,
    raceDate: sessions[sessions.length - 1].date,
    raceName: "",
    sessions,
    createdAt: Math.floor(new Date(`${createdOn}T12:00:00Z`).getTime() / 1000),
  });
}

describe("a new plan takes over from the one before it", () => {
  it("keeps the old plan's sessions until the new start when it was still running on save", async () => {
    const id = await user(9101);
    await insertPlan(id, "2026-09-01", "2026-09-07", [run("2026-09-20", "Old long run"), run("2026-10-04", "Old last run")]);
    // Saved on 24 Sep while the old plan still ran to 4 Oct; the new one starts 5 Oct.
    await insertPlan(id, "2026-09-24", "2026-10-05", [run("2026-10-06", "New first run")]);

    const active = await plans.getActiveTrainingPlan(id);
    expect(active?.plan.sessions.map((s) => s.name)).toEqual(["Old long run", "Old last run", "New first run"]);
    expect(active?.plan.startDate).toBe("2026-09-07");
    expect(active?.summary.name).toBe("Plan from 2026-10-05");
  });

  it("drops the old plan's sessions from the new start onward when they overlap", async () => {
    const id = await user(9102);
    await insertPlan(id, "2026-09-01", "2026-09-07", [run("2026-10-01", "Old before"), run("2026-10-10", "Old after")]);
    await insertPlan(id, "2026-09-24", "2026-10-05", [run("2026-10-06", "New first run")]);

    const active = await plans.getActiveTrainingPlan(id);
    expect(active?.plan.sessions.map((s) => s.name)).toEqual(["Old before", "New first run"]);
  });

  it("brings nothing across from a plan that had already finished", async () => {
    const id = await user(9103);
    await insertPlan(id, "2026-06-01", "2026-06-08", [run("2026-09-20", "Race")]);
    await insertPlan(id, "2026-09-24", "2026-10-05", [run("2026-10-06", "New first run")]);

    const active = await plans.getActiveTrainingPlan(id);
    expect(active?.plan.sessions.map((s) => s.name)).toEqual(["New first run"]);
  });
});
