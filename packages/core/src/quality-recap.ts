import { StravaActivity, AthleteZones } from "./types/strava";
import { getDiscipline, localToday, formatSecondsAsClock, formatDuration } from "./training";
import { BLOCK_DAYS } from "./recap";
import type { Insight, InsightTone } from "./recap";
import {
  bucketHistogram,
  buildEfficiencyTrend,
  observedMaxHr,
  paceAtHrBand,
  resolveZoneModel,
  shiftDays,
  summaryZones,
  sumHistograms,
  workoutKey,
  zonesUnreachable,
  MIN_HR_COVERAGE,
  type EfficiencyTrend,
  type PaceAtHrBand,
  type SessionStructure,
  type SummaryZones,
  type ZoneModel,
  type ZoneTime,
} from "./quality";

/**
 * Assembling the quality view, and reading it.
 *
 * Two windows on purpose, each labelled where it is rendered. Efficiency and
 * pace trends span the full history because that is the only length at which
 * they say anything — the same athlete's efficiency moved 14% across a year and
 * is indistinguishable from noise month to month. The zone mix and the interval
 * list cover the recent block, because what an athlete does about them is a
 * decision about next week.
 */

/** Trends need a season; the mix needs the current block. */
export const TREND_WEEKS = 52;

// ---------------------------------------------------------------------------
// Persisted per-activity profile
// ---------------------------------------------------------------------------

/**
 * One activity's derived quality profile — the de-persisted form of an
 * `activity_quality` row.
 *
 * Raw streams are never kept: a 90-minute run at 1 Hz across five channels is
 * several hundred kilobytes, while everything the panel asks of it fits in
 * about one. `hrSeconds` is a per-bpm histogram rather than five zone totals
 * precisely so the zone model stays a read-time decision — see bucketHistogram.
 */
export interface QualityProfile {
  activityId: string;
  date: string;
  name: string;
  workoutKey: string;
  movingTime: number;
  elapsedTime: number;
  distance: number;
  avgHr: number | null;
  maxHr: number | null;
  hrSeconds: number[] | null;
  hrCoverage: number | null;
  decoupling: number | null;
  decouplingEligible: boolean;
  structure: SessionStructure | null;
  streamStatus: "ok" | "partial" | "none" | "error";
  lapStatus: "ok" | "auto-laps" | "none" | "skipped" | "error";
}

export interface QualityCoverage {
  /** Runs with heart rate in the mix window — the denominator for everything. */
  eligible: number;
  /** Of those, how many have a usable stream-derived histogram. */
  scanned: number;
  /** How many have their laps. */
  withLaps: number;
  /** Runs that will never yield streams (manual, or a genuine 404). */
  unavailable: number;
  tier: "summary" | "partial" | "full";
}

export interface WorkoutRepeat {
  key: string;
  label: string;
  occurrences: {
    activityId: string;
    date: string;
    workSeconds: number;
    avgWorkPaceSecPerKm: number;
    avgWorkHr: number | null;
    repCount: number;
  }[];
  /** Latest against earliest, percent change in work pace. Negative = faster. */
  changePct: number | null;
}

export interface QualityRecap {
  /** Trend window (full history). */
  trendFrom: string;
  trendTo: string;
  /** Mix and interval window (current block). */
  mixFrom: string;
  mixTo: string;
  zones: ZoneModel;
  zonesUnreachable: boolean;
  coverage: QualityCoverage;
  /** Approximate, session-level. Always present. */
  summary: SummaryZones;
  /** Stream-derived. Null until something has been scanned. */
  timeInZone: ZoneTime | null;
  efficiency: EfficiencyTrend;
  paceAtHr: PaceAtHrBand | null;
  /** Scanned sessions with real structure, newest first. */
  sessions: QualityProfile[];
  repeats: WorkoutRepeat[];
  decoupling: { mean: number; n: number } | null;
}

export interface QualityRecapInput {
  activities: StravaActivity[];
  profiles: QualityProfile[];
  zones: AthleteZones | null;
  today?: string;
  trendWeeks?: number;
}

function inWindow(day: string, from: string, to: string): boolean {
  return day >= from && day <= to;
}

export function buildQualityRecap(input: QualityRecapInput): QualityRecap {
  const today = input.today ?? localToday();
  const trendWeeks = input.trendWeeks ?? TREND_WEEKS;

  const mixTo = today;
  const mixFrom = shiftDays(today, -(BLOCK_DAYS - 1));
  const trendTo = today;
  const trendFrom = shiftDays(today, -(trendWeeks * 7 - 1));

  const allTimeMax = input.activities.reduce<number | null>(
    (max, a) => (a.max_heartrate && (max === null || a.max_heartrate > max) ? a.max_heartrate : max),
    null,
  );
  const zones = resolveZoneModel(input.zones, observedMaxHr(input.activities));

  // --- coverage, over the mix window
  const runsInMix = input.activities.filter(
    (a) =>
      inWindow(a.start_date_local.split("T")[0], mixFrom, mixTo) &&
      getDiscipline(a) !== "other" &&
      a.average_heartrate,
  );
  const profileById = new Map(input.profiles.map((p) => [p.activityId, p]));
  const mixProfiles = runsInMix
    .map((a) => profileById.get(String(a.id)))
    .filter((p): p is QualityProfile => p !== undefined);

  const usable = mixProfiles.filter(
    (p) => p.hrSeconds && (p.hrCoverage ?? 0) >= MIN_HR_COVERAGE,
  );
  const coverage: QualityCoverage = {
    eligible: runsInMix.length,
    scanned: usable.length,
    withLaps: mixProfiles.filter((p) => p.lapStatus === "ok").length,
    unavailable: mixProfiles.filter((p) => p.streamStatus === "none").length,
    tier:
      usable.length === 0
        ? "summary"
        : usable.length >= runsInMix.length - mixProfiles.filter((p) => p.streamStatus === "none").length
          ? "full"
          : "partial",
  };

  // Only sessions whose HR trace is trustworthy contribute to window totals.
  // A partial trace still shows on its own session row, where its coverage is
  // visible, but averaging it into the block would silently understate a zone.
  const timeInZone =
    usable.length > 0
      ? bucketHistogram(sumHistograms(usable.map((p) => p.hrSeconds!)), zones)
      : null;

  const efficiency = buildEfficiencyTrend(input.activities, zones, trendFrom, trendTo);
  const paceAtHr = paceAtHrBand(input.activities, zones, trendFrom, trendTo);

  const sessions = mixProfiles
    .filter((p) => p.structure?.kind === "intervals")
    .sort((a, b) => b.date.localeCompare(a.date));

  const decouplingRows = mixProfiles.filter(
    (p) => p.decouplingEligible && p.decoupling !== null,
  );
  const decoupling =
    decouplingRows.length > 0
      ? {
          mean:
            Math.round(
              (decouplingRows.reduce((s, p) => s + p.decoupling!, 0) /
                decouplingRows.length) *
                10,
            ) / 10,
          n: decouplingRows.length,
        }
      : null;

  return {
    trendFrom,
    trendTo,
    mixFrom,
    mixTo,
    zones,
    zonesUnreachable: zonesUnreachable(zones, allTimeMax),
    coverage,
    summary: summaryZones(input.activities, zones, mixFrom, mixTo),
    timeInZone,
    efficiency,
    paceAtHr,
    sessions,
    repeats: findRepeatedWorkouts(input.profiles),
    decoupling,
  };
}

/** Two occurrences whose work volumes differ by more than this are not comparable. */
const REPEAT_VOLUME_TOLERANCE = 0.2;

/**
 * The same workout, done more than once.
 *
 * Only compares occurrences of similar work volume: without that guard "I did
 * four of the six reps and stopped" reads as a personal best, because the
 * truncated session's average work pace is faster than the complete one's.
 */
export function findRepeatedWorkouts(profiles: QualityProfile[]): WorkoutRepeat[] {
  const byKey = new Map<string, QualityProfile[]>();
  for (const p of profiles) {
    if (p.structure?.kind !== "intervals") continue;
    const key = p.workoutKey || workoutKey(p.name);
    byKey.set(key, [...(byKey.get(key) ?? []), p]);
  }

  const out: WorkoutRepeat[] = [];
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));

    const occurrences = sorted.map((p) => {
      const reps = p.structure!.sets.flatMap((s) => s.reps);
      const workSeconds = p.structure!.workSeconds;
      const paces = reps.map((r) => r.paceSecPerKm).filter((x) => x > 0);
      const hrs = reps.map((r) => r.avgHr).filter((x): x is number => !!x);
      return {
        activityId: p.activityId,
        date: p.date,
        workSeconds,
        avgWorkPaceSecPerKm:
          paces.length > 0 ? Math.round(paces.reduce((a, b) => a + b, 0) / paces.length) : 0,
        avgWorkHr:
          hrs.length > 0 ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null,
        repCount: reps.length,
      };
    });

    const first = occurrences[0];
    const last = occurrences[occurrences.length - 1];
    const comparable =
      first.workSeconds > 0 &&
      Math.abs(last.workSeconds - first.workSeconds) / first.workSeconds <=
        REPEAT_VOLUME_TOLERANCE &&
      first.avgWorkPaceSecPerKm > 0;

    out.push({
      key,
      label: sorted[sorted.length - 1].name,
      occurrences,
      changePct: comparable
        ? Math.round(
            ((last.avgWorkPaceSecPerKm - first.avgWorkPaceSecPerKm) /
              first.avgWorkPaceSecPerKm) *
              1000,
          ) / 10
        : null,
    });
  }
  return out.sort((a, b) => b.occurrences.length - a.occurrences.length);
}

// ---------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------

const TONE_RANK: Record<InsightTone, number> = { err: 0, warn: 1, accent: 2, ok: 3 };

function rank(insights: Insight[], limit: number): Insight[] {
  return insights
    .map((insight, i) => ({ insight, i }))
    .sort((a, b) => TONE_RANK[a.insight.tone] - TONE_RANK[b.insight.tone] || a.i - b.i)
    .slice(0, limit)
    .map((e) => e.insight);
}

/** Minimum samples before a rule is allowed to say anything at all. */
const MIN_HR_SESSIONS = 5;
const MIN_SCANNED_FOR_MIX = 10;
const MIN_SUMMARY_SESSIONS = 20;
const MIN_INTERVAL_SESSIONS = 2;
const MIN_DECOUPLING_RUNS = 3;

/** Noise floors, each sized to the measurement rather than chosen for roundness. */
const EF_NOISE_PCT = 3;      // week-to-week EF scatter from heat/terrain/strap
const PACE_NOISE_SEC = 5;    // ~2% at 4:30/km — above GPS noise, below perceptible
const FADE_NOISE_PCT = 1.5;  // ~1s on an 80s 400m rep — lap-button precision
const FADE_REAL_PCT = 3;
const HR_DRIFT_BPM = 8;
const DECOUPLING_PCT = 5;    // the standard aerobic-durability line
const REPEAT_NOISE_PCT = 2;

function pace(secPerKm: number): string {
  return `${formatSecondsAsClock(secPerKm)}/km`;
}

/**
 * The quality figures, read as findings.
 *
 * Same contract as readBlock/readPlan: deterministic thresholds, ranked by
 * severity, each rendered beside the number it came from so the athlete can
 * check it. The addition here is a hard rule about provenance — a claim about
 * time in zone is only ever made from stream data, never from session averages,
 * because an interval session averages into the middle zone between its reps
 * and its recoveries and would make a polarised week look like a grey one.
 */
export function readQuality(recap: QualityRecap, limit = 4): Insight[] {
  const found: Insight[] = [];
  const { coverage, efficiency, paceAtHr, timeInZone, summary, zones } = recap;

  if (zones.source === "none" || coverage.eligible < MIN_HR_SESSIONS) {
    return [
      {
        id: "no-hr",
        tone: "warn",
        headline: "Not enough heart-rate data yet",
        detail:
          zones.source === "none"
            ? "No heart-rate zones and no recorded maximum, so effort cannot be read. Record a few runs with a heart-rate monitor."
            : `Only ${coverage.eligible} session${coverage.eligible === 1 ? "" : "s"} with heart rate in the last six weeks. A handful more and this fills in.`,
      },
    ];
  }

  if (recap.zonesUnreachable) {
    found.push({
      id: "zones-unreachable",
      tone: "warn",
      headline: "Your Z5 floor is above your highest recorded heart rate",
      detail: `Zone 5 starts at ${zones.floors[4]} but you have never recorded above ${zones.maxHr}. Z5 will always read zero — that is the zone setting, not your training.`,
    });
  }

  // --- Intensity distribution. Stream-derived only; the summary form below is
  // a different, weaker claim and says so.
  if (timeInZone && coverage.scanned >= MIN_SCANNED_FOR_MIX && timeInZone.total > 0) {
    const easy = timeInZone.share[0] + timeInZone.share[1];
    if (easy < 0.65) {
      found.push({
        id: "easy-not-easy",
        tone: "warn",
        headline: `Only ${Math.round(easy * 100)}% of your time is genuinely easy`,
        detail: `${formatDuration(Math.round(timeInZone.seconds[2] / 60))} sat in Z3 across the block. The middle is where easy runs stop being recovery and hard runs stop being hard — most plans keep the easy share near 80%.`,
      });
    } else if (easy >= 0.75) {
      found.push({
        id: "easy-discipline",
        tone: "ok",
        headline: `${Math.round(easy * 100)}% of your training time is easy`,
        detail: "That is the polarised split working — enough genuinely easy volume to absorb the hard sessions you do.",
      });
    }

    // Top end. Stated from time, never from peak HR: touching Z5 for ten
    // seconds at the end of a rep is not training the top end.
    if (timeInZone.seconds[4] < 60 && timeInZone.seconds[3] > 300) {
      found.push({
        id: "top-end-untouched",
        tone: "accent",
        headline: "Your top end is untouched",
        detail: `${formatDuration(Math.round(timeInZone.seconds[3] / 60))} in Z4 but under a minute in Z5 across six weeks. You are training threshold regularly and never going above it — worth a short VO2 session if your race rewards a finishing kick.`,
      });
    }
  } else if (coverage.tier === "summary" && summary.sessions >= MIN_SUMMARY_SESSIONS) {
    // Tier A wording. Counts sessions and speaks about PEAK heart rate, which
    // is all session summaries can honestly support.
    const reachedTop = summary.peakReached[3] + summary.peakReached[4];
    if (reachedTop >= summary.sessions * 0.25 && summary.peakReached[4] <= 1) {
      found.push({
        id: "top-end-summary",
        tone: "accent",
        headline: `Peak heart rate reached Z4 in ${reachedTop} of ${summary.sessions} sessions, Z5 in ${summary.peakReached[4]}`,
        detail: "That hints the top end is rarely trained, but peak heart rate is not time spent there. Scan your sessions to turn this into a real time-in-zone reading.",
      });
    }
  }

  // --- Aerobic efficiency over the season.
  if (efficiency.eligible && efficiency.changePct !== null) {
    const change = efficiency.changePct;
    if (change >= EF_NOISE_PCT) {
      found.push({
        id: "ef-up",
        tone: "ok",
        headline: `Aerobic efficiency up ${change.toFixed(0)}%`,
        detail: `Speed per heartbeat went ${efficiency.early.toFixed(1)} to ${efficiency.late.toFixed(1)} across ${efficiency.weekly.length} weeks of easy running. That is the engine getting bigger, not just the legs getting faster.`,
      });
    } else if (change <= -EF_NOISE_PCT) {
      found.push({
        id: "ef-down",
        tone: "warn",
        headline: `Aerobic efficiency down ${Math.abs(change).toFixed(0)}%`,
        detail: `Speed per heartbeat fell ${efficiency.early.toFixed(1)} to ${efficiency.late.toFixed(1)}. Expected after a layoff or in heat; otherwise it usually means accumulated fatigue rather than lost fitness.`,
      });
    }
  }

  // --- The like-for-like pace comparison.
  if (paceAtHr?.eligible && paceAtHr.deltaSecPerKm !== null) {
    const delta = paceAtHr.deltaSecPerKm;
    if (delta <= -PACE_NOISE_SEC) {
      found.push({
        id: "pace-at-hr-up",
        tone: "ok",
        headline: `${Math.abs(delta)} sec/km faster at the same heart rate`,
        detail: `At ${paceAtHr.lowBpm}-${paceAtHr.highBpm} bpm you have gone from ${pace(paceAtHr.earlyPaceSecPerKm)} to ${pace(paceAtHr.latePaceSecPerKm)}. Same effort, more speed — the clearest fitness signal in your data.`,
      });
    } else if (delta >= PACE_NOISE_SEC) {
      found.push({
        id: "pace-at-hr-down",
        tone: "warn",
        headline: `${delta} sec/km slower at the same heart rate`,
        detail: `At ${paceAtHr.lowBpm}-${paceAtHr.highBpm} bpm you have gone from ${pace(paceAtHr.earlyPaceSecPerKm)} to ${pace(paceAtHr.latePaceSecPerKm)}. Check heat and fatigue before reading it as lost fitness.`,
      });
    }
  }

  // --- How the reps themselves went.
  const sets = recap.sessions.flatMap((s) => s.structure?.sets ?? []).filter((s) => s.reps.length >= 4);
  if (recap.sessions.length >= MIN_INTERVAL_SESSIONS && sets.length > 0) {
    const fades = sets.map((s) => s.fadePct).filter((f): f is number => f !== null);
    if (fades.length > 0) {
      const meanFade = fades.reduce((a, b) => a + b, 0) / fades.length;
      if (meanFade >= FADE_REAL_PCT) {
        found.push({
          id: "rep-fade",
          tone: "warn",
          headline: `Your reps fade ${meanFade.toFixed(1)}% across a set`,
          detail: `Averaged over ${sets.length} sets, the last rep is meaningfully slower than the first. That is starting too fast rather than running out of fitness — hold the first two back and the set averages quicker.`,
        });
      } else if (Math.abs(meanFade) <= FADE_NOISE_PCT) {
        found.push({
          id: "rep-even",
          tone: "ok",
          headline: "Your reps are evenly paced",
          detail: `Across ${sets.length} sets the last rep lands within ${FADE_NOISE_PCT}% of the first. Even pacing is what makes an interval session repeatable.`,
        });
      }
    }

    const drifts = sets.map((s) => s.hrDriftBpm).filter((d): d is number => d !== null);
    if (drifts.length > 0) {
      const meanDrift = drifts.reduce((a, b) => a + b, 0) / drifts.length;
      if (meanDrift >= HR_DRIFT_BPM) {
        found.push({
          id: "rep-hr-drift",
          tone: "accent",
          headline: `Heart rate climbs ${Math.round(meanDrift)} bpm across a set`,
          detail: "Pace holding while heart rate rises means the recoveries are too short for the work. Lengthen them and the same paces cost less.",
        });
      }
    }
  }

  // --- Durability on long runs.
  if (recap.decoupling && recap.decoupling.n >= MIN_DECOUPLING_RUNS) {
    if (recap.decoupling.mean > DECOUPLING_PCT) {
      found.push({
        id: "decoupled",
        tone: "warn",
        headline: `Pace drifts ${recap.decoupling.mean.toFixed(1)}% off heart rate on long runs`,
        detail: `Across ${recap.decoupling.n} steady runs the second half costs more beats per km than the first. Above 5% is the usual marker that endurance, not speed, is the limiter.`,
      });
    }
  }

  // --- The same workout, done again.
  const repeat = recap.repeats.find(
    (r) => r.changePct !== null && Math.abs(r.changePct) >= REPEAT_NOISE_PCT,
  );
  if (repeat && repeat.changePct !== null) {
    const first = repeat.occurrences[0];
    const last = repeat.occurrences[repeat.occurrences.length - 1];
    const faster = repeat.changePct < 0;
    found.push({
      id: faster ? "workout-faster" : "workout-slower",
      tone: faster ? "ok" : "warn",
      headline: `"${repeat.label}" is ${Math.abs(repeat.changePct).toFixed(0)}% ${faster ? "faster" : "slower"} than last time`,
      detail: `Work reps averaged ${pace(first.avgWorkPaceSecPerKm)} on ${first.date} and ${pace(last.avgWorkPaceSecPerKm)} on ${last.date}, over comparable volume.`,
    });
  }

  return rank(found, limit);
}
