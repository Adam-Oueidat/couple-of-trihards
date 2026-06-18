import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { customWorkouts, goals, users } from "../src";
import { makeTestDb } from "./setup";

describe("per-user scoping", () => {
  it("goals queries scoped to one user never leak another's rows", async () => {
    const { db } = await makeTestDb();
    const [a] = await db
      .insert(users)
      .values({ stravaAthleteId: 1 })
      .returning({ id: users.id });
    const [b] = await db
      .insert(users)
      .values({ stravaAthleteId: 2 })
      .returning({ id: users.id });

    await db.insert(goals).values([
      { id: "g-a-1", userId: a.id, text: "A goal 1" },
      { id: "g-a-2", userId: a.id, text: "A goal 2" },
      { id: "g-b-1", userId: b.id, text: "B goal 1" },
    ]);

    const aRows = await db.select().from(goals).where(eq(goals.userId, a.id));
    expect(aRows).toHaveLength(2);
    expect(aRows.every((r) => r.userId === a.id)).toBe(true);

    const bRows = await db.select().from(goals).where(eq(goals.userId, b.id));
    expect(bRows).toHaveLength(1);
    expect(bRows[0].text).toBe("B goal 1");
  });

  it("custom_workouts insertion requires a user_id (FK enforced)", async () => {
    const { db, client } = await makeTestDb();
    await client.execute("PRAGMA foreign_keys = ON");

    await expect(
      db.insert(customWorkouts).values({
        id: "ghost",
        userId: "nonexistent-user",
        date: "2026-06-16",
        discipline: "run",
        name: "Ghost run",
        addedBy: "athlete",
      }),
    ).rejects.toThrow();
  });

  it("deleting a user cascades to goals", async () => {
    const { db, client } = await makeTestDb();
    await client.execute("PRAGMA foreign_keys = ON");

    const [u] = await db
      .insert(users)
      .values({ stravaAthleteId: 42 })
      .returning({ id: users.id });

    await db.insert(goals).values({ id: "g1", userId: u.id, text: "go" });

    await db.delete(users).where(eq(users.id, u.id));

    const remaining = await db.select().from(goals).where(eq(goals.userId, u.id));
    expect(remaining).toHaveLength(0);
  });
});
