import { and, desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { trainingPlans, users } from "../src";
import { makeTestDb } from "./setup";

// Training plans used to be a single JSON file baked into the core package, so
// every athlete saw the same one. They are now per-user rows, and these tests
// pin the property that made that change worth making: one athlete's plan is
// never readable, replaceable, or deletable by another.

const SESSIONS = [
  { date: "2026-06-08", name: "13km Easy Run", type: "easy" as const, km: 13 },
  { date: "2026-06-13", name: "17km Long Run", type: "long" as const, km: 17 },
];

function planFor(userId: string, over: Partial<typeof trainingPlans.$inferInsert> = {}) {
  return {
    id: crypto.randomUUID(),
    userId,
    name: "Copenhagen Half Marathon Plan",
    source: "Runna",
    discipline: "run" as const,
    startDate: "2026-06-08",
    raceDate: "2026-09-20",
    raceName: "Copenhagen Half Marathon",
    sessions: SESSIONS,
    ...over,
  };
}

async function twoUsers(db: Awaited<ReturnType<typeof makeTestDb>>["db"]) {
  const [a] = await db.insert(users).values({ stravaAthleteId: 1 }).returning({ id: users.id });
  const [b] = await db.insert(users).values({ stravaAthleteId: 2 }).returning({ id: users.id });
  return { a, b };
}

describe("per-user training plans", () => {
  it("a plan query scoped to one user never returns another's plan", async () => {
    const { db } = await makeTestDb();
    const { a, b } = await twoUsers(db);

    await db.insert(trainingPlans).values([
      planFor(a.id, { name: "A's marathon block" }),
      planFor(b.id, { name: "B's 70.3 build", discipline: "ride" }),
    ]);

    const aRows = await db
      .select()
      .from(trainingPlans)
      .where(eq(trainingPlans.userId, a.id));
    expect(aRows).toHaveLength(1);
    expect(aRows[0].name).toBe("A's marathon block");

    const bRows = await db
      .select()
      .from(trainingPlans)
      .where(eq(trainingPlans.userId, b.id));
    expect(bRows).toHaveLength(1);
    expect(bRows[0].name).toBe("B's 70.3 build");
  });

  it("the active-plan lookup ignores another user's newer upload", async () => {
    const { db } = await makeTestDb();
    const { a, b } = await twoUsers(db);

    // A uploaded first; B uploaded later. "Newest wins" must stay scoped to the
    // athlete, otherwise B's upload would silently become A's calendar.
    await db.insert(trainingPlans).values(planFor(a.id, { name: "A's plan", createdAt: 1000 }));
    await db.insert(trainingPlans).values(planFor(b.id, { name: "B's plan", createdAt: 2000 }));

    const [active] = await db
      .select()
      .from(trainingPlans)
      .where(eq(trainingPlans.userId, a.id))
      .orderBy(desc(trainingPlans.createdAt), desc(trainingPlans.id))
      .limit(1);

    expect(active.name).toBe("A's plan");
  });

  it("deleting a plan scoped by (id, userId) can't remove another user's plan", async () => {
    const { db } = await makeTestDb();
    const { a, b } = await twoUsers(db);

    const bPlan = planFor(b.id, { name: "B's plan" });
    await db.insert(trainingPlans).values([planFor(a.id), bPlan]);

    // A tries to delete B's plan by id: the userId guard means nothing is removed.
    const stolen = await db
      .delete(trainingPlans)
      .where(and(eq(trainingPlans.id, bPlan.id), eq(trainingPlans.userId, a.id)))
      .returning({ id: trainingPlans.id });
    expect(stolen).toHaveLength(0);
    expect(
      await db.select().from(trainingPlans).where(eq(trainingPlans.id, bPlan.id)),
    ).toHaveLength(1);

    // The owner can delete their own.
    const owned = await db
      .delete(trainingPlans)
      .where(and(eq(trainingPlans.id, bPlan.id), eq(trainingPlans.userId, b.id)))
      .returning({ id: trainingPlans.id });
    expect(owned).toHaveLength(1);
  });

  it("training_plans insertion requires a real user_id (FK enforced)", async () => {
    const { db, client } = await makeTestDb();
    await client.execute("PRAGMA foreign_keys = ON");

    await expect(
      db.insert(trainingPlans).values(planFor("nonexistent-user")),
    ).rejects.toThrow();
  });

  it("deleting a user cascades to their training plans", async () => {
    const { db, client } = await makeTestDb();
    await client.execute("PRAGMA foreign_keys = ON");

    const [u] = await db
      .insert(users)
      .values({ stravaAthleteId: 42 })
      .returning({ id: users.id });
    await db.insert(trainingPlans).values(planFor(u.id));

    await db.delete(users).where(eq(users.id, u.id));

    expect(
      await db.select().from(trainingPlans).where(eq(trainingPlans.userId, u.id)),
    ).toHaveLength(0);
  });

  it("an athlete with no plan row simply has no plan", async () => {
    const { db } = await makeTestDb();
    const { a, b } = await twoUsers(db);

    // Only A has uploaded a plan. B's active-plan lookup must come back empty
    // rather than inheriting A's — or anything bundled with the app.
    await db.insert(trainingPlans).values(planFor(a.id, { name: "A's plan" }));

    const bActive = await db
      .select()
      .from(trainingPlans)
      .where(eq(trainingPlans.userId, b.id))
      .orderBy(desc(trainingPlans.createdAt), desc(trainingPlans.id))
      .limit(1);

    expect(bActive).toHaveLength(0);
  });

  it("round-trips the sessions JSON column as structured data", async () => {
    const { db } = await makeTestDb();
    const [u] = await db
      .insert(users)
      .values({ stravaAthleteId: 7 })
      .returning({ id: users.id });

    await db.insert(trainingPlans).values(planFor(u.id));

    const [row] = await db
      .select()
      .from(trainingPlans)
      .where(eq(trainingPlans.userId, u.id));

    expect(Array.isArray(row.sessions)).toBe(true);
    expect(row.sessions).toEqual(SESSIONS);
  });
});
