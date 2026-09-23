import { localToday } from "./training";
import { shiftDays } from "./quality";
import type { SessionWithStatus } from "./plan";
import {
  isHardSession,
  isPending,
  scheduledSessions,
} from "./schedule";
import {
  easyRun,
  readAthleteState,
  weekdayOf,
  type SuggestedSession,
  type SuggestInput,
} from "./suggest";

/**
 * What adding a hard session does to the days around it.
 *
 * Picking intervals for Tuesday is only half a decision when Wednesday already
 * holds a progressive long run. This finds those clashes and proposes what to
 * do about each — it never changes anything itself. The athlete confirms, and
 * only then does the calendar move.
 */

/**
 * - `move`: reschedule the other session to a day with room around it.
 * - `ease`: keep it on the calendar as skipped, and put an easy run there.
 * - `replace`: the pick takes its place (same day only).
 * - `keep`: leave everything as it is.
 */
export type ConflictAction = "move" | "ease" | "replace" | "keep";

export interface ConflictOption {
  action: ConflictAction;
  /** Button text. */
  label: string;
  /** What exactly will happen, in one sentence. */
  detail: string;
  /** For `move`: where the session goes. */
  newDate?: string;
  /** For `ease`: the easy session that takes its place. */
  replacement?: SuggestedSession;
}

export interface ScheduleConflict {
  sessionId: string;
  /** A session from the uploaded plan, or a workout added on the calendar. */
  source: "plan" | "calendar";
  name: string;
  date: string;
  /** Needed to write a plan override, which is keyed by the plan's own date. */
  originalDate: string;
  relation: "same-day" | "day-before" | "day-after";
  message: string;
  /** Recommended first; `keep` is always offered and always last. */
  options: ConflictOption[];
}

/** Suggestion kinds that make a hard day. Swims carry no impact load. */
export function isHardSuggestion(session: SuggestedSession): boolean {
  if (session.discipline === "swim") return false;
  return ["intervals", "vo2", "tempo", "long"].includes(session.kind);
}

/** How far a clashing session may be pushed before moving it stops making sense. */
const MAX_MOVE_DAYS = 3;

const SHORT_WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });

function shortDay(date: string): string {
  return SHORT_WEEKDAY.format(new Date(`${date}T12:00:00Z`));
}

/**
 * The first day after `from` that can take `moving` without creating a new
 * clash: nothing else on it, no hard session either side, and before the race.
 */
function findMoveTarget(
  moving: SessionWithStatus,
  sessions: SessionWithStatus[],
  pickDate: string,
  raceDate: string | null,
): string | null {
  const others = sessions.filter((s) => s.id !== moving.id && s.status !== "skipped");
  const hardOn = (day: string) =>
    day === pickDate || others.some((s) => s.date === day && isHardSession(s));

  for (let i = 1; i <= MAX_MOVE_DAYS; i++) {
    const day = shiftDays(moving.date, i);
    if (raceDate && day >= raceDate) return null;
    if (others.some((s) => s.date === day)) continue;
    if (hardOn(shiftDays(day, -1)) || hardOn(shiftDays(day, 1))) continue;
    return day;
  }
  return null;
}

/**
 * Hard sessions within a day of `pick` that it would sit back to back with,
 * each with the changes that would fix it. Empty when the pick is not hard.
 */
export function findScheduleConflicts(
  input: SuggestInput,
  pick: SuggestedSession,
): ScheduleConflict[] {
  if (!isHardSuggestion(pick)) return [];

  const today = input.today ?? localToday();
  const date = input.date ?? today;
  const sessions = scheduledSessions({
    plan: input.plan,
    activities: input.activities,
    overrides: input.overrides,
    customWorkouts: input.customWorkouts,
    today,
  });
  const raceDate = input.plan?.raceDate ?? null;
  const easy = easyRun(readAthleteState(input));

  const relations: Record<string, ScheduleConflict["relation"]> = {
    [shiftDays(date, -1)]: "day-before",
    [date]: "same-day",
    [shiftDays(date, 1)]: "day-after",
  };

  const conflicts: ScheduleConflict[] = [];
  for (const s of sessions) {
    const relation = relations[s.date];
    if (!relation || s.status === "skipped" || s.status === "missed" || !isHardSession(s)) {
      continue;
    }

    const source = s.isCustom ? "calendar" : "plan";
    const day = weekdayOf(s.date);
    const keep: ConflictOption = {
      action: "keep",
      label: "Keep both",
      detail: "Nothing else on your calendar changes.",
    };
    const isRace = !s.isCustom && (s.type === "race" || s.type === "time_trial");

    let message: string;
    const options: ConflictOption[] = [];

    if (!isPending(s)) {
      // Already done: nothing to rearrange, but the athlete should know.
      message = `You already did "${s.name}" on ${day}. Another hard day straight after it is the pattern that turns a good block into an injury.`;
    } else if (isRace) {
      message =
        relation === "same-day"
          ? `${day} is race day ("${s.name}").`
          : `"${s.name}" is on ${day}. A hard session ${relation === "day-after" ? "the day before" : "the day after"} a race costs you on race day.`;
    } else if (relation === "same-day") {
      message = `"${s.name}" is already on ${day}. Doing both makes one very hard day; replacing it keeps the week's load where it was.`;
      options.push({
        action: "replace",
        label: "Replace it",
        detail:
          source === "plan"
            ? `"${s.name}" is marked skipped, with your pick as the reason.`
            : `"${s.name}" comes off your calendar.`,
      });
    } else {
      message = `"${s.name}" is on ${day}, the ${relation === "day-after" ? "day after" : "day before"}. Two hard days back to back is how a good block turns into an injury.`;
      if (relation === "day-after") {
        const target = findMoveTarget(s, sessions, date, raceDate);
        if (target) {
          options.push({
            action: "move",
            label: `Move to ${shortDay(target)}`,
            detail: `"${s.name}" moves to ${weekdayOf(target)}, with an easier day before it.`,
            newDate: target,
          });
        }
      }
      options.push({
        action: "ease",
        label: "Swap for an easy run",
        detail:
          source === "plan"
            ? `"${s.name}" stays on the plan as skipped, and ${easy.name} goes on ${day} instead.`
            : `"${s.name}" is replaced by ${easy.name} on ${day}.`,
        replacement: easy,
      });
    }

    options.push(keep);
    conflicts.push({
      sessionId: s.id,
      source,
      name: s.name,
      date: s.date,
      originalDate: s.originalDate,
      relation,
      message,
      options,
    });
  }

  return conflicts.sort((a, b) => a.date.localeCompare(b.date));
}
