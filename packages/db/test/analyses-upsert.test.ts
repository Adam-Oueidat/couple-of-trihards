import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { analyses, users } from "../src";
import { makeTestDb } from "./setup";

describe("analyses upsert on (user_id, activity_id)", () => {
  it("re-saving the same activity replaces the prior text", async () => {
    const { db } = await makeTestDb();
    const [u] = await db
      .insert(users)
      .values({ stravaAthleteId: 1 })
      .returning({ id: users.id });

    await db.insert(analyses).values({
      userId: u.id,
      activityId: "12345",
      text: "first",
    });

    await db
      .insert(analyses)
      .values({ userId: u.id, activityId: "12345", text: "second" })
      .onConflictDoUpdate({
        target: [analyses.userId, analyses.activityId],
        set: { text: "second", createdAt: Math.floor(Date.now() / 1000) },
      });

    const rows = await db
      .select()
      .from(analyses)
      .where(and(eq(analyses.userId, u.id), eq(analyses.activityId, "12345")));
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("second");
  });

  it("same activity_id for different users does not conflict", async () => {
    const { db } = await makeTestDb();
    const [a] = await db
      .insert(users)
      .values({ stravaAthleteId: 1 })
      .returning({ id: users.id });
    const [b] = await db
      .insert(users)
      .values({ stravaAthleteId: 2 })
      .returning({ id: users.id });

    await db.insert(analyses).values([
      { userId: a.id, activityId: "100", text: "A's take" },
      { userId: b.id, activityId: "100", text: "B's take" },
    ]);

    const allRows = await db.select().from(analyses);
    expect(allRows).toHaveLength(2);
  });
});
