import { getDiscipline } from "./training";
import type { DetailedActivity, StravaActivity, StreamSet } from "./types/strava";

/**
 * Sport-specific metrics for one activity.
 *
 * A ride and a run are analysed with different numbers. A ride is read through
 * power: how hard (normalized power against FTP), how much (TSS, kJ), how
 * evenly (variability index), the best sustained efforts, and how the legs
 * turned over (pedalling cadence, time spent coasting). A run is read through
 * pace and form: grade-adjusted pace (so a hilly run is not mistaken for a slow
 * one), step cadence, how much climbing it carried, and run power when a foot
 * pod records it. Both get heart-rate drift against their own output — Pw:HR
 * for a ride, Pa:HR for a run — on a steady effort, where it means durability.
 *
 * Everything is derived from the streams when they exist and from Strava's
 * summary fields when they do not, so a manual or stream-less activity still
 * gets the averages Strava gave us.
 */

/**
 * The streams requested for every activity. One request costs the same
 * whatever it asks for, and Strava silently omits streams the device did not
 * record, so asking for the union is free: a run with a foot pod gets its
 * power, a ride without a power meter just has no `watts`.
 */
export const STREAM_KEYS = [
  "time",
  "distance",
  "heartrate",
  "velocity_smooth",
  "altitude",
  "cadence",
  "watts",
  "grade_smooth",
] as const;

/** The standard durations a power curve is read at. */
export const PEAK_POWER_WINDOWS: { label: string; seconds: number }[] = [
  { label: "5s", seconds: 5 },
  { label: "1min", seconds: 60 },
  { label: "5min", seconds: 300 },
  { label: "20min", seconds: 1200 },
  { label: "60min", seconds: 3600 },
];

/**
 * Coggan's seven power zones, as fractions of FTP. Each zone runs from its
 * floor up to the next zone's floor.
 */
export const POWER_ZONES: { name: string; floor: number }[] = [
  { name: "Active recovery", floor: 0 },
  { name: "Endurance", floor: 0.55 },
  { name: "Tempo", floor: 0.76 },
  { name: "Threshold", floor: 0.91 },
  { name: "VO2 max", floor: 1.06 },
  { name: "Anaerobic", floor: 1.21 },
  { name: "Neuromuscular", floor: 1.51 },
];

export interface PeakPower {
  label: string;
  seconds: number;
  watts: number;
}

export interface PowerZoneTime {
  zone: number; // 1-based
  name: string;
  seconds: number;
}

export interface RideMetrics {
  kind: "ride";
  avgPower: number | null;
  maxPower: number | null;
  normalizedPower: number | null;
  /** NP / average power. ~1.0 is a steady effort; above ~1.1 is surgy. */
  variabilityIndex: number | null;
  intensityFactor: number | null;
  tss: number | null;
  workKj: number | null;
  /** Average power per kilogram of body weight. */
  wattsPerKg: number | null;
  /** Pedalling cadence (rpm), counting only the time the cranks were turning. */
  avgCadence: number | null;
  /** Share of moving time spent not pedalling, 0-100. */
  coastingPct: number | null;
  peakPower: PeakPower[];
  powerZones: PowerZoneTime[] | null;
  /** Pw:HR drift, first half to second, in percent. Null unless the effort was steady. */
  decouplingPct: number | null;
  /** Whether the watts came from a power meter or Strava's estimate. */
  powerSource: "meter" | "estimated" | null;
  ftp: number | null;
}

export interface RunMetrics {
  kind: "run";
  /** Steps per minute (both feet). */
  avgCadence: number | null;
  /** Grade-adjusted speed, m/s: the flat-ground equivalent of the effort. */
  gradeAdjustedSpeed: number | null;
  /** Metres climbed per km — how hilly the run was. */
  climbPerKm: number | null;
  /** Run power, when a foot pod or watch records it. */
  avgPower: number | null;
  normalizedPower: number | null;
  /** Pa:HR drift, first half to second, in percent. Null unless the effort was steady. */
  decouplingPct: number | null;
}

export type ActivityMetrics = RideMetrics | RunMetrics;

export interface AthleteBasics {
  ftp?: number | null;
  weight?: number | null; // kg
}

// --------------------------------------------------------------------------
// Stream maths
// --------------------------------------------------------------------------

/**
 * A gap longer than this between two samples is a stop (auto-pause, a café,
 * a traffic light held long enough), not data to interpolate across.
 */
const MAX_GAP_SECONDS = 10;

/**
 * Resample a stream onto a one-second grid of moving time.
 *
 * Strava's `time` is irregular — smart recording logs every few seconds — and
 * every rolling average below assumes one value per second. Each sample is
 * held until the next one; a gap longer than MAX_GAP_SECONDS is dropped
 * entirely, so a long stop neither drags NP down nor counts as coasting.
 */
export function resampleToSeconds(time: number[], values: number[]): number[] {
  const out: number[] = [];
  const n = Math.min(time.length, values.length);
  for (let i = 0; i < n - 1; i++) {
    const gap = time[i + 1] - time[i];
    if (gap <= 0 || gap > MAX_GAP_SECONDS) continue;
    const v = values[i] ?? 0;
    for (let s = 0; s < gap; s++) out.push(v);
  }
  return out;
}

/** The highest mean over any `window` consecutive seconds, or null if too short. */
export function peakAverage(perSecond: number[], window: number): number | null {
  if (window <= 0 || perSecond.length < window) return null;
  let sum = 0;
  for (let i = 0; i < window; i++) sum += perSecond[i];
  let best = sum;
  for (let i = window; i < perSecond.length; i++) {
    sum += perSecond[i] - perSecond[i - window];
    if (sum > best) best = sum;
  }
  return best / window;
}

/**
 * Normalized power: the fourth-power mean of a 30-second rolling average.
 * It weights hard surges the way the body pays for them, so a surgy ride
 * reads harder than its average.
 */
export function normalizedPower(perSecond: number[]): number | null {
  const W = 30;
  if (perSecond.length < W) return null;
  let sum = 0;
  for (let i = 0; i < W; i++) sum += perSecond[i];
  let acc = (sum / W) ** 4;
  let count = 1;
  for (let i = W; i < perSecond.length; i++) {
    sum += perSecond[i] - perSecond[i - W];
    acc += (sum / W) ** 4;
    count++;
  }
  return (acc / count) ** 0.25;
}

function mean(xs: number[]): number | null {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function coefficientOfVariation(xs: number[]): number | null {
  const m = mean(xs);
  if (m === null || m === 0) return null;
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance) / m;
}

/** Below this, a drift figure says more about the warm-up than the athlete. */
const MIN_DRIFT_SECONDS = 20 * 60;

/**
 * Output-per-beat drift between the two halves of a session, in percent.
 * Positive means the second half cost more heartbeats for the same output.
 * The caller decides whether the effort was steady enough for this to mean
 * anything; an interval session drifts by construction.
 */
export function outputHrDrift(output: number[], hr: number[]): number | null {
  const n = Math.min(output.length, hr.length);
  if (n < MIN_DRIFT_SECONDS) return null;
  const mid = Math.floor(n / 2);
  const ratio = (from: number, to: number): number | null => {
    let out = 0;
    let beats = 0;
    for (let i = from; i < to; i++) {
      if (!hr[i] || hr[i] < 60) continue;
      out += output[i];
      beats += hr[i];
    }
    return beats > 0 && out > 0 ? out / beats : null;
  };
  const first = ratio(0, mid);
  const second = ratio(mid, n);
  if (first === null || second === null) return null;
  return round(((first - second) / first) * 100, 1);
}

function round(x: number, dp = 0): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

function roundOrNull(x: number | null | undefined, dp = 0): number | null {
  return x == null || !Number.isFinite(x) ? null : round(x, dp);
}

// --------------------------------------------------------------------------
// Rides
// --------------------------------------------------------------------------

/** Above this VI a ride was too surgy for Pw:HR drift to mean durability. */
const STEADY_RIDE_VI = 1.1;

export function rideMetrics(
  activity: StravaActivity,
  streams: StreamSet | null,
  athlete: AthleteBasics = {},
): RideMetrics {
  const ftp = athlete.ftp && athlete.ftp > 0 ? athlete.ftp : null;
  const time = streams?.time?.data;
  const rawWatts = streams?.watts?.data;
  const rawCadence = streams?.cadence?.data;
  const rawHr = streams?.heartrate?.data;

  const watts = time && rawWatts ? resampleToSeconds(time, rawWatts) : [];
  const cadence = time && rawCadence ? resampleToSeconds(time, rawCadence) : [];
  const hr = time && rawHr ? resampleToSeconds(time, rawHr) : [];

  const hasPowerStream = watts.length > 0;
  const avgPower = hasPowerStream ? mean(watts) : (activity.average_watts ?? null);
  const np = hasPowerStream
    ? normalizedPower(watts)
    : (activity.weighted_average_watts ?? null);
  const maxPower = hasPowerStream
    ? watts.reduce((a, b) => Math.max(a, b), 0)
    : (activity.max_watts ?? null);

  const workKj = hasPowerStream
    ? watts.reduce((a, b) => a + b, 0) / 1000
    : (activity.kilojoules ?? null);

  // Intensity is NP against FTP; TSS is that intensity squared over the hour.
  const durationS = hasPowerStream ? watts.length : activity.moving_time;
  const intensityFactor = np && ftp ? np / ftp : null;
  const tss =
    np && ftp && intensityFactor ? (durationS * np * intensityFactor) / (ftp * 3600) * 100 : null;
  const variabilityIndex = np && avgPower ? np / avgPower : null;

  // Coasting is zero cadence while moving; average cadence only counts the
  // pedalling, which is what an athlete means by "my cadence".
  const pedalling = cadence.filter((c) => c > 0);
  const avgCadence =
    cadence.length > 0 ? mean(pedalling) : (activity.average_cadence ?? null);
  const coastingPct =
    cadence.length > 0 ? ((cadence.length - pedalling.length) / cadence.length) * 100 : null;

  const peakPower: PeakPower[] = hasPowerStream
    ? PEAK_POWER_WINDOWS.flatMap(({ label, seconds }) => {
        const w = peakAverage(watts, seconds);
        return w === null ? [] : [{ label, seconds, watts: Math.round(w) }];
      })
    : [];

  const powerZones: PowerZoneTime[] | null =
    hasPowerStream && ftp
      ? POWER_ZONES.map((z, i) => {
          const lo = z.floor * ftp;
          const hi = i + 1 < POWER_ZONES.length ? POWER_ZONES[i + 1].floor * ftp : Infinity;
          return {
            zone: i + 1,
            name: z.name,
            seconds: watts.filter((w) => w >= lo && w < hi).length,
          };
        })
      : null;

  const steady = variabilityIndex !== null && variabilityIndex <= STEADY_RIDE_VI;
  const decouplingPct =
    hasPowerStream && hr.length > 0 && steady ? outputHrDrift(watts, hr) : null;

  const powerSource =
    avgPower == null ? null : activity.device_watts === false ? "estimated" : "meter";

  return {
    kind: "ride",
    avgPower: roundOrNull(avgPower),
    maxPower: roundOrNull(maxPower),
    normalizedPower: roundOrNull(np),
    variabilityIndex: roundOrNull(variabilityIndex, 2),
    intensityFactor: roundOrNull(intensityFactor, 2),
    tss: roundOrNull(tss),
    workKj: roundOrNull(workKj),
    wattsPerKg:
      avgPower && athlete.weight && athlete.weight > 0
        ? round(avgPower / athlete.weight, 2)
        : null,
    avgCadence: roundOrNull(avgCadence),
    coastingPct: roundOrNull(coastingPct),
    peakPower,
    powerZones,
    decouplingPct,
    powerSource,
    ftp,
  };
}

// --------------------------------------------------------------------------
// Runs
// --------------------------------------------------------------------------

/** Above this speed CV a run was intervals, and Pa:HR drift means nothing. */
const STEADY_RUN_SPEED_CV = 0.15;

export function runMetrics(
  activity: DetailedActivity | StravaActivity,
  streams: StreamSet | null,
): RunMetrics {
  const time = streams?.time?.data;
  const rawCadence = streams?.cadence?.data;
  const rawVel = streams?.velocity_smooth?.data;
  const rawHr = streams?.heartrate?.data;
  const rawWatts = streams?.watts?.data;

  // Strava records run cadence per leg; runners count both feet.
  const cadence = time && rawCadence ? resampleToSeconds(time, rawCadence) : [];
  const steps = cadence.filter((c) => c > 0).map((c) => c * 2);
  const avgCadence =
    steps.length > 0
      ? mean(steps)
      : activity.average_cadence
        ? activity.average_cadence * 2
        : null;

  // Strava already grade-adjusts each km split; time-weighting them gives the
  // whole run's flat-ground equivalent.
  const splits = "splits_metric" in activity ? (activity.splits_metric ?? []) : [];
  let gapTime = 0;
  let gapDist = 0;
  for (const s of splits) {
    if (!s.average_grade_adjusted_speed || s.moving_time <= 0) continue;
    gapTime += s.moving_time;
    gapDist += s.average_grade_adjusted_speed * s.moving_time;
  }
  const gradeAdjustedSpeed = gapTime > 0 ? gapDist / gapTime : null;

  const climbPerKm =
    activity.distance > 0 ? activity.total_elevation_gain / (activity.distance / 1000) : null;

  const watts = time && rawWatts ? resampleToSeconds(time, rawWatts) : [];
  const avgPower = watts.length > 0 ? mean(watts) : (activity.average_watts ?? null);
  const np = watts.length > 0 ? normalizedPower(watts) : null;

  const vel = time && rawVel ? resampleToSeconds(time, rawVel) : [];
  const hr = time && rawHr ? resampleToSeconds(time, rawHr) : [];
  const cv = coefficientOfVariation(vel.filter((v) => v > 0));
  const steady = cv !== null && cv < STEADY_RUN_SPEED_CV;
  const decouplingPct = vel.length > 0 && hr.length > 0 && steady ? outputHrDrift(vel, hr) : null;

  return {
    kind: "run",
    avgCadence: roundOrNull(avgCadence),
    gradeAdjustedSpeed: roundOrNull(gradeAdjustedSpeed, 3),
    climbPerKm: roundOrNull(climbPerKm, 1),
    avgPower: roundOrNull(avgPower),
    normalizedPower: roundOrNull(np),
    decouplingPct,
  };
}

/** The metrics for this activity's sport, or null for sports without any. */
export function activityMetrics(
  activity: DetailedActivity,
  streams: StreamSet | null,
  athlete: AthleteBasics = {},
): ActivityMetrics | null {
  const d = getDiscipline(activity);
  if (d === "ride") return rideMetrics(activity, streams, athlete);
  if (d === "run") return runMetrics(activity, streams);
  return null;
}

// --------------------------------------------------------------------------
// For the coach
// --------------------------------------------------------------------------

function paceFromSpeed(mps: number): string {
  const s = Math.round(1000 / mps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}/km`;
}

/** The metrics as prompt lines, omitting anything we could not compute. */
export function describeActivityMetrics(m: ActivityMetrics): string {
  const lines: string[] = [];
  if (m.kind === "ride") {
    const power = [
      m.avgPower != null ? `avg ${m.avgPower}W` : null,
      m.normalizedPower != null ? `NP ${m.normalizedPower}W` : null,
      m.maxPower != null ? `max ${m.maxPower}W` : null,
    ].filter(Boolean);
    if (power.length > 0) {
      lines.push(
        `Power: ${power.join(" | ")}${m.powerSource === "estimated" ? " (estimated by Strava, no power meter — treat loosely)" : ""}`,
      );
    } else {
      lines.push("No power data");
    }
    const load = [
      m.ftp != null ? `FTP ${m.ftp}W` : null,
      m.intensityFactor != null ? `IF ${m.intensityFactor}` : null,
      m.tss != null ? `TSS ${m.tss}` : null,
      m.variabilityIndex != null ? `VI ${m.variabilityIndex}` : null,
      m.workKj != null ? `work ${m.workKj}kJ` : null,
      m.wattsPerKg != null ? `${m.wattsPerKg} W/kg avg` : null,
    ].filter(Boolean);
    if (load.length > 0) lines.push(`Load: ${load.join(" | ")}`);
    if (m.avgCadence != null) {
      lines.push(
        `Cadence: ${m.avgCadence} rpm while pedalling` +
          (m.coastingPct != null ? ` | coasting ${m.coastingPct}% of moving time` : ""),
      );
    }
    if (m.peakPower.length > 0) {
      lines.push(`Peak power: ${m.peakPower.map((p) => `${p.label} ${p.watts}W`).join(" | ")}`);
    }
    if (m.powerZones) {
      const total = m.powerZones.reduce((a, z) => a + z.seconds, 0) || 1;
      lines.push(
        `Time in power zones: ${m.powerZones
          .filter((z) => z.seconds > 0)
          .map((z) => `Z${z.zone} ${z.name} ${Math.round((z.seconds / total) * 100)}%`)
          .join(" | ")}`,
      );
    }
    if (m.decouplingPct != null) lines.push(`Pw:HR decoupling (steady ride): ${m.decouplingPct}%`);
  } else {
    if (m.avgCadence != null) lines.push(`Cadence: ${m.avgCadence} spm`);
    if (m.gradeAdjustedSpeed != null)
      lines.push(`Grade-adjusted pace: ${paceFromSpeed(m.gradeAdjustedSpeed)}`);
    if (m.climbPerKm != null && m.climbPerKm >= 5) lines.push(`Climbing: ${m.climbPerKm} m/km`);
    if (m.avgPower != null)
      lines.push(
        `Run power: avg ${m.avgPower}W${m.normalizedPower != null ? ` | NP ${m.normalizedPower}W` : ""}`,
      );
    if (m.decouplingPct != null) lines.push(`Pa:HR decoupling (steady run): ${m.decouplingPct}%`);
  }
  return lines.join("\n");
}
