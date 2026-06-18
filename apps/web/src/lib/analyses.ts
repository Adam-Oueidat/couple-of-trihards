import { and, desc, eq } from "drizzle-orm";
import { analyses, getDb } from "@trihards/db";

export interface StoredAnalysis {
  text: string;
  createdAt: string;
}

export interface AnalysisWithActivity extends StoredAnalysis {
  activityId: number;
}

export async function getAnalysis(
  userId: string,
  activityId: number,
): Promise<StoredAnalysis | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(analyses)
    .where(and(eq(analyses.userId, userId), eq(analyses.activityId, String(activityId))));
  if (!row) return null;
  return { text: row.text, createdAt: new Date(row.createdAt * 1000).toISOString() };
}

export async function getRecentAnalyses(
  userId: string,
  limit: number,
): Promise<AnalysisWithActivity[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(analyses)
    .where(eq(analyses.userId, userId))
    .orderBy(desc(analyses.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    text: r.text,
    createdAt: new Date(r.createdAt * 1000).toISOString(),
    activityId: Number(r.activityId),
  }));
}

export async function saveAnalysis(
  userId: string,
  activityId: number,
  text: string,
): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db
    .insert(analyses)
    .values({ userId, activityId: String(activityId), text })
    .onConflictDoUpdate({
      target: [analyses.userId, analyses.activityId],
      set: { text, createdAt: now },
    });
}
