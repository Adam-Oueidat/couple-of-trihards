import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// getDb() reads this lazily on first call and caches the connection, so setting
// it before any test body runs is enough to keep everything in memory.
process.env.TURSO_DATABASE_URL = ":memory:";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../../packages/db/migrations", import.meta.url),
);

let userId: string;
let otherUserId: string;
let goals: typeof import("./goals");

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

  const [a] = await db.insert(users).values({ stravaAthleteId: 7001 }).returning({ id: users.id });
  const [b] = await db.insert(users).values({ stravaAthleteId: 7002 }).returning({ id: users.id });
  userId = a.id;
  otherUserId = b.id;
  goals = await import("./goals");
});

describe("archiving goals", () => {
  it("archives a goal without deleting it, and restores it", async () => {
    const goal = await goals.addGoal(userId, "Sub-1:35 at Copenhagen Half");
    expect(goal.archivedAt).toBeNull();

    const archived = await goals.setGoalArchived(userId, goal.id, true);
    expect(archived?.archivedAt).toBeGreaterThan(0);
    const stored = (await goals.getGoals(userId)).find((g) => g.id === goal.id);
    expect(stored?.archivedAt).toBe(archived?.archivedAt);

    const restored = await goals.setGoalArchived(userId, goal.id, false);
    expect(restored?.archivedAt).toBeNull();
  });

  it("will not archive another athlete's goal", async () => {
    const goal = await goals.addGoal(userId, "First 70.3");
    expect(await goals.setGoalArchived(otherUserId, goal.id, true)).toBeNull();
    const stored = (await goals.getGoals(userId)).find((g) => g.id === goal.id);
    expect(stored?.archivedAt).toBeNull();
  });
});
