import { and, asc, eq } from "drizzle-orm";
import { getDb, goals, type Goal } from "@trihards/db";

export type { Goal };

export async function getGoals(userId: string): Promise<Goal[]> {
  const db = getDb();
  return db.select().from(goals).where(eq(goals.userId, userId)).orderBy(asc(goals.createdAt));
}

export async function addGoal(userId: string, text: unknown): Promise<Goal> {
  if (typeof text !== "string" || text.trim().length === 0 || text.length > 300) {
    throw new Error("Goal text is required (max 300 chars)");
  }
  const db = getDb();
  const [row] = await db
    .insert(goals)
    .values({ id: crypto.randomUUID(), userId, text: text.trim() })
    .returning();
  return row;
}

export async function deleteGoal(userId: string, id: string): Promise<boolean> {
  const db = getDb();
  const deleted = await db
    .delete(goals)
    .where(and(eq(goals.id, id), eq(goals.userId, userId)))
    .returning({ id: goals.id });
  return deleted.length > 0;
}
