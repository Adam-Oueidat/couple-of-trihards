import { Discipline, StravaActivity, WeeklyVolume } from "./types/strava";

export function getDiscipline(activity: StravaActivity): Discipline {
  const t = activity.sport_type ?? activity.type;
  if (t === "Run" || t === "VirtualRun" || t === "TrailRun") return "run";
  if (t === "Ride" || t === "VirtualRide" || t === "GravelRide" || t === "MountainBikeRide" || t === "EBikeRide") return "ride";
  if (t === "Swim" || t === "OpenWaterSwim") return "swim";
  return "other";
}

// Returns the ISO Monday of the week containing a given date
export function getWeekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().split("T")[0];
}

export function groupByWeek(activities: StravaActivity[]): WeeklyVolume[] {
  const map = new Map<string, WeeklyVolume>();

  for (const act of activities) {
    const discipline = getDiscipline(act);
    if (discipline === "other") continue;

    const weekStart = getWeekStart(new Date(act.start_date_local));

    if (!map.has(weekStart)) {
      map.set(weekStart, {
        weekStart,
        run: 0,
        ride: 0,
        swim: 0,
        runTime: 0,
        rideTime: 0,
        swimTime: 0,
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
  const intensityFactor = discipline === "ride" ? 0.8 : 1.0;
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
export function calcTrainingLoad(
  activities: StravaActivity[],
  today: string = new Date().toISOString().split("T")[0],
): TrainingLoadPoint[] {
  if (activities.length === 0) return [];

  const dailyTSS = new Map<string, number>();
  for (const act of activities) {
    const day = act.start_date_local.split("T")[0];
    dailyTSS.set(day, (dailyTSS.get(day) ?? 0) + estimateTSS(act));
  }

  const dates = Array.from(dailyTSS.keys()).sort();
  if (dates.length === 0) return [];

  const start = new Date(dates[0]);
  const lastActivityDay = dates[dates.length - 1];
  // ISO date strings compare correctly lexicographically; extend to today
  // whenever it's later than the last logged activity.
  const end = new Date(today > lastActivityDay ? today : lastActivityDay);
  const allDays: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    allDays.push(cursor.toISOString().split("T")[0]);
    cursor.setDate(cursor.getDate() + 1);
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

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatPace(activity: StravaActivity): string {
  if (activity.moving_time === 0 || activity.distance === 0) return "-";
  const discipline = getDiscipline(activity);
  if (discipline === "run") {
    const secPerKm = activity.moving_time / (activity.distance / 1000);
    const min = Math.floor(secPerKm / 60);
    const sec = Math.round(secPerKm % 60);
    return `${min}:${sec.toString().padStart(2, "0")}/km`;
  }
  if (discipline === "ride") {
    const kmh = (activity.distance / 1000) / (activity.moving_time / 3600);
    return `${kmh.toFixed(1)} km/h`;
  }
  if (discipline === "swim") {
    const secPer100m = activity.moving_time / (activity.distance / 100);
    const min = Math.floor(secPer100m / 60);
    const sec = Math.round(secPer100m % 60);
    return `${min}:${sec.toString().padStart(2, "0")}/100m`;
  }
  return "-";
}
