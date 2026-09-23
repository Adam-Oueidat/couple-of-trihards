import { StravaActivity } from "./types/strava";
import { getDiscipline } from "./training";
import { shiftDays, type ZoneModel } from "./quality";
import type { QualityProfile } from "./quality-recap";
import { scheduledSessions, type ScheduleInput } from "./schedule";

/**
 * The athlete's run threshold pace, and the evidence behind it.
 *
 * Threshold here is the pace sustainable for about an hour — the anchor the
 * workout charts draw at 100%. It is only ever estimated from an effort that
 * actually reached threshold, and every estimate says which session it came
 * from, so a number on a chart can be traced back and argued with.
 *
 * The rules, in the order they matter:
 * - A race or time trial sets it. Those are the efforts that are all-out by
 *   definition; nothing else is.
 * - A steady run held at or above threshold heart rate can RAISE it, never
 *   lower it. A newer, faster effort at that heart rate means fitness moved;
 *   a slower one is far more often heat, hills or fatigue than lost fitness.
 * - Evidence older than THRESHOLD_EVIDENCE_DAYS expires. An estimate from a
 *   race four months ago describes somebody else.
 *
 * Deliberately deterministic: the coach and the analyses quote this number,
 * they do not set it. A model reading "felt strong" into a new threshold is
 * exactly the kind of invented figure a chart must never print.
 */

export type ThresholdSource = "race" | "time-trial" | "steady-effort";

export interface RunThreshold {
  secPerKm: number;
  source: ThresholdSource;
  /** The session the estimate came from. */
  activityName: string;
  activityId: number;
  date: string;
}

export const THRESHOLD_EVIDENCE_DAYS = 84;

/**
 * Riegel's exponent. Time scales with distance^1.06, so speed at duration T
 * scales with T^(-0.06/1.06) — how much slower a runner goes when an effort
 * lasts longer. Standard in race-equivalence calculators.
 */
const RIEGEL = 1.06;
const THRESHOLD_SEC = 3600;

/** Races outside this range say little about an hour's effort. */
const RACE_MIN_SEC = 12 * 60;
const RACE_MAX_SEC = 2 * 3600;
/** A steady effort shorter than this is a rep; longer is a long run drifting up. */
const STEADY_MIN_SEC = 20 * 60;
const STEADY_MAX_SEC = 70 * 60;

/** Pace (s/km) sustainable for an hour, from one effort's distance and time. */
export function thresholdPaceFrom(distanceM: number, seconds: number): number {
  const speed = distanceM / seconds;
  const hourSpeed = speed * Math.pow(THRESHOLD_SEC / seconds, -(RIEGEL - 1) / RIEGEL);
  return Math.round(1000 / hourSpeed);
}

function dayOf(a: StravaActivity): string {
  return a.start_date_local.split("T")[0];
}

export interface ThresholdInput extends ScheduleInput {
  zones: ZoneModel;
  profiles?: QualityProfile[];
}

export function estimateRunThreshold(input: ThresholdInput): RunThreshold | null {
  const from = shiftDays(input.today, -THRESHOLD_EVIDENCE_DAYS);
  const runs = input.activities.filter(
    (a) => getDiscipline(a) === "run" && dayOf(a) >= from && dayOf(a) <= input.today,
  );

  // Race days, from the plan: a completed session of type race or time trial.
  // Strava's own race tag counts too, when the athlete set it.
  const planned = new Map<string, "race" | "time-trial">();
  for (const s of scheduledSessions(input)) {
    if (s.isCustom || (s.status !== "completed" && s.status !== "partial")) continue;
    if (s.type === "race") planned.set(s.date, "race");
    else if (s.type === "time_trial" && !planned.has(s.date)) planned.set(s.date, "time-trial");
  }

  const races: RunThreshold[] = [];
  for (const a of runs) {
    const kind = a.workout_type === 1 ? "race" : planned.get(dayOf(a));
    if (!kind || a.moving_time < RACE_MIN_SEC || a.moving_time > RACE_MAX_SEC) continue;
    // A race day can hold a warm-up jog too; the race is the longest run on it.
    const sameDay = runs.filter((r) => dayOf(r) === dayOf(a));
    if (sameDay.some((r) => r.moving_time > a.moving_time)) continue;
    races.push({
      secPerKm: thresholdPaceFrom(a.distance, a.moving_time),
      source: kind,
      activityName: a.name,
      activityId: a.id,
      date: dayOf(a),
    });
  }
  races.sort((a, b) => b.date.localeCompare(a.date));
  const base = races[0] ?? null;

  // Steady efforts at threshold heart rate. Needs real zones: without a Z4
  // floor there is no way to say an effort reached threshold.
  const steady: RunThreshold[] = [];
  const thresholdHr = input.zones.source === "none" ? null : input.zones.floors[3];
  if (thresholdHr) {
    const intervals = new Set(
      (input.profiles ?? [])
        .filter((p) => p.structure?.kind === "intervals")
        .map((p) => p.activityId),
    );
    const raceIds = new Set(races.map((r) => r.activityId));
    for (const a of runs) {
      if (raceIds.has(a.id) || intervals.has(String(a.id))) continue;
      if (a.moving_time < STEADY_MIN_SEC || a.moving_time > STEADY_MAX_SEC) continue;
      if (!a.average_heartrate || a.average_heartrate < thresholdHr) continue;
      steady.push({
        secPerKm: thresholdPaceFrom(a.distance, a.moving_time),
        source: "steady-effort",
        activityName: a.name,
        activityId: a.id,
        date: dayOf(a),
      });
    }
  }

  // Raise only: a steady effort replaces the race estimate when it is at least
  // as recent and faster. With no race in the window, the fastest one stands.
  const raisers = steady.filter((s) => !base || (s.date >= base.date && s.secPerKm < base.secPerKm));
  const best = raisers.sort((a, b) => a.secPerKm - b.secPerKm)[0];
  return best ?? base;
}

const SOURCE_LABEL: Record<ThresholdSource, string> = {
  race: "race",
  "time-trial": "time trial",
  "steady-effort": "steady effort at threshold heart rate",
};

/** "4:27/km, estimated from Copenhagen Half Marathon (race, 2026-09-20)". */
export function describeRunThreshold(t: RunThreshold, formatPace: (s: number) => string): string {
  return `${formatPace(t.secPerKm)}/km, estimated from ${t.activityName} (${SOURCE_LABEL[t.source]}, ${t.date})`;
}
