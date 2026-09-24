import { Discipline, StravaActivity, WeeklyVolume } from "./types/strava";

export function getDiscipline(activity: StravaActivity): Discipline {
  const t = activity.sport_type ?? activity.type;
  if (t === "Run" || t === "VirtualRun" || t === "TrailRun") return "run";
  if (t === "Ride" || t === "VirtualRide" || t === "GravelRide" || t === "MountainBikeRide" || t === "EBikeRide") return "ride";
  if (t === "Swim" || t === "OpenWaterSwim") return "swim";
  if (t === "WeightTraining" || t === "Crossfit" || t === "Workout" || t === "HighIntensityIntervalTraining")
    return "strength";
  return "other";
}

/**
 * Swim, ride and run: the sports whose heart rate and pace describe aerobic
 * fitness. Strength counts toward time and load but not toward those reads.
 */
export function isEnduranceDiscipline(d: Discipline): d is "run" | "ride" | "swim" {
  return d === "run" || d === "ride" || d === "swim";
}

// Today's calendar date (YYYY-MM-DD) built from local Y/M/D parts — NOT
// toISOString(), which emits the UTC date. In a negative-offset timezone (the
// Americas) the UTC clock has already rolled to tomorrow during the local
// evening, so toISOString() makes the app think it is a day ahead of the
// athlete: their Sunday session reads as "missed" and Monday's as "today" early.
// Reading local parts keeps "today" anchored to the athlete's wall clock.
export function localToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// The activity's wall-clock day as a Date anchored at local noon. Strava's
// start_date_local is the athlete's wall-clock time but carries a misleading
// trailing "Z"; `new Date(start_date_local)` reads it as UTC, so an evening
// activity shifts into the next day once the runtime (or browser) re-applies its
// offset — mis-bucketing it into the wrong week. Take the literal date part and
// anchor at noon so the wall-clock day survives regardless of timezone.
export function activityDay(startDateLocal: string): Date {
  return new Date(`${startDateLocal.split("T")[0]}T12:00:00`);
}

// Returns the local Monday (YYYY-MM-DD) of the week containing a given date.
// We shift to Monday in local time, then format from the local Y/M/D parts —
// NOT toISOString(), which would emit the UTC date and roll back a day in any
// positive-offset timezone (e.g. CEST: local Monday 00:00 is Sunday 22:00 UTC).
// That off-by-one would key activities to the wrong week and mislabel it.
export function getWeekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function groupByWeek(activities: StravaActivity[]): WeeklyVolume[] {
  const map = new Map<string, WeeklyVolume>();

  for (const act of activities) {
    const discipline = getDiscipline(act);
    if (discipline === "other") continue;

    const weekStart = getWeekStart(activityDay(act.start_date_local));

    if (!map.has(weekStart)) {
      map.set(weekStart, {
        weekStart,
        run: 0,
        ride: 0,
        swim: 0,
        runTime: 0,
        rideTime: 0,
        swimTime: 0,
        strengthTime: 0,
      });
    }

    const week = map.get(weekStart)!;
    const distKm = act.distance / 1000;
    const mins = act.moving_time / 60;

    if (discipline === "run") {
      week.run += distKm;
      week.runTime += mins;
    } else if (discipline === "ride") {
      week.ride += distKm;
      week.rideTime += mins;
    } else if (discipline === "swim") {
      // keep swim in meters
      week.swim += act.distance;
      week.swimTime += mins;
    } else if (discipline === "strength") {
      week.strengthTime += mins;
    }
  }

  return Array.from(map.values()).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

// One year of history. Fetching this much on first sync (then caching it) lets
// the CTL/ATL exponential averages warm up over a full season instead of
// cold-starting at 0 over a short window — so Fitness/Fatigue/Form read
// accurately rather than ramping up from nothing. This is used only for the
// calculations and the AI coach context, not for the activity lists the UI
// renders, which stay on their shorter display window.
export const TRAINING_HISTORY_WEEKS = 52;

// Acute/Chronic Training Load using 42-day window
// TSS proxy: duration_hours * RPE (we use suffer_score if available, else estimate)
export function estimateTSS(act: StravaActivity): number {
  if (act.suffer_score) return act.suffer_score;
  // Rough proxy: 1 TSS per minute of easy effort
  const mins = act.moving_time / 60;
  const discipline = getDiscipline(act);
  // Without a suffer score, a minute of lifting is not a minute of running:
  // most of a strength session is rest between sets.
  const intensityFactor = discipline === "ride" ? 0.8 : discipline === "strength" ? 0.6 : 1.0;
  return Math.round(mins * intensityFactor);
}

export interface TrainingLoadPoint {
  date: string;
  atl: number; // Acute Training Load (7-day)
  ctl: number; // Chronic Training Load (42-day)
  tsb: number; // Training Stress Balance (CTL - ATL)
  dailyTSS: number;
}

// `today` is an ISO date (YYYY-MM-DD), athlete-local where the caller knows the
// timezone, else the server's UTC date. The series runs through it — not just
// the last activity — so Form (TSB) decays forward and reflects current
// freshness. Days with no activity contribute 0 TSS, so CTL/ATL ebb naturally.
//
// `expectedTss` adds load that is scheduled but not yet done, by day. Passing it
// with a `today` in the future projects Form forward to that day — which is
// what "how fresh will I be on Thursday" actually needs.
export function calcTrainingLoad(
  activities: StravaActivity[],
  today: string = localToday(),
  expectedTss?: Map<string, number>,
): TrainingLoadPoint[] {
  // Planned load alone is enough to project from: a new athlete's first plan
  // still has a fitness curve.
  if (activities.length === 0 && !expectedTss?.size) return [];

  const dailyTSS = new Map<string, number>();
  for (const act of activities) {
    const day = act.start_date_local.split("T")[0];
    dailyTSS.set(day, (dailyTSS.get(day) ?? 0) + estimateTSS(act));
  }
  for (const [day, tss] of expectedTss ?? []) {
    dailyTSS.set(day, (dailyTSS.get(day) ?? 0) + tss);
  }

  const dates = Array.from(dailyTSS.keys()).sort();
  if (dates.length === 0) return [];

  const lastActivityDay = dates[dates.length - 1];
  // ISO date strings compare correctly lexicographically; extend to today
  // whenever it's later than the last logged activity.
  const endDay = today > lastActivityDay ? today : lastActivityDay;
  // Walk the day range strictly in UTC. Stepping with the *local* setDate/getDate
  // drifts the cursor off midnight across a spring-forward DST transition (the
  // retained wall-clock keeps the lost hour), so by summer the cursor sits at
  // 01:00 UTC while `end` is UTC midnight — and `cursor <= end` then drops the
  // final day, silently losing the most recent activity's load. Anchoring both
  // ends at explicit UTC midnight and stepping with setUTCDate is DST-proof.
  const end = new Date(`${endDay}T00:00:00Z`);
  const allDays: string[] = [];
  const cursor = new Date(`${dates[0]}T00:00:00Z`);
  while (cursor <= end) {
    allDays.push(cursor.toISOString().split("T")[0]);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const points: TrainingLoadPoint[] = [];
  let ctl = 0;
  let atl = 0;
  const ctlDecay = Math.exp(-1 / 42);
  const atlDecay = Math.exp(-1 / 7);

  for (const day of allDays) {
    const tss = dailyTSS.get(day) ?? 0;
    ctl = ctl * ctlDecay + tss * (1 - ctlDecay);
    atl = atl * atlDecay + tss * (1 - atlDecay);
    points.push({
      date: day,
      atl: Math.round(atl * 10) / 10,
      ctl: Math.round(ctl * 10) / 10,
      tsb: Math.round((ctl - atl) * 10) / 10,
      dailyTSS: tss,
    });
  }

  return points;
}

// Round to whole seconds BEFORE splitting into minutes, so the carry lands in
// the minutes. Flooring the minutes first and rounding the leftover seconds
// separately lets the two halves disagree: 299.6 s/km floors to 4 min, and the
// remaining 59.6 s rounds to 60, with nothing to carry it — printing "4:60/km"
// for what is really 5:00/km. Every m:ss in the app goes through here.
export function formatSecondsAsClock(seconds: number): string {
  const total = Math.round(seconds);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

export function formatDuration(minutes: number): string {
  // Same carry rule as formatSecondsAsClock, in h/m: 119.6 min is 2h 0m, not
  // "1h 60m".
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatPace(activity: StravaActivity): string {
  if (activity.moving_time === 0 || activity.distance === 0) return "-";
  const discipline = getDiscipline(activity);
  if (discipline === "run") {
    const secPerKm = activity.moving_time / (activity.distance / 1000);
    return `${formatSecondsAsClock(secPerKm)}/km`;
  }
  if (discipline === "ride") {
    const kmh = (activity.distance / 1000) / (activity.moving_time / 3600);
    return `${kmh.toFixed(1)} km/h`;
  }
  if (discipline === "swim") {
    const secPer100m = activity.moving_time / (activity.distance / 100);
    return `${formatSecondsAsClock(secPer100m)}/100m`;
  }
  return "-";
}
