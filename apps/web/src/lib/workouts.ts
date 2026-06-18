import { and, asc, eq } from "drizzle-orm";
import { customWorkouts, getDb, type CustomWorkout } from "@trihards/db";

export type { CustomWorkout };

export interface WorkoutInput {
  date: string;
  discipline: "swim" | "ride" | "run";
  name: string;
  distanceKm?: number;
  durationMin?: number;
  notes?: string;
}

export function validateWorkoutInput(input: unknown): WorkoutInput {
  const w = input as Record<string, unknown>;
  if (!w || typeof w !== "object") throw new Error("Invalid workout");

  if (typeof w.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(w.date)) {
    throw new Error("date must be YYYY-MM-DD");
  }
  if (w.discipline !== "swim" && w.discipline !== "ride" && w.discipline !== "run") {
    throw new Error("discipline must be swim, ride, or run");
  }
  if (typeof w.name !== "string" || w.name.length === 0 || w.name.length > 100) {
    throw new Error("name is required (max 100 chars)");
  }

  const num = (v: unknown) =>
    v === undefined || v === null
      ? undefined
      : typeof v === "number" && v > 0 && v < 1000
        ? v
        : (() => {
            throw new Error("distance/duration must be a positive number");
          })();

  return {
    date: w.date,
    discipline: w.discipline,
    name: w.name,
    distanceKm: num(w.distanceKm ?? w.distance_km),
    durationMin: num(w.durationMin ?? w.duration_min),
    notes: typeof w.notes === "string" ? w.notes.slice(0, 500) : undefined,
  };
}

export async function getWorkouts(userId: string): Promise<CustomWorkout[]> {
  const db = getDb();
  return db
    .select()
    .from(customWorkouts)
    .where(eq(customWorkouts.userId, userId))
    .orderBy(asc(customWorkouts.date));
}

export async function addWorkout(
  userId: string,
  input: WorkoutInput,
  addedBy: "athlete" | "coach",
): Promise<CustomWorkout> {
  const db = getDb();
  const [row] = await db
    .insert(customWorkouts)
    .values({
      id: crypto.randomUUID(),
      userId,
      date: input.date,
      discipline: input.discipline,
      name: input.name,
      distanceKm: input.distanceKm,
      durationMin: input.durationMin,
      notes: input.notes,
      addedBy,
    })
    .returning();
  return row;
}

export async function deleteWorkout(userId: string, id: string): Promise<boolean> {
  const db = getDb();
  const deleted = await db
    .delete(customWorkouts)
    .where(and(eq(customWorkouts.id, id), eq(customWorkouts.userId, userId)))
    .returning({ id: customWorkouts.id });
  return deleted.length > 0;
}

export async function updateWorkoutDate(
  userId: string,
  id: string,
  date: string,
): Promise<CustomWorkout | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("date must be YYYY-MM-DD");
  }
  const db = getDb();
  const [row] = await db
    .update(customWorkouts)
    .set({ date })
    .where(and(eq(customWorkouts.id, id), eq(customWorkouts.userId, userId)))
    .returning();
  return row ?? null;
}
