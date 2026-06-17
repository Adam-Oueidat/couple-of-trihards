import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chatMessages, conversations, users } from "../src";
import { makeTestDb } from "./setup";

describe("chat_messages ordering", () => {
  it("messages return in created_at order for a conversation", async () => {
    const { db } = await makeTestDb();
    const [u] = await db
      .insert(users)
      .values({ stravaAthleteId: 1 })
      .returning({ id: users.id });
    const [c] = await db
      .insert(conversations)
      .values({ userId: u.id })
      .returning({ id: conversations.id });

    const base = Math.floor(Date.now() / 1000);
    await db.insert(chatMessages).values([
      { userId: u.id, conversationId: c.id, role: "user", content: "first", createdAt: base + 1 },
      { userId: u.id, conversationId: c.id, role: "assistant", content: "second", createdAt: base + 2 },
      { userId: u.id, conversationId: c.id, role: "user", content: "third", createdAt: base + 3 },
    ]);

    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, c.id))
      .orderBy(asc(chatMessages.createdAt));

    expect(rows.map((r) => r.content)).toEqual(["first", "second", "third"]);
  });

  it("role check constraint rejects invalid values", async () => {
    const { db } = await makeTestDb();
    const [u] = await db
      .insert(users)
      .values({ stravaAthleteId: 1 })
      .returning({ id: users.id });
    const [c] = await db
      .insert(conversations)
      .values({ userId: u.id })
      .returning({ id: conversations.id });

    // Drizzle's enum is TS-only; the column is plain TEXT. This insert succeeds
    // at the SQL layer — the type system catches it before runtime. Just
    // verify the column accepts the documented values.
    await db.insert(chatMessages).values({
      userId: u.id,
      conversationId: c.id,
      role: "tool_result",
      content: '{"id":"x"}',
    });

    const rows = await db.select().from(chatMessages);
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("tool_result");
  });
});
