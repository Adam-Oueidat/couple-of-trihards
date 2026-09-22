import { Discipline, Lap, StravaActivity, StreamSet, AthleteZones } from "./types/strava";
import { getDiscipline, getWeekStart } from "./training";

/**
 * Training *quality* primitives — heart rate, pace and session structure.
 *
 * The recap module next door answers "how much": volume, consistency, ramp
 * rate, adherence. Everything here answers "how well", which needs the two
 * channels that module never touches. Kept separate because the inputs differ:
 * recap runs on summary activities alone, while most of this runs on per-lap
 * and per-stream data that has to be fetched and derived first.
 */

// ---------------------------------------------------------------------------
// Zone model
// ---------------------------------------------------------------------------

export type ZoneSource =
  | "strava-custom"
  | "strava-default"
  | "estimated-max"
  | "none";

export interface ZoneModel {
  /** Lower bound of each zone. floors[0] is always 0. */
  floors: [number, number, number, number, number];
  source: ZoneSource;
  /** The max HR the model rests on. Reported in the UI, never guessed at. */
  maxHr: number | null;
}

export const NO_ZONES: ZoneModel = {
  floors: [0, 0, 0, 0, 0],
  source: "none",
  maxHr: null,
};

/**
 * Strava's own default zone split, as fractions of max HR.
 *
 * Used for the fallback so an athlete whose zones had to be estimated sees the
 * same *shape* of chart as one whose zones we fetched — otherwise the two
 * classes of athlete are not comparable to each other or to their own history.
 * Sanity check against a real athlete: a 220 max gives 132/165/183/198 here,
 * against the 133/165/182/198 Strava actually stored for them.
 */
const DEFAULT_ZONE_FRACTIONS = [0.6, 0.75, 0.83, 0.9] as const;

/**
 * The max HR worth trusting from summary data: the SECOND highest reading, not
 * the highest.
 *
 * A single strap dropout or a cross-talk spike from someone else's monitor
 * reads as one absurd value, and using the maximum would let that one artefact
 * drag every derived zone floor up by ten percent for the rest of the year. No
 * artefact survives being the second highest of a season's readings.
 */
export function observedMaxHr(activities: StravaActivity[]): number | null {
  const maxima = activities
    .filter((a) => getDiscipline(a) !== "other" && a.max_heartrate)
    .map((a) => a.max_heartrate!)
    .sort((a, b) => b - a);
  if (maxima.length === 0) return null;
  return maxima[1] ?? maxima[0];
}

export function resolveZoneModel(
  zones: AthleteZones | null,
  observedMax: number | null,
): ZoneModel {
  const hr = zones?.heart_rate;
  if (hr?.zones && hr.zones.length >= 5) {
    const floors = hr.zones.slice(0, 5).map((z) => z.min);
    return {
      floors: floors as ZoneModel["floors"],
      source: hr.custom_zones ? "strava-custom" : "strava-default",
      maxHr: observedMax,
    };
  }
  if (observedMax && observedMax > 0) {
    return {
      // Five floors: a literal 0, then one per fraction. Slicing a fraction off
      // here shifts every zone down one and silently puts Z2's floor where Z3's
      // belongs.
      floors: [
        0,
        ...DEFAULT_ZONE_FRACTIONS.map((f) => Math.round(observedMax * f)),
      ] as unknown as ZoneModel["floors"],
      source: "estimated-max",
      maxHr: observedMax,
    };
  }
  return NO_ZONES;
}

/** 1-5. A heart rate exactly on a floor belongs to the higher zone. */
export function hrZone(bpm: number, model: ZoneModel): number {
  if (model.source === "none") return 0;
  let zone = 1;
  for (let i = 1; i < 5; i++) {
    if (bpm >= model.floors[i]) zone = i + 1;
  }
  return zone;
}

/**
 * True only when Z5 is genuinely out of reach — its floor sits above the
 * highest heart rate the athlete has ever recorded, so a 0% Z5 reading would
 * be an artefact of the zone model rather than a fact about their training.
 *
 * Deliberately narrow. An athlete who touches Z5 once a year has correct zones
 * and a training-design question, not a configuration problem, and reporting
 * the latter would send them to fix something that is not broken.
 */
export function zonesUnreachable(
  model: ZoneModel,
  allTimeMaxHr: number | null,
): boolean {
  if (model.source === "none" || allTimeMaxHr === null) return false;
  return model.floors[4] > allTimeMaxHr;
}

// ---------------------------------------------------------------------------
// Time in zone
// ---------------------------------------------------------------------------

export const HR_HIST_MIN = 90;
export const HR_HIST_MAX = 220;
export const HR_HIST_LEN = HR_HIST_MAX - HR_HIST_MIN + 1;

/**
 * A paused watch leaves a hole between two consecutive samples. Attributing
 * that whole hole to whichever heart rate the last sample happened to carry
 * would dump a third of a session into one zone. Ten seconds sits above any
 * genuine smart-recording interval and far below any pause worth worrying
 * about, so a real gap contributes only its first ten seconds.
 */
const DEFAULT_MAX_GAP_SECONDS = 10;

/** Below this the session's zone split is not trustworthy enough to aggregate. */
export const MIN_HR_COVERAGE = 0.8;

export interface HrHistogram {
  /** Seconds at each 1 bpm bucket; index 0 is HR_HIST_MIN. */
  seconds: number[];
  /** Attributed seconds over elapsed time, 0..1. */
  coverage: number;
  status: "ok" | "partial" | "none";
}

export function buildHrHistogram(
  streams: StreamSet,
  opts: { maxGapSeconds?: number; elapsedTime?: number } = {},
): HrHistogram | null {
  const hr = streams.heartrate?.data;
  const time = streams.time?.data;
  if (!hr || !time || hr.length === 0 || hr.length !== time.length) return null;

  const maxGap = opts.maxGapSeconds ?? DEFAULT_MAX_GAP_SECONDS;
  const seconds = new Array<number>(HR_HIST_LEN).fill(0);

  // Median sample interval, used for the final sample which has no successor.
  const deltas: number[] = [];
  for (let i = 1; i < time.length; i++) deltas.push(time[i] - time[i - 1]);
  deltas.sort((a, b) => a - b);
  const medianDt = deltas.length > 0 ? Math.max(1, deltas[Math.floor(deltas.length / 2)]) : 1;

  let attributed = 0;
  for (let i = 0; i < hr.length; i++) {
    const bpm = hr[i];
    // Strap dropouts read as 0 or an implausibly low value; they are absence
    // of data, not time spent at that heart rate.
    if (!bpm || bpm < HR_HIST_MIN) continue;
    const dt =
      i + 1 < time.length
        ? Math.min(Math.max(0, time[i + 1] - time[i]), maxGap)
        : medianDt;
    const bucket = Math.min(HR_HIST_LEN - 1, bpm - HR_HIST_MIN);
    seconds[bucket] += dt;
    attributed += dt;
  }

  // Against elapsed, not moving, time: standing between reps is training time
  // with a real heart rate in it, and excluding it would delete exactly the
  // recoveries that make an interval session's zone profile interesting.
  const span = opts.elapsedTime ?? time[time.length - 1] - time[0];
  const coverage = span > 0 ? Math.min(1, attributed / span) : 0;

  if (attributed === 0) return { seconds, coverage: 0, status: "none" };
  return {
    seconds,
    coverage: Math.round(coverage * 1000) / 1000,
    status: coverage >= MIN_HR_COVERAGE ? "ok" : "partial",
  };
}

export interface ZoneTime {
  seconds: [number, number, number, number, number];
  total: number;
  /** Fractions summing to 1 (or all zero when total is 0). */
  share: [number, number, number, number, number];
}

/**
 * Re-bucket a stored histogram under whatever zone model applies today.
 *
 * This is why the histogram is persisted instead of five zone totals: zones are
 * the least stable input in the whole feature — an athlete who sets custom
 * zones, or whose /athlete/zones call starts succeeding, would otherwise
 * invalidate every stored row and force a full re-scan at a Strava read each.
 */
export function bucketHistogram(hist: number[], model: ZoneModel): ZoneTime {
  const seconds: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  if (model.source !== "none") {
    for (let i = 0; i < hist.length && i < HR_HIST_LEN; i++) {
      if (!hist[i]) continue;
      seconds[hrZone(HR_HIST_MIN + i, model) - 1] += hist[i];
    }
  }
  const total = seconds.reduce((a, b) => a + b, 0);
  const share = seconds.map((s) => (total > 0 ? s / total : 0)) as ZoneTime["share"];
  return { seconds, total, share };
}

export function sumHistograms(hists: number[][]): number[] {
  const out = new Array<number>(HR_HIST_LEN).fill(0);
  for (const h of hists) {
    for (let i = 0; i < h.length && i < HR_HIST_LEN; i++) out[i] += h[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aerobic decoupling
// ---------------------------------------------------------------------------

/** Minimum steady running time before a decoupling figure means anything. */
const DECOUPLING_MIN_SECONDS = 40 * 60;
/** Above this coefficient of variation in speed the effort was not steady. */
const DECOUPLING_MAX_SPEED_CV = 0.15;

export interface Decoupling {
  /** Percent drop in speed-per-beat, first half to second. Positive = drifted. */
  pct: number;
  eligible: boolean;
}

/**
 * Aerobic decoupling: how much speed-per-beat fell across a session.
 *
 * Only meaningful on a steady aerobic effort. An interval session "decouples"
 * by construction, because its second half contains different work — so this
 * returns a figure marked ineligible rather than a number the athlete would be
 * right to distrust and wrong to act on.
 */
export function aerobicDecoupling(
  streams: StreamSet,
  model: ZoneModel,
  opts: { minSeconds?: number } = {},
): Decoupling | null {
  const hr = streams.heartrate?.data;
  const time = streams.time?.data;
  const vel = streams.velocity_smooth?.data;
  if (!hr || !time || !vel || hr.length < 60) return null;

  const duration = time[time.length - 1] - time[0];
  if (duration <= 0) return null;

  const mid = Math.floor(hr.length / 2);
  const ef = (from: number, to: number): number | null => {
    let speed = 0;
    let beats = 0;
    let n = 0;
    for (let i = from; i < to; i++) {
      if (!hr[i] || hr[i] < HR_HIST_MIN || !vel[i]) continue;
      speed += vel[i];
      beats += hr[i];
      n++;
    }
    return n > 0 ? speed / n / (beats / n) : null;
  };

  const first = ef(0, mid);
  const second = ef(mid, hr.length);
  if (first === null || second === null || first === 0) return null;

  // Steadiness: an interval session's speed varies far more than a long run's.
  const speeds = vel.filter((v) => v > 0);
  const mean = speeds.reduce((a, b) => a + b, 0) / Math.max(1, speeds.length);
  const variance =
    speeds.reduce((sum, v) => sum + (v - mean) ** 2, 0) / Math.max(1, speeds.length);
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;

  const meanHr = hr.filter((h) => h >= HR_HIST_MIN);
  const avgHr =
    meanHr.length > 0 ? meanHr.reduce((a, b) => a + b, 0) / meanHr.length : Infinity;

  const eligible =
    duration >= (opts.minSeconds ?? DECOUPLING_MIN_SECONDS) &&
    cv < DECOUPLING_MAX_SPEED_CV &&
    model.source !== "none" &&
    avgHr <= model.floors[2];

  return { pct: Math.round(((first - second) / first) * 1000) / 10, eligible };
}

// ---------------------------------------------------------------------------
// Session structure — work reps and recoveries
// ---------------------------------------------------------------------------

/**
 * Below roughly 10 min/km a runner is walking. Lives here rather than in the
 * web app so the lap chart and this analysis share one definition of the thing.
 */
const WALK_SPEED = 1000 / (10 * 60);

export function isWalk(speed: number, discipline: Discipline): boolean {
  return (
    (discipline === "run" || discipline === "other") && speed > 0 && speed < WALK_SPEED
  );
}

export type LapRole = "work" | "recovery" | "warmup" | "cooldown" | "walk" | "marker";

export interface Rep {
  /** 1-based position within its set. */
  index: number;
  seconds: number;
  meters: number;
  paceSecPerKm: number;
  avgHr?: number;
  maxHr?: number;
  /** The recovery that followed this rep, when there was one. */
  recoverySeconds?: number;
}

export interface RepSet {
  label: string;
  reps: Rep[];
  targetMeters: number | null;
  /** Percent slower the last rep was than the first. Positive = faded. */
  fadePct: number | null;
  /** How far the last rep's average HR sat above the first's. */
  hrDriftBpm: number | null;
}

export interface SessionStructure {
  kind: "intervals" | "steady" | "progression" | "unknown";
  sets: RepSet[];
  workSeconds: number;
  recoverySeconds: number;
}

const STEADY: SessionStructure = {
  kind: "steady",
  sets: [],
  workSeconds: 0,
  recoverySeconds: 0,
};

/** Laps under this are a button double-press, not an effort. */
const MARKER_SECONDS = 20;
const MARKER_METERS = 100;

/**
 * Below this separation between the fast and slow lap clusters there is no
 * distinguishable work and rest. Eight percent is roughly 20 sec/km at 4:30
 * pace; under that, "reps" are indistinguishable from ordinary pacing drift on
 * a continuous run.
 */
const MIN_CLUSTER_SEPARATION = 0.08;

/** Work laps within this distance of each other belong to the same set. */
const SET_GROUPING_TOLERANCE = 0.15;

/** At most this many reps are described; a pathological lap file stops here. */
export const MAX_REPS_STORED = 60;

/**
 * A watch's automatic kilometre (or mile) laps are not workout structure.
 *
 * Without this check every easy long run comes back as "10 x 1 km reps", and
 * the interval analysis would describe sessions that were never intervals.
 */
export function detectAutoLaps(laps: Lap[]): boolean {
  if (laps.length < 4) return false;
  // The final lap is the remainder and is never a round distance.
  const body = laps.slice(0, -1);
  const isRound = (m: number) =>
    Math.abs(m - 1000) / 1000 <= 0.02 || Math.abs(m - 1609.34) / 1609.34 <= 0.02;
  const round = body.filter((l) => isRound(l.distance)).length;
  return round / body.length >= 0.8;
}

/** Split values into two clusters by 1-D k-means seeded at the extremes. */
function twoMeans(values: number[]): { fast: number; slow: number } {
  let slow = Math.min(...values);
  let fast = Math.max(...values);
  for (let iter = 0; iter < 10; iter++) {
    const lo: number[] = [];
    const hi: number[] = [];
    for (const v of values) {
      (Math.abs(v - fast) < Math.abs(v - slow) ? hi : lo).push(v);
    }
    if (lo.length === 0 || hi.length === 0) break;
    const nextSlow = lo.reduce((a, b) => a + b, 0) / lo.length;
    const nextFast = hi.reduce((a, b) => a + b, 0) / hi.length;
    if (nextSlow === slow && nextFast === fast) break;
    slow = nextSlow;
    fast = nextFast;
  }
  return { fast, slow };
}

function paceOf(lap: Lap): number {
  return lap.distance > 0 ? lap.moving_time / (lap.distance / 1000) : 0;
}

function setLabel(reps: Rep[]): string {
  const meters = reps.map((r) => r.meters);
  const spread = Math.max(...meters) - Math.min(...meters);
  const mean = meters.reduce((a, b) => a + b, 0) / meters.length;
  if (reps.length > 1 && mean > 0 && spread / mean <= SET_GROUPING_TOLERANCE) {
    return `${reps.length} x ${Math.round(mean / 10) * 10} m`;
  }
  // Distances vary — describe it as the chain it is.
  return meters.map((m) => Math.round(m / 10) * 10).join("-") + " m";
}

/**
 * Read a session's lap file as work reps and recoveries.
 *
 * The clustering is deliberately learned from the session rather than compared
 * against a fixed threshold: the same rule then covers 400 m reps at 3:20 with
 * 90-second jogs AND a 4-3-2-1 tempo at 4:10 with 3-minute floats, which no
 * single "x% above average" cutoff does.
 *
 * Every guard fails towards "no structure detected" rather than towards
 * inventing reps. A session wrongly called steady loses a panel; a steady run
 * wrongly called intervals produces confident nonsense about reps that never
 * happened.
 */
export function analyzeStructure(
  laps: Lap[],
  discipline: Discipline,
): SessionStructure {
  if (!laps || laps.length < 4) return STEADY;
  if (detectAutoLaps(laps)) return STEADY;

  const roles = new Map<number, LapRole>();
  const candidates: Lap[] = [];
  for (const lap of laps) {
    if (lap.moving_time < MARKER_SECONDS || lap.distance < MARKER_METERS) {
      roles.set(lap.lap_index, "marker");
      continue;
    }
    if (isWalk(lap.average_speed, discipline)) {
      roles.set(lap.lap_index, "walk");
      continue;
    }
    candidates.push(lap);
  }
  if (candidates.length < 4) return STEADY;

  const speeds = candidates.map((l) => l.average_speed);
  const { fast, slow } = twoMeans(speeds);
  if (fast <= 0 || (fast - slow) / fast < MIN_CLUSTER_SEPARATION) {
    // No work/rest separation. It may still be a progression run.
    const third = Math.max(1, Math.floor(candidates.length / 3));
    const head = speeds.slice(0, third).reduce((a, b) => a + b, 0) / third;
    const tail = speeds.slice(-third).reduce((a, b) => a + b, 0) / third;
    if (head > 0 && (tail - head) / head >= 0.08) {
      return { ...STEADY, kind: "progression" };
    }
    return STEADY;
  }

  for (const lap of candidates) {
    const isWork =
      Math.abs(lap.average_speed - fast) < Math.abs(lap.average_speed - slow);
    roles.set(lap.lap_index, isWork ? "work" : "recovery");
  }

  // Separation alone is not enough: a progression run also splits cleanly into
  // a slow cluster and a fast one, because its laps get steadily quicker. What
  // distinguishes an interval session is that the two ALTERNATE — work, rest,
  // work, rest — whereas a progression's fast laps are one contiguous block at
  // the end. Counting the work groups tells the two apart; without this a
  // negative-split long run is reported as reps that never happened.
  let workGroups = 0;
  let inWork = false;
  for (const lap of candidates) {
    const isWork = roles.get(lap.lap_index) === "work";
    if (isWork && !inWork) workGroups++;
    inWork = isWork;
  }
  if (workGroups < 2) {
    const third = Math.max(1, Math.floor(candidates.length / 3));
    const head = speeds.slice(0, third).reduce((a, b) => a + b, 0) / third;
    const tail = speeds.slice(-third).reduce((a, b) => a + b, 0) / third;
    if (head > 0 && (tail - head) / head >= 0.08) {
      return { ...STEADY, kind: "progression" };
    }
    return STEADY;
  }

  // Leading and trailing non-work laps are the jog to and from the session.
  // Counting them as recovery would inflate "18 min work / 9 min recovery"
  // with a fifteen-minute warm-up that was never part of the set.
  const ordered = [...laps].sort((a, b) => a.lap_index - b.lap_index);
  const firstWork = ordered.findIndex((l) => roles.get(l.lap_index) === "work");
  const lastWork = ordered.map((l) => roles.get(l.lap_index)).lastIndexOf("work");
  if (firstWork === -1) return STEADY;
  for (let i = 0; i < firstWork; i++) {
    if (roles.get(ordered[i].lap_index) === "recovery") {
      roles.set(ordered[i].lap_index, "warmup");
    }
  }
  for (let i = lastWork + 1; i < ordered.length; i++) {
    if (roles.get(ordered[i].lap_index) === "recovery") {
      roles.set(ordered[i].lap_index, "cooldown");
    }
  }

  // Walk-through, pairing each work rep with the recovery that followed it.
  const reps: Rep[] = [];
  let workSeconds = 0;
  let recoverySeconds = 0;
  for (let i = 0; i < ordered.length; i++) {
    const lap = ordered[i];
    const role = roles.get(lap.lap_index);
    if (role === "recovery") recoverySeconds += lap.moving_time;
    if (role !== "work") continue;
    workSeconds += lap.moving_time;
    let recovery: number | undefined;
    for (let j = i + 1; j < ordered.length; j++) {
      const next = roles.get(ordered[j].lap_index);
      if (next === "work") break;
      if (next === "recovery") {
        recovery = (recovery ?? 0) + ordered[j].moving_time;
      }
    }
    reps.push({
      index: reps.length + 1,
      seconds: lap.moving_time,
      meters: Math.round(lap.distance),
      paceSecPerKm: Math.round(paceOf(lap)),
      avgHr: lap.average_heartrate,
      maxHr: lap.max_heartrate,
      recoverySeconds: recovery,
    });
    if (reps.length >= MAX_REPS_STORED) break;
  }
  if (reps.length < 2) return STEADY;

  // Group consecutive reps of similar distance into sets, so "800m into 400m"
  // reads as two sets rather than one ragged twelve.
  const sets: RepSet[] = [];
  let current: Rep[] = [];
  for (const rep of reps) {
    const prev = current[current.length - 1];
    const similar =
      !prev || Math.abs(rep.meters - prev.meters) / Math.max(1, prev.meters) <= SET_GROUPING_TOLERANCE;
    if (similar) {
      current.push(rep);
    } else {
      if (current.length > 0) sets.push(makeSet(current));
      current = [rep];
    }
  }
  if (current.length > 0) sets.push(makeSet(current));

  return { kind: "intervals", sets, workSeconds, recoverySeconds };
}

function makeSet(reps: Rep[]): RepSet {
  const renumbered = reps.map((r, i) => ({ ...r, index: i + 1 }));
  const first = renumbered[0];
  const last = renumbered[renumbered.length - 1];
  const fadePct =
    renumbered.length > 1 && first.paceSecPerKm > 0
      ? Math.round(((last.paceSecPerKm - first.paceSecPerKm) / first.paceSecPerKm) * 1000) / 10
      : null;
  const hrDriftBpm =
    renumbered.length > 1 && first.avgHr && last.avgHr
      ? Math.round(last.avgHr - first.avgHr)
      : null;
  const meters = renumbered.map((r) => r.meters);
  const mean = meters.reduce((a, b) => a + b, 0) / meters.length;
  const spread = Math.max(...meters) - Math.min(...meters);
  return {
    label: setLabel(renumbered),
    reps: renumbered,
    targetMeters:
      mean > 0 && spread / mean <= SET_GROUPING_TOLERANCE ? Math.round(mean) : null,
    fadePct,
    hrDriftBpm,
  };
}

// ---------------------------------------------------------------------------
// Trends from summary data
// ---------------------------------------------------------------------------

/** A run has to be at least this long and far before its averages mean much. */
const TREND_MIN_SECONDS = 20 * 60;
const TREND_MIN_METERS = 3000;

export interface EfficiencyPoint {
  activityId: number;
  name: string;
  date: string;
  weekStart: string;
  /** Speed per beat, x1000 so it reads as 17.8 rather than 0.0178. */
  ef: number;
  avgHr: number;
  paceSecPerKm: number;
}

export interface EfficiencyTrend {
  points: EfficiencyPoint[];
  weekly: { weekStart: string; ef: number; n: number }[];
  /** Mean of the first third of points, and of the last third. */
  early: number;
  late: number;
  changePct: number | null;
  eligible: boolean;
}

/** Enough points, over enough weeks, for a trend rather than a coincidence. */
const EF_MIN_POINTS = 8;
const EF_MIN_WEEKS = 6;

function aerobicRuns(
  activities: StravaActivity[],
  model: ZoneModel,
  from: string,
  to: string,
): StravaActivity[] {
  return activities
    .filter((a) => {
      const day = a.start_date_local.split("T")[0];
      if (day < from || day > to) return false;
      if (getDiscipline(a) !== "run") return false;
      if (a.manual) return false;
      if (a.moving_time < TREND_MIN_SECONDS || a.distance < TREND_MIN_METERS) return false;
      if (!a.average_heartrate) return false;
      // Aerobic only. A race or a VO2 session has a high efficiency factor for
      // reasons that have nothing to do with fitness, so letting them in makes
      // the series track what the athlete did rather than how they are doing.
      return model.source !== "none" && a.average_heartrate < model.floors[2];
    })
    .sort((a, b) => a.start_date_local.localeCompare(b.start_date_local));
}

export function buildEfficiencyTrend(
  activities: StravaActivity[],
  model: ZoneModel,
  from: string,
  to: string,
): EfficiencyTrend {
  const runs = aerobicRuns(activities, model, from, to);
  const points: EfficiencyPoint[] = runs.map((a) => {
    const day = a.start_date_local.split("T")[0];
    const speed = a.distance / a.moving_time;
    return {
      activityId: a.id,
      name: a.name,
      date: day,
      weekStart: getWeekStart(new Date(`${day}T12:00:00`)),
      ef: Math.round((speed / a.average_heartrate!) * 1000 * 100) / 100,
      avgHr: Math.round(a.average_heartrate!),
      paceSecPerKm: Math.round(a.moving_time / (a.distance / 1000)),
    };
  });

  const byWeek = new Map<string, number[]>();
  for (const p of points) {
    byWeek.set(p.weekStart, [...(byWeek.get(p.weekStart) ?? []), p.ef]);
  }
  const weekly = Array.from(byWeek.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, efs]) => ({
      weekStart,
      ef: Math.round((efs.reduce((x, y) => x + y, 0) / efs.length) * 100) / 100,
      n: efs.length,
    }));

  // First third against last third, never first point against last: one hot
  // day or one loose strap would otherwise be the entire trend.
  const third = Math.max(1, Math.floor(points.length / 3));
  const mean = (xs: EfficiencyPoint[]) =>
    xs.length > 0 ? xs.reduce((s, p) => s + p.ef, 0) / xs.length : 0;
  const early = Math.round(mean(points.slice(0, third)) * 100) / 100;
  const late = Math.round(mean(points.slice(-third)) * 100) / 100;

  const weeksSpanned = weekly.length;
  const eligible = points.length >= EF_MIN_POINTS && weeksSpanned >= EF_MIN_WEEKS;

  return {
    points,
    weekly,
    early,
    late,
    changePct: early > 0 ? Math.round(((late - early) / early) * 1000) / 10 : null,
    eligible,
  };
}

export interface PaceAtHrBand {
  lowBpm: number;
  highBpm: number;
  points: { date: string; paceSecPerKm: number; avgHr: number }[];
  earlyPaceSecPerKm: number;
  latePaceSecPerKm: number;
  earlyAvgHr: number;
  lateAvgHr: number;
  /** Negative means faster now. */
  deltaSecPerKm: number | null;
  eligible: boolean;
}

const BAND_MIN_POINTS = 6;
const BAND_HALF_WIDTH = 5;

/**
 * Pace held inside a narrow heart-rate band, earlier against recently.
 *
 * The cleanest like-for-like comparison summary data allows: same effort, so
 * any pace difference is fitness rather than how hard the athlete chose to run.
 * The band is taken from the athlete's own median aerobic heart rate rather
 * than hard-coded — a fixed 148-158 is one athlete's band, and someone whose
 * easy runs sit at 128 would get an empty chart.
 */
export function paceAtHrBand(
  activities: StravaActivity[],
  model: ZoneModel,
  from: string,
  to: string,
  band?: { low: number; high: number },
): PaceAtHrBand | null {
  const runs = aerobicRuns(activities, model, from, to);
  if (runs.length === 0) return null;

  let low: number;
  let high: number;
  if (band) {
    ({ low, high } = band);
  } else {
    const hrs = runs.map((a) => a.average_heartrate!).sort((a, b) => a - b);
    const median = hrs[Math.floor(hrs.length / 2)];
    low = Math.round(median) - BAND_HALF_WIDTH;
    high = Math.round(median) + BAND_HALF_WIDTH;
  }

  const inBand = runs.filter(
    (a) => a.average_heartrate! >= low && a.average_heartrate! <= high,
  );
  if (inBand.length === 0) return null;

  const points = inBand.map((a) => ({
    date: a.start_date_local.split("T")[0],
    paceSecPerKm: Math.round(a.moving_time / (a.distance / 1000)),
    avgHr: Math.round(a.average_heartrate!),
  }));

  const half = Math.floor(points.length / 2);
  const early = points.slice(0, half);
  const late = points.slice(half);
  const avg = (xs: typeof points, key: "paceSecPerKm" | "avgHr") =>
    xs.length > 0 ? xs.reduce((s, p) => s + p[key], 0) / xs.length : 0;

  const earlyPace = Math.round(avg(early, "paceSecPerKm"));
  const latePace = Math.round(avg(late, "paceSecPerKm"));

  return {
    lowBpm: low,
    highBpm: high,
    points,
    earlyPaceSecPerKm: earlyPace,
    latePaceSecPerKm: latePace,
    earlyAvgHr: Math.round(avg(early, "avgHr")),
    lateAvgHr: Math.round(avg(late, "avgHr")),
    deltaSecPerKm: early.length > 0 && late.length > 0 ? latePace - earlyPace : null,
    eligible: points.length >= BAND_MIN_POINTS,
  };
}

// ---------------------------------------------------------------------------
// Same-workout comparison
// ---------------------------------------------------------------------------

/**
 * A comparable key for a workout name.
 *
 * Strips the "Morning "/"Lunch "/"Evening " prefixes Strava prepends and any
 * trailing repeat marker, but deliberately KEEPS digits: "400m Repeats" and
 * "800m Repeats" are different workouts, and collapsing them would report a
 * two-minute-per-kilometre improvement that never happened.
 */
export function workoutKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(morning|lunch|lunchtime|afternoon|evening|night)\s+/i, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+\d+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Peak summary-data effort classification, used before any scan has run. */
export interface SummaryZones {
  /** Sessions whose AVERAGE HR fell in each zone. Not time in zone. */
  sessionAverage: [number, number, number, number, number];
  /** Sessions whose PEAK HR reached each zone. Not time in zone. */
  peakReached: [number, number, number, number, number];
  sessions: number;
}

export function summaryZones(
  activities: StravaActivity[],
  model: ZoneModel,
  from: string,
  to: string,
): SummaryZones {
  const out: SummaryZones = {
    sessionAverage: [0, 0, 0, 0, 0],
    peakReached: [0, 0, 0, 0, 0],
    sessions: 0,
  };
  if (model.source === "none") return out;
  for (const a of activities) {
    const day = a.start_date_local.split("T")[0];
    if (day < from || day > to) continue;
    if (getDiscipline(a) === "other" || !a.average_heartrate) continue;
    out.sessions++;
    out.sessionAverage[hrZone(a.average_heartrate, model) - 1]++;
    if (a.max_heartrate) out.peakReached[hrZone(a.max_heartrate, model) - 1]++;
  }
  return out;
}

/** Calendar-date arithmetic in UTC, matching the rest of the codebase. */
export function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}
