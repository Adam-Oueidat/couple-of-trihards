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

// A partial update: only keys present in the patch are touched. `null` for
// distanceKm/durationMin explicitly clears that field; an absent key leaves
// the current value alone.
export interface WorkoutPatch {
  date?: string;
  discipline?: "swim" | "ride" | "run";
  name?: string;
  distanceKm?: number | null;
  durationMin?: number | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateDate(v: unknown): string {
  if (typeof v !== "string" || !DATE_RE.test(v)) {
    throw new Error("date must be YYYY-MM-DD");
  }
  return v;
}

function validateDiscipline(v: unknown): "swim" | "ride" | "run" {
  if (v !== "swim" && v !== "ride" && v !== "run") {
    throw new Error("discipline must be swim, ride, or run");
  }
  return v;
}

function validateName(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 100) {
    throw new Error("name is required (max 100 chars)");
  }
  return v;
}

// Used at creation time: undefined/null both mean "not set".
function validateOptionalNum(v: unknown): number | undefined {
  return v === undefined || v === null
    ? undefined
    : typeof v === "number" && v > 0 && v < 1000
      ? v
      : (() => {
          throw new Error("distance/duration must be a positive number");
        })();
}

// Used for patches, where the field is known to be present: null means
// "clear it", a number means "set it".
function validateNullableNum(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v === "number" && v > 0 && v < 1000) return v;
  throw new Error("distance/duration must be a positive number");
}

export function validateWorkoutInput(input: unknown): WorkoutInput {
  const w = input as Record<string, unknown>;
  if (!w || typeof w !== "object") throw new Error("Invalid workout");

  return {
    date: validateDate(w.date),
    discipline: validateDiscipline(w.discipline),
    name: validateName(w.name),
    distanceKm: validateOptionalNum(w.distanceKm ?? w.distance_km),
    durationMin: validateOptionalNum(w.durationMin ?? w.duration_min),
    notes: typeof w.notes === "string" ? w.notes.slice(0, 500) : undefined,
  };
}

export function validateWorkoutPatch(input: unknown): WorkoutPatch {
  const w = input as Record<string, unknown>;
  if (!w || typeof w !== "object") throw new Error("Invalid workout");

  const patch: WorkoutPatch = {};
  if (w.date !== undefined) patch.date = validateDate(w.date);
  if (w.discipline !== undefined) patch.discipline = validateDiscipline(w.discipline);
  if (w.name !== undefined) patch.name = validateName(w.name);
  // Use `in` + explicit precedence rather than `??` so an intentional
  // `distanceKm: null` (clear the field) isn't masked by a missing
  // `distance_km` alias and coalesced away to "field not present".
  if ("distanceKm" in w || "distance_km" in w) {
    patch.distanceKm = validateNullableNum("distanceKm" in w ? w.distanceKm : w.distance_km);
  }
  if ("durationMin" in w || "duration_min" in w) {
    patch.durationMin = validateNullableNum("durationMin" in w ? w.durationMin : w.duration_min);
  }
  return patch;
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

export async function updateWorkout(
  userId: string,
  id: string,
  patch: WorkoutPatch,
): Promise<CustomWorkout | null> {
  const db = getDb();

  const set: Partial<typeof customWorkouts.$inferInsert> = {};
  if (patch.date !== undefined) set.date = patch.date;
  if (patch.discipline !== undefined) set.discipline = patch.discipline;
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.distanceKm !== undefined) set.distanceKm = patch.distanceKm;
  if (patch.durationMin !== undefined) set.durationMin = patch.durationMin;

  if (Object.keys(set).length === 0) {
    const [row] = await db
      .select()
      .from(customWorkouts)
      .where(and(eq(customWorkouts.id, id), eq(customWorkouts.userId, userId)));
    return row ?? null;
  }

  const [row] = await db
    .update(customWorkouts)
    .set(set)
    .where(and(eq(customWorkouts.id, id), eq(customWorkouts.userId, userId)))
    .returning();
  return row ?? null;
}
