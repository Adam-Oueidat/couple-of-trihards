import seedPlanData from "./data/runna-plan.json" with { type: "json" };
import { StravaActivity } from "./types/strava";
import { activityDay, getDiscipline, getWeekStart, localToday } from "./training";

export type SessionType =
  | "easy"
  | "intervals"
  | "tempo"
  | "long"
  | "time_trial"
  | "race";

export const SESSION_TYPES: readonly SessionType[] = [
  "easy",
  "intervals",
  "tempo",
  "long",
  "time_trial",
  "race",
];

export interface PlannedSession {
  id: string;
  date: string;
  originalDate: string;
  name: string;
  type: SessionType;
  km: number;
  movedFrom?: string;
  moveReason?: string;
  hidden?: boolean;
}

export interface TrainingPlan {
  name: string;
  source: string;
  discipline: string;
  startDate: string;
  raceDate: string;
  raceName: string;
  sessions: PlannedSession[];
}

// The stored / authored shape of a session: no derived `id`, and none of the
// override fields, since both are computed when the plan is materialised. This
// is exactly what the `training_plans.sessions` JSON column holds and what the
// PDF parser is asked to produce, so one validator covers both paths.
export interface RawPlannedSession {
  date: string;
  name: string;
  type: SessionType;
  km: number;
}

export type RawTrainingPlan = Omit<TrainingPlan, "sessions"> & {
  sessions: RawPlannedSession[];
};

export interface PlanOverride {
  sessionId: string;
  originalDate: string;
  newDate: string;
  movedAt: string;
  reason?: string;
  hidden?: boolean;
}

export type PlanOverrideMap = Record<string, PlanOverride>;

// A calendar custom workout, reduced to the fields the plan views need. The web
// app's CustomWorkout (a superset) is structurally assignable to this, so it can
// be passed straight through without a mapping. Kept here so core stays free of
// the db package. `distanceKm` is null for duration-only workouts.
export interface CustomWorkoutInput {
  id: string;
  date: string;
  discipline: "swim" | "ride" | "run";
  name: string;
  distanceKm: number | null;
}

function sessionSlug(date: string, name: string): string {
  return `${date}-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

// Materialise an authored/stored plan into the shape the views consume: every
// session gains the stable slug id (date + name) that plan_overrides keys on,
// plus an `originalDate` so a moved session can always be reset.
export function buildTrainingPlan(raw: RawTrainingPlan): TrainingPlan {
  return {
    name: raw.name,
    source: raw.source,
    discipline: raw.discipline,
    startDate: raw.startDate,
    raceDate: raw.raceDate,
    raceName: raw.raceName,
    sessions: raw.sessions.map((s) => ({
      id: sessionSlug(s.date, s.name),
      date: s.date,
      originalDate: s.date,
      name: s.name,
      type: s.type,
      km: s.km,
    })),
  };
}

/**
 * The bundled Runna plan, kept ONLY as an explicit seed for the one-time
 * backfill that assigns it to the athlete it was actually written for
 * (packages/db/scripts/backfill-seed-plan.ts).
 *
 * It is deliberately NOT a runtime default. Every plan-aware function below
 * takes the athlete's plan as a required parameter, so no read path can hand
 * this plan to an athlete who never uploaded it. Serving it as a fallback is
 * what let one athlete's sessions surface in another athlete's coaching.
 */
export const SEED_PLAN: TrainingPlan = buildTrainingPlan(
  seedPlanData as RawTrainingPlan,
);

export function applyPlanOverrides(
  sessions: PlannedSession[],
  overrides?: PlanOverrideMap,
): PlannedSession[] {
  if (!overrides) return sessions;
  return sessions.map((s) => {
    const override = overrides[s.id];
    if (!override) return s;
    return {
      ...s,
      date: override.newDate,
      movedFrom: override.newDate !== s.originalDate ? s.originalDate : undefined,
      moveReason: override.reason,
      hidden: override.hidden,
    };
  });
}

export type SessionStatus =
  | "completed"
  | "partial"
  | "missed"
  | "upcoming"
  | "today";

export interface SessionWithStatus extends PlannedSession {
  status: SessionStatus;
  actualKm?: number;
  matchedActivity?: string;
  // Set only for custom workouts merged in from the calendar; the run plan's
  // sessions leave it undefined. Lets the UI show the discipline instead of the
  // run-only `type` for those rows.
  discipline?: "swim" | "ride" | "run";
  isCustom?: boolean;
}

// `trainingPlan` is this athlete's own plan, and it leads the parameter list
// precisely because it is required and has no default: an athlete with no plan
// is passed `null` and gets no plan sessions, never someone else's.
//
// `today` is an athlete-local ISO date (YYYY-MM-DD). It defaults to the local
// date, which is correct when these run client-side (PlannedVsActual); server
// callers (the coach) must pass the athlete's resolved local date so they don't
// fall back to the server's UTC clock and drift a day ahead.
export function matchSessions(
  trainingPlan: TrainingPlan | null,
  activities: StravaActivity[],
  overrides?: PlanOverrideMap,
  today: string = localToday(),
  customWorkouts: CustomWorkoutInput[] = [],
): SessionWithStatus[] {
  // Drop hidden ("Removed" in the calendar) sessions so the plan list and the
  // calendar agree; the calendar skips them with the same check. With no plan
  // there is nothing to schedule — only the athlete's own custom workouts.
  const sessions = applyPlanOverrides(
    trainingPlan?.sessions ?? [],
    overrides,
  ).filter((s) => !s.hidden);

  const runsByDate = new Map<string, StravaActivity[]>();
  for (const act of activities) {
    if (getDiscipline(act) !== "run") continue;
    const day = act.start_date_local.split("T")[0];
    const list = runsByDate.get(day) ?? [];
    list.push(act);
    runsByDate.set(day, list);
  }

  const planResults: SessionWithStatus[] = sessions.map((session) => {
    const runs = runsByDate.get(session.date) ?? [];
    const actualKm = runs.reduce((sum, r) => sum + r.distance / 1000, 0);

    if (runs.length > 0) {
      return {
        ...session,
        status:
          actualKm >= session.km * 0.8
            ? ("completed" as const)
            : ("partial" as const),
        actualKm: Math.round(actualKm * 10) / 10,
        matchedActivity: runs[0].name,
      };
    }
    if (session.date === today) return { ...session, status: "today" as const };
    if (session.date > today) return { ...session, status: "upcoming" as const };
    return { ...session, status: "missed" as const };
  });

  // Custom workouts the athlete added on the calendar (any discipline). Match
  // same-day activities of the *same* discipline for status, so an added workout
  // shows up in the plan list and is graded like a plan session.
  const kmByDayDiscipline = new Map<string, number>();
  const nameByDayDiscipline = new Map<string, string>();
  for (const act of activities) {
    const key = `${act.start_date_local.split("T")[0]}|${getDiscipline(act)}`;
    kmByDayDiscipline.set(key, (kmByDayDiscipline.get(key) ?? 0) + act.distance / 1000);
    if (!nameByDayDiscipline.has(key)) nameByDayDiscipline.set(key, act.name);
  }

  const customResults: SessionWithStatus[] = customWorkouts.map((w) => {
    const plannedKm = w.distanceKm ?? 0;
    const base: SessionWithStatus = {
      id: w.id,
      date: w.date,
      originalDate: w.date,
      name: w.name,
      // `type` is run-plan-specific and unused for custom rows (the UI shows
      // `discipline` instead); "easy" is a benign placeholder to satisfy the type.
      type: "easy",
      km: plannedKm,
      discipline: w.discipline,
      isCustom: true,
      status: "upcoming",
    };

    const key = `${w.date}|${w.discipline}`;
    const actualKm = kmByDayDiscipline.get(key);
    if (actualKm !== undefined) {
      // Duration-only workouts (no planned km) count as done once a matching
      // activity exists; otherwise use the same 80%-of-planned threshold.
      const done = plannedKm > 0 ? actualKm >= plannedKm * 0.8 : true;
      return {
        ...base,
        status: done ? "completed" : "partial",
        actualKm: Math.round(actualKm * 10) / 10,
        matchedActivity: nameByDayDiscipline.get(key),
      };
    }
    if (w.date === today) return { ...base, status: "today" };
    if (w.date > today) return { ...base, status: "upcoming" };
    return { ...base, status: "missed" };
  });

  return [...planResults, ...customResults].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
}

export interface PlannedVsActualWeek {
  weekStart: string;
  plannedKm: number;
  actualKm: number;
  isCurrentWeek: boolean;
  isFuture: boolean;
}

export function plannedVsActualByWeek(
  trainingPlan: TrainingPlan | null,
  activities: StravaActivity[],
  overrides?: PlanOverrideMap,
  today: string = localToday(),
  customWorkouts: CustomWorkoutInput[] = [],
): PlannedVsActualWeek[] {
  const sessions = applyPlanOverrides(trainingPlan?.sessions ?? [], overrides);

  // Which disciplines are planned each week — the plan's own discipline plus
  // any discipline the athlete added a custom workout for that week. Actual km
  // is then counted only for a week's planned disciplines, so the comparison
  // stays apples-to-apples once non-run workouts enter the picture.
  const planDiscipline = trainingPlan?.discipline ?? "";
  const plannedByWeek = new Map<string, number>();
  const disciplinesByWeek = new Map<string, Set<string>>();
  const addDiscipline = (week: string, discipline: string) => {
    const set = disciplinesByWeek.get(week) ?? new Set<string>();
    set.add(discipline);
    disciplinesByWeek.set(week, set);
  };

  for (const s of sessions) {
    if (s.hidden) continue; // "Removed" in the calendar → drop from planned km
    const week = getWeekStart(new Date(s.date + "T12:00:00"));
    plannedByWeek.set(week, (plannedByWeek.get(week) ?? 0) + s.km);
    addDiscipline(week, planDiscipline);
  }
  for (const w of customWorkouts) {
    const week = getWeekStart(new Date(w.date + "T12:00:00"));
    plannedByWeek.set(week, (plannedByWeek.get(week) ?? 0) + (w.distanceKm ?? 0));
    addDiscipline(week, w.discipline);
  }

  const actualByWeek = new Map<string, number>();
  for (const act of activities) {
    const week = getWeekStart(activityDay(act.start_date_local));
    if (!disciplinesByWeek.get(week)?.has(getDiscipline(act))) continue;
    actualByWeek.set(week, (actualByWeek.get(week) ?? 0) + act.distance / 1000);
  }

  const currentWeek = getWeekStart(new Date(today + "T12:00:00"));

  return Array.from(plannedByWeek.keys())
    .sort()
    .map((weekStart) => ({
      weekStart,
      plannedKm: Math.round((plannedByWeek.get(weekStart) ?? 0) * 10) / 10,
      actualKm: Math.round((actualByWeek.get(weekStart) ?? 0) * 10) / 10,
      isCurrentWeek: weekStart === currentWeek,
      isFuture: weekStart > currentWeek,
    }));
}

export function getCurrentWeekSessions(
  trainingPlan: TrainingPlan | null,
  activities: StravaActivity[],
  overrides?: PlanOverrideMap,
  today: string = localToday(),
): SessionWithStatus[] {
  const currentWeek = getWeekStart(new Date(today + "T12:00:00"));
  return matchSessions(trainingPlan, activities, overrides, today).filter(
    (s) => getWeekStart(new Date(s.date + "T12:00:00")) === currentWeek,
  );
}

// Takes a non-null plan by design: "days until race" is meaningless without
// one, so a caller has to establish the athlete has a plan before asking. There
// is no default here to fall through to.
export function daysUntilRace(
  trainingPlan: TrainingPlan,
  today: string = localToday(),
): number {
  const race = new Date(trainingPlan.raceDate + "T12:00:00");
  const now = new Date(today + "T12:00:00");
  return Math.max(0, Math.ceil((race.getTime() - now.getTime()) / 86400000));
}
