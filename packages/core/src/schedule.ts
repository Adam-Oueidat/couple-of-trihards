import { StravaActivity } from "./types/strava";
import {
  matchSessions,
  type CustomWorkoutInput,
  type PlanOverrideMap,
  type SessionStatus,
  type SessionType,
  type SessionWithStatus,
  type TrainingPlan,
} from "./plan";

/**
 * What is on the calendar, read as training load.
 *
 * The suggester used to see only what Strava had already recorded, so a hard
 * session the athlete had just put on today's calendar was invisible to
 * tomorrow's suggestions — and tomorrow cheerfully offered another one. These
 * helpers let scheduled sessions count before they happen.
 */

/** Session types that make a hard DAY, whether or not they carry intensity. */
const HARD_TYPES = new Set<SessionType>(["intervals", "tempo", "long", "time_trial", "race"]);

/** A run this long is a long run whatever it is called. */
export const LONG_RUN_KM = 16;

/**
 * Calendar workouts carry a free-text name and no type, so their intensity is
 * read from the name. Covers the names the suggester itself writes ("6 x 400 m",
 * "4 km tempo", "4 x 8 min threshold") and the usual ways athletes write theirs.
 */
const HARD_NAME =
  /\b(intervals?|repeats?|tempo|threshold|progressive|fartlek|hills?|sprints?|rolling|vo2(max)?|race|time trial|long run|hard)\b|\d+\s*x\s*\d/i;

/** A planned session that happened, or is still expected to. */
const LIVE_STATUSES = new Set<SessionStatus>(["completed", "partial", "today", "upcoming"]);

/** Not yet done: the session's load is still ahead of the athlete. */
const PENDING_STATUSES = new Set<SessionStatus>(["today", "upcoming"]);

export function disciplineOf(s: SessionWithStatus): "swim" | "ride" | "run" {
  // Plan sessions are run sessions: the plans this app ingests are run plans.
  return s.discipline ?? "run";
}

/** Whether a plan or calendar session makes a hard day. */
export function isHardSession(s: SessionWithStatus): boolean {
  const discipline = disciplineOf(s);
  // Swimming carries no impact load; a hard swim does not need a day's gap
  // before a run the way a hard run does.
  if (discipline === "swim") return false;
  if (discipline === "run" && s.km >= LONG_RUN_KM) return true;
  if (s.isCustom) return HARD_NAME.test(s.name);
  return HARD_TYPES.has(s.type);
}

export function isLive(s: SessionWithStatus): boolean {
  return LIVE_STATUSES.has(s.status);
}

export function isPending(s: SessionWithStatus): boolean {
  return PENDING_STATUSES.has(s.status);
}

export interface ScheduleInput {
  plan: TrainingPlan | null;
  activities: StravaActivity[];
  overrides?: PlanOverrideMap;
  customWorkouts?: CustomWorkoutInput[];
  today: string;
}

/** Plan sessions and calendar workouts together, each graded against Strava. */
export function scheduledSessions(input: ScheduleInput): SessionWithStatus[] {
  return matchSessions(
    input.plan,
    input.activities,
    input.overrides,
    input.today,
    input.customWorkouts ?? [],
  ).filter((s) => !s.hidden);
}

/**
 * A rough TSS for a session that has not happened yet, on the same scale as
 * estimateTSS: about one point per easy minute, more when the minutes are hard.
 */
export function expectedSessionTss(
  s: SessionWithStatus,
  durationMin?: number | null,
): number {
  const discipline = disciplineOf(s);
  const minutes =
    durationMin ??
    (s.km > 0
      ? discipline === "swim"
        ? s.km * 25
        : discipline === "ride"
          ? s.km * 2.4
          : s.km * 6
      : 45);

  // A long run is hard because of its minutes, which the duration already
  // counts; intensity sessions pack more load into each minute.
  const isRace = !s.isCustom && (s.type === "race" || s.type === "time_trial");
  const isLong = discipline === "run" && (s.km >= LONG_RUN_KM || (!s.isCustom && s.type === "long"));
  let factor = discipline === "ride" ? 0.8 : 1;
  if (isRace) factor *= 1.5;
  else if (!isLong && isHardSession(s)) factor *= 1.3;
  return Math.round(minutes * factor);
}

/**
 * Load that is on the calendar between `today` and the day before `until`, and
 * not yet done. Feed it to calcTrainingLoad to project Form to `until`.
 */
export function expectedLoadByDay(
  sessions: SessionWithStatus[],
  customWorkouts: CustomWorkoutInput[],
  today: string,
  until: string,
): Map<string, number> {
  const durations = new Map(customWorkouts.map((w) => [w.id, w.durationMin ?? null]));
  const out = new Map<string, number>();
  for (const s of sessions) {
    if (!isPending(s) || s.date < today || s.date >= until) continue;
    const tss = expectedSessionTss(s, s.isCustom ? durations.get(s.id) : null);
    out.set(s.date, (out.get(s.date) ?? 0) + tss);
  }
  return out;
}
