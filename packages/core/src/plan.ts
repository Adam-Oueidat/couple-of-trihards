import seedPlanData from "./data/runna-plan.json" with { type: "json" };
import { StravaActivity } from "./types/strava";
import { activityDay, getDiscipline, getWeekStart, localToday } from "./training";
import type { TrainingDiscipline } from "./recap";

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
  // "Planned, but I did not do it, because X." Unlike `hidden` the session
  // stays in every view — skipping is training information, removing is not.
  skipped?: boolean;
  skipReason?: string;
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
  // Why the session was *moved*. The skip reason is separate below, because a
  // session can be both rescheduled and then skipped.
  reason?: string;
  hidden?: boolean;
  skipped?: boolean;
  skipReason?: string;
  // Athlete edits to the session's own fields. Undefined means "unchanged".
  // The session id is derived from the STORED plan's (date, name) in
  // buildTrainingPlan, before overrides are applied, so renaming here can
  // never re-derive the id and orphan the override row.
  name?: string;
  type?: SessionType;
  km?: number;
}

export type PlanOverrideMap = Record<string, PlanOverride>;

// A calendar custom workout, reduced to the fields the plan views need. The web
// app's CustomWorkout (a superset) is structurally assignable to this, so it can
// be passed straight through without a mapping. Kept here so core stays free of
// the db package. `distanceKm` is null for duration-only workouts.
export interface CustomWorkoutInput {
  id: string;
  date: string;
  discipline: TrainingDiscipline;
  name: string;
  distanceKm: number | null;
  /** Used to estimate the load of a workout that has not happened yet. */
  durationMin?: number | null;
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
      skipped: override.skipped,
      skipReason: override.skipReason,
      name: override.name ?? s.name,
      type: override.type ?? s.type,
      km: override.km ?? s.km,
    };
  });
}

export type SessionStatus =
  | "completed"
  | "partial"
  | "missed"
  | "skipped"
  | "upcoming"
  | "today";

export interface SessionWithStatus extends PlannedSession {
  status: SessionStatus;
  actualKm?: number;
  matchedActivity?: string;
  // Set only for custom workouts merged in from the calendar; the run plan's
  // sessions leave it undefined. Lets the UI show the discipline instead of the
  // run-only `type` for those rows.
  discipline?: TrainingDiscipline;
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
    // Skipped is decided before anything else, and deliberately outranks even
    // `today`/`upcoming`: the athlete has stated they are not doing this one,
    // which is a fact about the session, not a function of the date. Grading it
    // against a same-day activity would also be wrong in both directions — a
    // swap ("skipped the run, swam instead") is not a completed run, and an
    // easy shakeout on the same day is not a half-finished interval session.
    if (session.skipped) return { ...session, status: "skipped" as const };

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
    // "Removed" in the calendar → drop from planned km. Skipped sessions are
    // NOT dropped: the plan did ask for that distance, and quietly deducting it
    // would let a week of skips read as full adherence. The shortfall stays
    // visible; the reason for it is what the coach gets alongside.
    if (s.hidden) continue;
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

/** Whole days from `today` to the race — negative once the race has passed. */
function raceDayDelta(trainingPlan: TrainingPlan, today: string): number {
  const race = new Date(trainingPlan.raceDate + "T12:00:00");
  const now = new Date(today + "T12:00:00");
  return Math.ceil((race.getTime() - now.getTime()) / 86400000);
}

// Takes a non-null plan by design: "days until race" is meaningless without
// one, so a caller has to establish the athlete has a plan before asking. There
// is no default here to fall through to.
//
// Clamped at zero on purpose — "days until" cannot sensibly go negative. That
// makes it the wrong thing to ask once the race is behind the athlete: it
// answers 0 forever, which is how the dashboard came to say "Race in 0 days"
// indefinitely after a race. Use racePhase() when the answer has to
// distinguish "race day" from "the plan is over".
export function daysUntilRace(
  trainingPlan: TrainingPlan,
  today: string = localToday(),
): number {
  return Math.max(0, raceDayDelta(trainingPlan, today));
}

/**
 * Where the athlete is relative to their goal race.
 *
 * A plan has a life cycle, and "upcoming" is only one third of it. Modelling
 * that as a single clamped number lost the difference between the morning of
 * the race and the month after it, so every surface that asked ended up
 * claiming the race was imminent forever.
 */
export type RacePhase =
  | { state: "upcoming"; days: number }
  | { state: "raceDay" }
  | { state: "complete"; days: number };

export function racePhase(
  trainingPlan: TrainingPlan,
  today: string = localToday(),
): RacePhase {
  const delta = raceDayDelta(trainingPlan, today);
  if (delta > 0) return { state: "upcoming", days: delta };
  if (delta === 0) return { state: "raceDay" };
  return { state: "complete", days: -delta };
}

export function isPlanComplete(
  trainingPlan: TrainingPlan,
  today: string = localToday(),
): boolean {
  return racePhase(trainingPlan, today).state === "complete";
}

/**
 * A session that looks like it was run, just not on its planned day.
 *
 * Grading matches a session to activities on the SAME date only, so a session
 * done a day early or late reads as missed while the run that satisfied it sits
 * unclaimed next to it. This finds those pairs so the coach can offer to move
 * the session onto the day it actually happened.
 */
export interface MisdatedSession {
  session: SessionWithStatus;
  /** The run that looks like it satisfied it. */
  activity: { id: number; name: string; date: string; km: number };
  /** Days from planned to actual: -1 ran a day early, +1 a day late. */
  offsetDays: number;
  /**
   * `full` — the run covers the planned distance, so moving it completes the
   * session. `partial` — the athlete clearly set out to do this session and cut
   * it short (one such run in the real data is literally named "should have
   * been 15, became 8"). Moving it records that they trained and that the
   * session came up short, which is truer than leaving it as "missed".
   */
  confidence: "full" | "partial";
}

// One day either side, and no further. On the plan this was built against,
// widening to ±2, ±3 or even ±7 days found nothing a ±1 window had not already
// caught — every real case was an adjacent-day slip. A wider window only buys
// the chance of claiming an unrelated run for a session the athlete genuinely
// skipped, which is a worse error than leaving it marked missed.
const MISDATE_WINDOW_DAYS = 1;

// The same threshold matchSessions uses to call a session "completed". A run
// that would not have completed the session on the day cannot retro-complete it
// from a day away either.
const MISDATE_FULL_RATIO = 0.8;

// Below the completion bar but still plainly an attempt at the session rather
// than an unrelated outing. These are offered separately and never applied
// without the athlete accepting them, which is what makes the looser bar safe:
// a wrong suggestion costs one click to dismiss, while the alternative is
// leaving a session they actually ran marked as missed.
const MISDATE_PARTIAL_RATIO = 0.4;

function shiftDate(date: string, days: number): string {
  const d = new Date(date + "T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

export function findMisdatedSessions(
  trainingPlan: TrainingPlan | null,
  activities: StravaActivity[],
  overrides?: PlanOverrideMap,
  today: string = localToday(),
  customWorkouts: CustomWorkoutInput[] = [],
): MisdatedSession[] {
  if (!trainingPlan) return [];

  const graded = matchSessions(
    trainingPlan,
    activities,
    overrides,
    today,
    customWorkouts,
  );

  const discipline = trainingPlan.discipline;
  const byDate = new Map<string, StravaActivity[]>();
  for (const act of activities) {
    if (getDiscipline(act) !== discipline) continue;
    const day = act.start_date_local.split("T")[0];
    byDate.set(day, [...(byDate.get(day) ?? []), act]);
  }

  // An activity that already credits a session on its own date is spoken for.
  // Without this a single run could complete its own day's session AND be
  // offered as the rescue for the neighbouring day's.
  const claimed = new Set<number>();
  for (const s of graded) {
    if (s.status !== "completed" && s.status !== "partial") continue;
    for (const act of byDate.get(s.date) ?? []) claimed.add(act.id);
  }

  const found: MisdatedSession[] = [];

  // Earliest first, so when two missed sessions could both claim one run the
  // earlier session gets it rather than whichever happened to be iterated first.
  for (const session of [...graded].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (session.status !== "missed") continue;

    // Nearest day wins: a run the day after beats one two days before.
    const offsets: number[] = [];
    for (let d = 1; d <= MISDATE_WINDOW_DAYS; d++) offsets.push(-d, d);
    offsets.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);

    let picked: { act: StravaActivity; offset: number; confidence: "full" | "partial" } | null =
      null;

    for (const offset of offsets) {
      const onDay = (byDate.get(shiftDate(session.date, offset)) ?? []).filter(
        (act) => !claimed.has(act.id),
      );
      const ratio = (act: StravaActivity) =>
        session.km > 0 ? act.distance / 1000 / session.km : 0;

      // A full match on this day beats a partial on this day; only if neither
      // exists do we look a day further out.
      const full = onDay.find((act) => ratio(act) >= MISDATE_FULL_RATIO);
      if (full) {
        picked = { act: full, offset, confidence: "full" };
        break;
      }
      const partial = onDay.find((act) => ratio(act) >= MISDATE_PARTIAL_RATIO);
      if (partial && !picked) picked = { act: partial, offset, confidence: "partial" };
    }

    if (!picked) continue;

    claimed.add(picked.act.id);
    found.push({
      session,
      activity: {
        id: picked.act.id,
        name: picked.act.name,
        date: picked.act.start_date_local.split("T")[0],
        km: Math.round((picked.act.distance / 1000) * 10) / 10,
      },
      offsetDays: picked.offset,
      confidence: picked.confidence,
    });
  }

  return found;
}

/** How a finished (or in-progress) plan actually went. */
export interface PlanAdherence {
  completed: number;
  partial: number;
  missed: number;
  skipped: number;
  /** Sessions not yet due — zero once the plan is over. */
  remaining: number;
  total: number;
  plannedKm: number;
  actualKm: number;
}

/**
 * Roll the per-session grades up into one summary.
 *
 * Deliberately derived from matchSessions rather than counted separately, so
 * the headline number can never disagree with the rows it summarises — and so
 * skips keep being counted apart from misses, which is the distinction the
 * coach prompt already leans on.
 */
export function planAdherence(
  trainingPlan: TrainingPlan | null,
  activities: StravaActivity[],
  overrides?: PlanOverrideMap,
  today: string = localToday(),
  customWorkouts: CustomWorkoutInput[] = [],
): PlanAdherence {
  const sessions = matchSessions(
    trainingPlan,
    activities,
    overrides,
    today,
    customWorkouts,
  );

  const a: PlanAdherence = {
    completed: 0, partial: 0, missed: 0, skipped: 0,
    remaining: 0, total: sessions.length, plannedKm: 0, actualKm: 0,
  };

  for (const s of sessions) {
    a.plannedKm += s.km;
    a.actualKm += s.actualKm ?? 0;
    if (s.status === "completed") a.completed++;
    else if (s.status === "partial") a.partial++;
    else if (s.status === "missed") a.missed++;
    else if (s.status === "skipped") a.skipped++;
    else a.remaining++; // today / upcoming
  }

  a.plannedKm = Math.round(a.plannedKm * 10) / 10;
  a.actualKm = Math.round(a.actualKm * 10) / 10;
  return a;
}
