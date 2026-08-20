import { and, desc, eq } from "drizzle-orm";
import { getDb, trainingPlans, type TrainingPlanRow } from "@trihards/db";
import {
  buildTrainingPlan,
  createLogger,
  parseRawTrainingPlan,
  type RawTrainingPlan,
  type TrainingPlan,
} from "@trihards/core";

const log = createLogger("training-plans");

/** Plan metadata for list/header UI — everything except the session array. */
export interface PlanSummary {
  id: string;
  name: string;
  source: string;
  discipline: string;
  startDate: string;
  raceDate: string;
  raceName: string;
  sessionCount: number;
  /** Unix seconds. */
  createdAt: number;
  isActive: boolean;
}

export interface ActiveTrainingPlan {
  summary: PlanSummary;
  plan: TrainingPlan;
}

function rowToRawPlan(row: TrainingPlanRow): RawTrainingPlan {
  return {
    name: row.name,
    source: row.source,
    discipline: row.discipline,
    startDate: row.startDate,
    raceDate: row.raceDate,
    raceName: row.raceName,
    sessions: row.sessions,
  };
}

function rowToSummary(row: TrainingPlanRow, isActive: boolean): PlanSummary {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    discipline: row.discipline,
    startDate: row.startDate,
    raceDate: row.raceDate,
    raceName: row.raceName,
    sessionCount: row.sessions.length,
    createdAt: row.createdAt,
    isActive,
  };
}

// Newest upload wins. Ordering by (created_at, id) descending keeps the choice
// deterministic even when two uploads land inside the same second.
async function latestRow(userId: string): Promise<TrainingPlanRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(trainingPlans)
    .where(eq(trainingPlans.userId, userId))
    .orderBy(desc(trainingPlans.createdAt), desc(trainingPlans.id))
    .limit(1);
  return row ?? null;
}

/**
 * The plan this athlete's calendar, plan tab, and coach read — or `null` when
 * they have not uploaded one.
 *
 * There is deliberately no fallback plan. An athlete without a plan of their
 * own has no plan: serving the bundled Runna plan here is what put one
 * athlete's sessions ("Drop Set" intervals) into another athlete's coaching,
 * and a corrupt stored row degrades to "no plan" for the same reason.
 */
export async function getActiveTrainingPlan(
  userId: string,
): Promise<ActiveTrainingPlan | null> {
  const row = await latestRow(userId);
  if (!row) return null;

  try {
    // Re-validate on read: the JSON column may have been written by an older
    // version of the app, and a malformed plan must not break the dashboard.
    const raw = parseRawTrainingPlan(rowToRawPlan(row));
    return { summary: rowToSummary(row, true), plan: buildTrainingPlan(raw) };
  } catch (err) {
    log.error("stored plan failed validation; treating this athlete as having no plan", {
      userId,
      planId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Every plan this athlete has uploaded, newest first. */
export async function listTrainingPlans(userId: string): Promise<PlanSummary[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(trainingPlans)
    .where(eq(trainingPlans.userId, userId))
    .orderBy(desc(trainingPlans.createdAt), desc(trainingPlans.id));
  return rows.map((row, i) => rowToSummary(row, i === 0));
}

/**
 * Persist a validated plan for this athlete. Uploads are append-only — the
 * previous plan is kept and simply stops being the active one — so a mistaken
 * upload is undone by deleting the new row, not by re-uploading the old file.
 */
export async function saveTrainingPlan(
  userId: string,
  input: unknown,
): Promise<PlanSummary> {
  const raw = parseRawTrainingPlan(input);
  const db = getDb();
  const [row] = await db
    .insert(trainingPlans)
    .values({
      id: crypto.randomUUID(),
      userId,
      name: raw.name,
      source: raw.source,
      discipline: raw.discipline as "swim" | "ride" | "run",
      startDate: raw.startDate,
      raceDate: raw.raceDate,
      raceName: raw.raceName,
      sessions: raw.sessions,
    })
    .returning();
  log.info("training plan saved", {
    userId,
    planId: row.id,
    sessions: raw.sessions.length,
  });
  return rowToSummary(row, true);
}

export async function deleteTrainingPlan(
  userId: string,
  id: string,
): Promise<boolean> {
  const db = getDb();
  const deleted = await db
    .delete(trainingPlans)
    .where(and(eq(trainingPlans.id, id), eq(trainingPlans.userId, userId)))
    .returning({ id: trainingPlans.id });
  return deleted.length > 0;
}
