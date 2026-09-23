import {
  TRAINING_HISTORY_WEEKS,
  BLOCK_DAYS,
  bucketHistogram,
  calcTrainingLoad,
  expectedLoadByDay,
  findScheduleConflicts,
  observedMaxHr,
  resolveZoneModel,
  scheduledSessions,
  sessionNote,
  shiftDays,
  sumHistograms,
  weekdayOf,
  type ConflictAction,
  type SuggestedSession,
  type SuggestInput,
  type SuggestionKind,
} from "@trihards/core";
import {
  getActivitiesWithDailySync,
  getAthleteDetail,
  getAthleteZones,
  type StravaIdentity,
} from "./strava";
import { getActiveTrainingPlan } from "./training-plans";
import { getOverrides, setOverride, validateOverrideInput } from "./plan-overrides";
import {
  addWorkout,
  deleteWorkout,
  getWorkouts,
  updateWorkout,
  validateWorkoutInput,
  type CustomWorkout,
} from "./workouts";
import { getQualityProfiles } from "./quality-scan";
import { resolveToday } from "./coach-dates";

/**
 * Everything the suggester reads, for the day being planned.
 *
 * Shared by the ranking and by the add-to-calendar flow, so the clashes an
 * athlete is asked to confirm are computed from exactly the state the ranking
 * saw. `requested` is only honoured from today onward: a day that has already
 * gone cannot be acted on.
 */
export async function loadSuggestInput(
  identity: StravaIdentity,
  requested: string | null,
): Promise<SuggestInput & { today: string; date: string }> {
  const [{ activities }, active, overrides, workouts, profiles, zones, athlete] =
    await Promise.all([
      getActivitiesWithDailySync(identity, TRAINING_HISTORY_WEEKS),
      getActiveTrainingPlan(identity.userId),
      getOverrides(identity.userId),
      getWorkouts(identity.userId),
      getQualityProfiles(identity.userId),
      getAthleteZones(identity).catch(() => null),
      getAthleteDetail(identity).catch(() => null),
    ]);

  const today = resolveToday(undefined, activities);
  const date = requested && requested >= today ? requested : today;
  const plan = active?.plan ?? null;

  const zoneModel = resolveZoneModel(zones, observedMaxHr(activities));

  // Measured time in zone over the recent block, when a scan has produced it.
  // Only trustworthy traces vote — a session whose strap dropped for half the
  // run would understate a zone and could talk the ranking out of a real gap.
  const mixFrom = shiftDays(today, -(BLOCK_DAYS - 1));
  const usable = profiles.filter(
    (p) => p.hrSeconds && p.date >= mixFrom && (p.hrCoverage ?? 0) >= 0.8,
  );
  const zoneSeconds =
    usable.length > 0
      ? bucketHistogram(sumHistograms(usable.map((p) => p.hrSeconds!)), zoneModel).seconds
      : null;

  // Form on the day being planned, not today: whatever is on the calendar in
  // between is load the athlete will be carrying by then.
  const sessions = scheduledSessions({ plan, activities, overrides, customWorkouts: workouts, today });
  const expected = expectedLoadByDay(sessions, workouts, today, date);

  return {
    activities,
    trainingLoad: calcTrainingLoad(activities, date, expected),
    plan,
    overrides,
    customWorkouts: workouts,
    profiles,
    zones: zoneModel,
    zoneSeconds,
    athlete: { ftp: athlete?.ftp ?? null, weight: athlete?.weight ?? null },
    today,
    date,
  };
}

const KINDS: readonly SuggestionKind[] = [
  "rest",
  "recovery",
  "easy",
  "long",
  "tempo",
  "intervals",
  "vo2",
];

/**
 * A suggested session posted back by the client. Only the fields that decide
 * clashes and what is written to the calendar are checked; the rest is display.
 */
export function validateSuggestedSession(input: unknown): SuggestedSession {
  const s = input as Record<string, unknown>;
  if (!s || typeof s !== "object") throw new Error("session required");
  if (!KINDS.includes(s.kind as SuggestionKind)) throw new Error("unknown session kind");
  const workout = validateWorkoutInput({ ...s, date: "2000-01-01" });
  const steps = Array.isArray(s.steps)
    ? s.steps
        .filter(
          (x): x is { label: string; detail: string } =>
            !!x && typeof x.label === "string" && typeof x.detail === "string",
        )
        .slice(0, 12)
    : [];
  return {
    name: workout.name,
    discipline: workout.discipline,
    kind: s.kind as SuggestionKind,
    distanceKm: workout.distanceKm,
    durationMin: workout.durationMin ?? 0,
    steps,
    summary: typeof s.summary === "string" ? s.summary.slice(0, 500) : "",
  };
}

export type Resolutions = Record<string, ConflictAction>;

export function validateResolutions(input: unknown): Resolutions {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid resolutions");
  const out: Resolutions = {};
  for (const [id, action] of Object.entries(input as Record<string, unknown>)) {
    if (action !== "move" && action !== "ease" && action !== "replace" && action !== "keep") {
      throw new Error(`Unknown action for ${id}`);
    }
    out[id] = action;
  }
  return out;
}

export class StaleConflictError extends Error {}

export interface AcceptResult {
  workout: CustomWorkout;
  /** One line per change made, for the athlete to read back. */
  changes: string[];
}

function sessionInput(session: SuggestedSession, date: string) {
  return {
    date,
    discipline: session.discipline,
    name: session.name,
    distanceKm: session.distanceKm,
    durationMin: session.durationMin || undefined,
    notes: sessionNote(session),
  };
}

/**
 * Put `session` on the calendar and apply the changes the athlete confirmed.
 *
 * The clashes are recomputed here rather than trusted from the client, and a
 * choice is honoured only if it is still on offer: the calendar may have
 * changed since the athlete was asked, and a move target picked against the
 * old calendar could land on a new clash.
 */
export async function acceptSuggestion(
  userId: string,
  input: SuggestInput & { date: string },
  session: SuggestedSession,
  resolutions: Resolutions,
): Promise<AcceptResult> {
  const conflicts = findScheduleConflicts(input, session);

  const plan = conflicts.map((c) => {
    // Every clash needs an answer the athlete actually gave. One they were
    // never shown (it appeared after they were asked) is not quietly "kept".
    const action = resolutions[c.sessionId];
    const option = c.options.find((o) => o.action === action);
    if (!action || !option) {
      throw new StaleConflictError(
        `Your calendar changed around "${c.name}". Look at the options again.`,
      );
    }
    return { conflict: c, option };
  });

  const workout = await addWorkout(userId, validateWorkoutInput(sessionInput(session, input.date)), "athlete");
  const changes: string[] = [`Added ${session.name} on ${weekdayOf(input.date)}.`];

  const pickedOn = `${session.name} on ${weekdayOf(input.date)}`;
  for (const { conflict: c, option } of plan) {
    if (option.action === "keep") continue;

    if (c.source === "plan") {
      // Rebuild the whole row: setOverride writes every field, so anything the
      // athlete already changed on this session (a rename, an earlier move)
      // has to be carried over or it would be wiped.
      const existing = input.overrides?.[c.sessionId];
      const base = {
        sessionId: c.sessionId,
        originalDate: c.originalDate,
        newDate: existing?.newDate ?? c.originalDate,
        reason: existing?.reason,
        hidden: existing?.hidden,
        skipped: existing?.skipped,
        skipReason: existing?.skipReason,
        name: existing?.name,
        type: existing?.type,
        km: existing?.km,
      };
      if (option.action === "move") {
        await setOverride(
          userId,
          validateOverrideInput({
            ...base,
            newDate: option.newDate,
            reason: `Moved to leave an easy day after ${pickedOn}`,
          }),
        );
        changes.push(`Moved ${c.name} to ${weekdayOf(option.newDate!)}.`);
      } else {
        await setOverride(
          userId,
          validateOverrideInput({
            ...base,
            skipped: true,
            skipReason:
              option.action === "replace"
                ? `Replaced by ${session.name}`
                : `Swapped for an easy day after ${pickedOn}`,
          }),
        );
        changes.push(`Marked ${c.name} as skipped.`);
      }
    } else if (option.action === "move") {
      await updateWorkout(userId, c.sessionId, { date: option.newDate });
      changes.push(`Moved ${c.name} to ${weekdayOf(option.newDate!)}.`);
    } else {
      await deleteWorkout(userId, c.sessionId);
      changes.push(`Removed ${c.name} from your calendar.`);
    }

    if (option.action === "ease" && option.replacement) {
      await addWorkout(
        userId,
        validateWorkoutInput(sessionInput(option.replacement, c.date)),
        "athlete",
      );
      changes.push(`Added ${option.replacement.name} on ${weekdayOf(c.date)}.`);
    }
  }

  return { workout, changes };
}
