import { StravaActivity } from "./types/strava";
import {
  estimateTSS,
  formatSecondsAsClock,
  getDiscipline,
  isEnduranceDiscipline,
  type TrainingLoadPoint,
} from "./training";
import {
  aerobicRuns,
  bucketHistogram,
  shiftDays,
  MIN_HR_COVERAGE,
  type ZoneModel,
} from "./quality";
import type { QualityProfile } from "./quality-recap";

/**
 * Block-over-block comparison of easy running, for the coach.
 *
 * The coach gets a digest, never the activity list: an LLM asked to average
 * paces across thirty runs gets it wrong, and the tokens are better spent on
 * interpretation. So every number here is computed, and the comparison carries
 * the measured candidates for WHY easy pace moved — load, intensity mix,
 * terrain, bricks — so the coach reasons from evidence instead of guessing.
 *
 * Easy pace alone is a poor fitness signal: an athlete who slows down because
 * they finally ran easy has improved their training, not lost fitness. Speed
 * per beat (efficiency factor) and pace inside one fixed heart-rate band are
 * what separate the two, which is why the verdict is driven by them.
 */

export interface BlockWindow {
  from: string;
  to: string;
}

/** A dated note from the athlete, e.g. a skipped session's reason. */
export interface AthleteNote {
  date: string;
  text: string;
}

export interface EasyRun {
  id: number;
  date: string;
  name: string;
  km: number;
  durationMin: number;
  paceSec: number;
  hr: number;
  /** Speed per beat x1000, matching buildEfficiencyTrend. */
  ef: number;
  elevPerKm: number;
  /** Started within BRICK_GAP of a ride finishing: slower by construction. */
  brick: boolean;
  /** The previous day held a hard or very big session. */
  afterHardDay: boolean;
  /** Only when the stored profile marked the run steady enough to judge. */
  decouplingPct: number | null;
}

export interface BlockStats {
  from: string;
  to: string;
  weeks: number;
  /** Easy runs with bricks removed — the comparable set. */
  easy: {
    n: number;
    km: number;
    medianPaceSec: number | null;
    medianHr: number | null;
    medianEf: number | null;
    /** Interquartile range of EF as % of the median: how noisy the block is. */
    efSpreadPct: number | null;
    medianElevPerKm: number | null;
    /** Share of easy runs lasting 75 min or more. */
    longShare: number;
    afterHardShare: number;
    bricks: number;
  };
  band: { n: number; paceSec: number | null; hr: number | null };
  decoupling: { n: number; medianPct: number | null };
  /** Time-in-zone across ALL runs in the block, from stored histograms. */
  runZones: {
    covered: number;
    total: number;
    z12Pct: number;
    z3Pct: number;
    z45Pct: number;
  } | null;
  /** Share of easy-run time spent above Z2. High means "easy" was not easy. */
  easyAboveZ2Pct: number | null;
  volume: {
    runKmPerWeek: number;
    runsPerWeek: number;
    longestRunKm: number;
    qualityRunsPerWeek: number;
    hoursPerWeek: number;
    rideHoursPerWeek: number;
    swimHoursPerWeek: number;
    strengthHoursPerWeek: number;
  };
  load: {
    ctlStart: number;
    ctlEnd: number;
    meanAtl: number;
    meanTsb: number;
    minTsb: number;
  } | null;
  notes: AthleteNote[];
}

export type BlockVerdict =
  | "improved"
  | "worse"
  | "easier"
  | "harder"
  | "stable"
  | "insufficient";

export interface BlockComparison {
  from: BlockStats;
  to: BlockStats;
  efChangePct: number | null;
  paceChangeSec: number | null;
  hrChange: number | null;
  bandPaceChangeSec: number | null;
  verdict: BlockVerdict;
  /** Measured changes that could explain the verdict, most telling first. */
  signals: string[];
}

export interface BlockAnalysis {
  band: { low: number; high: number } | null;
  blocks: BlockStats[];
  comparisons: BlockComparison[];
  recent: EasyRun[];
  /** Median EF of the latest block, for reading the recent runs against. */
  latestMedianEf: number | null;
  zonesAvailable: boolean;
}

export interface BlockAnalysisInput {
  activities: StravaActivity[];
  model: ZoneModel;
  profiles: QualityProfile[];
  load: TrainingLoadPoint[];
  /** Chronological, non-overlapping. */
  blocks: BlockWindow[];
  notes?: AthleteNote[];
  recentCount?: number;
}

/** A run starting this soon after a ride ended is a brick run. */
const BRICK_GAP_SECONDS = 30 * 60;
/** Half-width of the shared heart-rate band, matching paceAtHrBand. */
const BAND_HALF_WIDTH = 5;
/** Below this many easy runs a block's medians are anecdotes. */
export const MIN_EASY_RUNS = 4;
/** EF moves about this much on noise alone between neighbouring blocks. */
const EF_NOISE_PCT = 3;
const LONG_RUN_SECONDS = 75 * 60;
/** A day with this much estimated load is hard however it was ridden. */
const BIG_DAY_TSS = 120;

const day = (a: StravaActivity) => a.start_date_local.split("T")[0];
const round = (x: number, dp = 0) => Math.round(x * 10 ** dp) / 10 ** dp;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function inWindow(date: string, w: BlockWindow): boolean {
  return date >= w.from && date <= w.to;
}

function daysInclusive(w: BlockWindow): number {
  return (
    Math.round(
      (Date.parse(`${w.to}T00:00:00Z`) - Date.parse(`${w.from}T00:00:00Z`)) /
        86_400_000,
    ) + 1
  );
}

/**
 * Turn the coach's request into concrete windows.
 *
 * Explicit ranges win. Otherwise `count` back-to-back blocks of `weeks` weeks,
 * the newest ending today. Everything is clipped to [earliest, today] so a
 * window can never claim to describe days that have not happened.
 */
export function resolveBlockWindows(
  opts: {
    blocks?: { from: string; to: string }[];
    weeks?: number;
    count?: number;
  },
  today: string,
  earliest: string,
): BlockWindow[] {
  const isDate = (s: unknown): s is string =>
    typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

  if (opts.blocks && opts.blocks.length > 0) {
    if (opts.blocks.length > 6) throw new Error("At most 6 blocks");
    const windows = opts.blocks.map((b) => {
      if (!isDate(b.from) || !isDate(b.to)) throw new Error("Block dates must be YYYY-MM-DD");
      const from = b.from < earliest ? earliest : b.from;
      const to = b.to > today ? today : b.to;
      if (from > to) throw new Error(`Block ${b.from} to ${b.to} is empty or outside the available history (${earliest} to ${today})`);
      return { from, to };
    });
    windows.sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 1; i < windows.length; i++) {
      if (windows[i].from <= windows[i - 1].to) throw new Error("Blocks must not overlap");
    }
    return windows;
  }

  const weeks = Math.min(12, Math.max(1, Math.round(opts.weeks ?? 6)));
  const count = Math.min(6, Math.max(2, Math.round(opts.count ?? 3)));
  const windows: BlockWindow[] = [];
  let to = today;
  for (let i = 0; i < count; i++) {
    const from = shiftDays(to, -(weeks * 7 - 1));
    if (to < earliest) break;
    windows.unshift({ from: from < earliest ? earliest : from, to });
    to = shiftDays(from, -1);
  }
  return windows;
}

/** Days holding a hard or very large session, for the "tired legs" check. */
function hardDays(activities: StravaActivity[], model: ZoneModel): Set<string> {
  const tssByDay = new Map<string, number>();
  const hard = new Set<string>();
  for (const a of activities) {
    const d = day(a);
    tssByDay.set(d, (tssByDay.get(d) ?? 0) + estimateTSS(a));
    const disc = getDiscipline(a);
    if (!isEnduranceDiscipline(disc) || a.moving_time < 20 * 60) continue;
    // Tagged races and workouts count even without a strap.
    if (disc === "run" && (a.workout_type === 1 || a.workout_type === 3)) hard.add(d);
    if (model.source !== "none" && a.average_heartrate && a.average_heartrate >= model.floors[2]) {
      hard.add(d);
    }
  }
  for (const [d, tss] of tssByDay) if (tss >= BIG_DAY_TSS) hard.add(d);
  return hard;
}

function isBrick(run: StravaActivity, rides: StravaActivity[]): boolean {
  const start = Date.parse(run.start_date) / 1000;
  return rides.some((r) => {
    const end = Date.parse(r.start_date) / 1000 + r.elapsed_time;
    return start >= end - 60 && start - end <= BRICK_GAP_SECONDS;
  });
}

function toEasyRun(
  a: StravaActivity,
  ctx: { rides: StravaActivity[]; hard: Set<string>; profiles: Map<string, QualityProfile> },
): EasyRun {
  const km = a.distance / 1000;
  const p = ctx.profiles.get(String(a.id));
  return {
    id: a.id,
    date: day(a),
    name: a.name,
    km: round(km, 1),
    durationMin: Math.round(a.moving_time / 60),
    paceSec: Math.round(a.moving_time / km),
    hr: Math.round(a.average_heartrate!),
    ef: round((a.distance / a.moving_time / a.average_heartrate!) * 1000, 2),
    elevPerKm: round((a.total_elevation_gain ?? 0) / km, 1),
    brick: isBrick(a, ctx.rides),
    afterHardDay: ctx.hard.has(shiftDays(day(a), -1)),
    decouplingPct:
      p && p.decouplingEligible && p.decoupling != null ? round(p.decoupling, 1) : null,
  };
}

function blockStats(
  w: BlockWindow,
  input: BlockAnalysisInput,
  easyAll: EasyRun[],
  band: { low: number; high: number } | null,
  profiles: Map<string, QualityProfile>,
): BlockStats {
  const { activities, model } = input;
  const weeks = daysInclusive(w) / 7;
  const inBlock = activities.filter((a) => inWindow(day(a), w));
  const runs = inBlock.filter((a) => getDiscipline(a) === "run");

  const allEasy = easyAll.filter((r) => inWindow(r.date, w));
  const easy = allEasy.filter((r) => !r.brick);
  const efs = easy.map((r) => r.ef);
  const medianEf = median(efs);

  const inBand = band ? easy.filter((r) => r.hr >= band.low && r.hr <= band.high) : [];
  const bandKm = inBand.reduce((s, r) => s + r.km, 0);
  const bandSec = inBand.reduce((s, r) => s + r.paceSec * r.km, 0);

  const decouplings = easy.flatMap((r) => (r.decouplingPct == null ? [] : [r.decouplingPct]));

  // Zone mix only from sessions whose strap held for most of the run; a
  // half-covered histogram skews towards whatever stretch it caught.
  let runZones: BlockStats["runZones"] = null;
  let easyAboveZ2Pct: number | null = null;
  if (model.source !== "none") {
    const zoneOf = (ids: string[]) => {
      const secs = [0, 0, 0, 0, 0];
      let covered = 0;
      for (const id of ids) {
        const p = profiles.get(id);
        if (!p?.hrSeconds || (p.hrCoverage ?? 0) < MIN_HR_COVERAGE) continue;
        covered++;
        bucketHistogram(p.hrSeconds, model).seconds.forEach((s, i) => (secs[i] += s));
      }
      const total = secs.reduce((a, b) => a + b, 0);
      return { secs, total, covered };
    };
    const all = zoneOf(runs.map((a) => String(a.id)));
    if (all.total > 0) {
      runZones = {
        covered: all.covered,
        total: runs.length,
        z12Pct: Math.round(((all.secs[0] + all.secs[1]) / all.total) * 100),
        z3Pct: Math.round((all.secs[2] / all.total) * 100),
        z45Pct: Math.round(((all.secs[3] + all.secs[4]) / all.total) * 100),
      };
    }
    const e = zoneOf(easy.map((r) => String(r.id)));
    if (e.total > 0) {
      easyAboveZ2Pct = Math.round(((e.secs[2] + e.secs[3] + e.secs[4]) / e.total) * 100);
    }
  }

  const hours = (pred: (a: StravaActivity) => boolean) =>
    round(inBlock.filter(pred).reduce((s, a) => s + a.moving_time, 0) / 3600 / weeks, 1);
  const runKm = runs.reduce((s, a) => s + a.distance, 0) / 1000;
  const qualityRuns = runs.filter(
    (a) =>
      a.workout_type === 1 ||
      a.workout_type === 3 ||
      (model.source !== "none" && (a.average_heartrate ?? 0) >= model.floors[2]),
  ).length;

  const loadPts = input.load.filter((p) => inWindow(p.date, w));
  const load = loadPts.length
    ? {
        ctlStart: loadPts[0].ctl,
        ctlEnd: loadPts[loadPts.length - 1].ctl,
        meanAtl: round(loadPts.reduce((s, p) => s + p.atl, 0) / loadPts.length, 1),
        meanTsb: round(loadPts.reduce((s, p) => s + p.tsb, 0) / loadPts.length, 1),
        minTsb: Math.min(...loadPts.map((p) => p.tsb)),
      }
    : null;

  const share = (n: number) => (easy.length ? round(n / easy.length, 2) : 0);

  return {
    from: w.from,
    to: w.to,
    weeks: round(weeks, 1),
    easy: {
      n: easy.length,
      km: round(easy.reduce((s, r) => s + r.km, 0)),
      medianPaceSec: median(easy.map((r) => r.paceSec)),
      medianHr: median(easy.map((r) => r.hr)),
      medianEf: medianEf == null ? null : round(medianEf, 2),
      efSpreadPct:
        efs.length >= MIN_EASY_RUNS && medianEf
          ? round(((quantile(efs, 0.75) - quantile(efs, 0.25)) / medianEf) * 100, 1)
          : null,
      medianElevPerKm: median(easy.map((r) => r.elevPerKm)),
      longShare: share(easy.filter((r) => r.durationMin * 60 >= LONG_RUN_SECONDS).length),
      afterHardShare: share(easy.filter((r) => r.afterHardDay).length),
      bricks: allEasy.length - easy.length,
    },
    band: {
      n: inBand.length,
      paceSec: bandKm > 0 ? Math.round(bandSec / bandKm) : null,
      hr: median(inBand.map((r) => r.hr)),
    },
    decoupling: { n: decouplings.length, medianPct: median(decouplings) },
    runZones,
    easyAboveZ2Pct,
    volume: {
      runKmPerWeek: round(runKm / weeks, 1),
      runsPerWeek: round(runs.length / weeks, 1),
      longestRunKm: round(Math.max(0, ...runs.map((a) => a.distance / 1000)), 1),
      qualityRunsPerWeek: round(qualityRuns / weeks, 1),
      hoursPerWeek: hours(() => true),
      rideHoursPerWeek: hours((a) => getDiscipline(a) === "ride"),
      swimHoursPerWeek: hours((a) => getDiscipline(a) === "swim"),
      strengthHoursPerWeek: hours((a) => getDiscipline(a) === "strength"),
    },
    load,
    notes: (input.notes ?? []).filter((n) => inWindow(n.date, w)),
  };
}

const pctChange = (a: number, b: number) => (a > 0 ? ((b - a) / a) * 100 : 0);

export function compareBlocks(prev: BlockStats, cur: BlockStats): BlockComparison {
  const enough =
    prev.easy.n >= MIN_EASY_RUNS &&
    cur.easy.n >= MIN_EASY_RUNS &&
    prev.easy.medianEf != null &&
    cur.easy.medianEf != null;

  const efChangePct =
    prev.easy.medianEf && cur.easy.medianEf != null
      ? round(pctChange(prev.easy.medianEf, cur.easy.medianEf), 1)
      : null;
  const paceChangeSec =
    prev.easy.medianPaceSec != null && cur.easy.medianPaceSec != null
      ? Math.round(cur.easy.medianPaceSec - prev.easy.medianPaceSec)
      : null;
  const hrChange =
    prev.easy.medianHr != null && cur.easy.medianHr != null
      ? Math.round(cur.easy.medianHr - prev.easy.medianHr)
      : null;
  const bandPaceChangeSec =
    prev.band.paceSec != null && cur.band.paceSec != null
      ? cur.band.paceSec - prev.band.paceSec
      : null;

  // EF decides fitness; raw pace and HR only explain a stable EF. A slower
  // easy pace at a lower heart rate is the athlete obeying the plan.
  let verdict: BlockVerdict = "insufficient";
  if (enough && efChangePct != null) {
    if (efChangePct <= -EF_NOISE_PCT) verdict = "worse";
    else if (efChangePct >= EF_NOISE_PCT) verdict = "improved";
    else if ((paceChangeSec ?? 0) >= 5 && (hrChange ?? 0) <= -2) verdict = "easier";
    else if ((paceChangeSec ?? 0) <= -5 && (hrChange ?? 0) >= 2) verdict = "harder";
    else verdict = "stable";
  }

  const signals: string[] = [];
  const pl = prev.load;
  const cl = cur.load;
  if (pl && cl && cl.meanTsb < -10 && cl.meanTsb < pl.meanTsb - 5) {
    signals.push(`Fatigue: mean form (TSB) ${pl.meanTsb} -> ${cl.meanTsb}, lowest ${cl.minTsb}`);
  } else if (pl && cl && pl.meanAtl > 0 && pctChange(pl.meanAtl, cl.meanAtl) >= 20) {
    signals.push(`Fatigue: mean ATL up ${Math.round(pctChange(pl.meanAtl, cl.meanAtl))}% (${pl.meanAtl} -> ${cl.meanAtl})`);
  }
  // Fitness ebbing inside the block: a taper, an illness, or a quiet stretch.
  // Easy pace lags CTL, so this often explains a drop the volume lines miss.
  if (cl && cl.ctlStart > 0 && cl.ctlEnd <= cl.ctlStart * 0.9) {
    signals.push(`Fitness (CTL) fell across the block: ${cl.ctlStart} -> ${cl.ctlEnd}`);
  }
  const pv = prev.volume;
  const cv = cur.volume;
  if (pv.hoursPerWeek > 0 && pctChange(pv.hoursPerWeek, cv.hoursPerWeek) >= 20) {
    signals.push(`Total training up ${Math.round(pctChange(pv.hoursPerWeek, cv.hoursPerWeek))}%: ${pv.hoursPerWeek} -> ${cv.hoursPerWeek} h/week`);
  }
  if (pv.runKmPerWeek > 0) {
    const ch = pctChange(pv.runKmPerWeek, cv.runKmPerWeek);
    if (ch >= 20) signals.push(`Run volume ramp: ${pv.runKmPerWeek} -> ${cv.runKmPerWeek} km/week (+${Math.round(ch)}%)`);
    if (ch <= -25) signals.push(`Less running: ${pv.runKmPerWeek} -> ${cv.runKmPerWeek} km/week (${Math.round(ch)}%), a smaller aerobic stimulus`);
  }
  if (cv.rideHoursPerWeek - pv.rideHoursPerWeek >= 1 && pctChange(pv.rideHoursPerWeek || 0.1, cv.rideHoursPerWeek) >= 25) {
    signals.push(`More bike load on the legs: ${pv.rideHoursPerWeek} -> ${cv.rideHoursPerWeek} h/week riding`);
  }
  if (cv.qualityRunsPerWeek - pv.qualityRunsPerWeek >= 0.5) {
    signals.push(`More hard running: ${pv.qualityRunsPerWeek} -> ${cv.qualityRunsPerWeek} quality runs/week`);
  }
  if (prev.runZones && cur.runZones) {
    const p = prev.runZones.z3Pct + prev.runZones.z45Pct;
    const c = cur.runZones.z3Pct + cur.runZones.z45Pct;
    if (c - p >= 5) signals.push(`Intensity creep: run time above Z2 ${p}% -> ${c}%`);
  }
  if (cur.easyAboveZ2Pct != null && (cur.easyAboveZ2Pct >= 20 || (prev.easyAboveZ2Pct != null && cur.easyAboveZ2Pct - prev.easyAboveZ2Pct >= 5))) {
    signals.push(`Easy runs not fully easy: ${cur.easyAboveZ2Pct}% of easy-run time above Z2${prev.easyAboveZ2Pct != null ? ` (was ${prev.easyAboveZ2Pct}%)` : ""}`);
  }
  if (cur.easy.afterHardShare - prev.easy.afterHardShare >= 0.15) {
    signals.push(`More easy runs on tired legs (day after a hard session): ${Math.round(prev.easy.afterHardShare * 100)}% -> ${Math.round(cur.easy.afterHardShare * 100)}%`);
  }
  if (prev.easy.medianElevPerKm != null && cur.easy.medianElevPerKm != null && cur.easy.medianElevPerKm - prev.easy.medianElevPerKm >= 5) {
    signals.push(`Hillier easy runs: ${prev.easy.medianElevPerKm} -> ${cur.easy.medianElevPerKm} m climbing per km`);
  }
  if (cur.easy.longShare - prev.easy.longShare >= 0.2) {
    signals.push(`More long runs in the easy mix (75+ min): ${Math.round(prev.easy.longShare * 100)}% -> ${Math.round(cur.easy.longShare * 100)}%`);
  }
  if (prev.decoupling.medianPct != null && cur.decoupling.medianPct != null && cur.decoupling.medianPct - prev.decoupling.medianPct >= 2) {
    signals.push(`Aerobic durability slipping: decoupling ${prev.decoupling.medianPct}% -> ${cur.decoupling.medianPct}%`);
  }
  if (cur.notes.length > 0) {
    signals.push(`Athlete notes in this block: ${cur.notes.map((n) => `${n.date} "${n.text}"`).join("; ")}`);
  }

  return { from: prev, to: cur, efChangePct, paceChangeSec, hrChange, bandPaceChangeSec, verdict, signals };
}

export function buildBlockAnalysis(input: BlockAnalysisInput): BlockAnalysis {
  const { activities, model, blocks } = input;
  const profiles = new Map(input.profiles.map((p) => [p.activityId, p]));
  const zonesAvailable = model.source !== "none";

  if (!zonesAvailable || blocks.length === 0) {
    return { band: null, blocks: [], comparisons: [], recent: [], latestMedianEf: null, zonesAvailable };
  }

  const rides = activities.filter((a) => getDiscipline(a) === "ride");
  const hard = hardDays(activities, model);
  const ctx = { rides, hard, profiles };
  const span = { from: blocks[0].from, to: blocks[blocks.length - 1].to };
  const easyAll = aerobicRuns(activities, model, span.from, span.to).map((a) => toEasyRun(a, ctx));

  // ONE band for every block. Re-centring it per block on that block's median
  // heart rate would compare 140-bpm pace with 146-bpm pace and call the
  // difference fitness.
  const centre = median(easyAll.filter((r) => !r.brick).map((r) => r.hr));
  const band =
    centre == null
      ? null
      : { low: Math.round(centre) - BAND_HALF_WIDTH, high: Math.round(centre) + BAND_HALF_WIDTH };

  const stats = blocks.map((w) => blockStats(w, input, easyAll, band, profiles));
  const comparisons = stats.slice(1).map((s, i) => compareBlocks(stats[i], s));

  // Recent runs straight from the full history, not the last block: the
  // athlete asking about "my latest runs" means the latest, whatever the window.
  const recent = aerobicRuns(activities, model, "0000-00-00", "9999-12-31")
    .slice(-(input.recentCount ?? 6))
    .map((a) => toEasyRun(a, ctx))
    .reverse();

  return {
    band,
    blocks: stats,
    comparisons,
    recent,
    latestMedianEf: stats[stats.length - 1].easy.medianEf,
    zonesAvailable,
  };
}

const pace = (sec: number | null) => (sec == null ? "-" : `${formatSecondsAsClock(sec)}/km`);
const signed = (x: number, unit = "") => `${x > 0 ? "+" : ""}${x}${unit}`;

const VERDICT_TEXT: Record<BlockVerdict, string> = {
  improved: "IMPROVED: faster for the same heart rate (aerobic fitness up)",
  worse: "WORSE: slower for the same heart rate (aerobic efficiency down)",
  easier: "RUNNING EASIER: slower pace but at a lower heart rate; fitness unchanged",
  harder: "RUNNING HARDER: faster pace bought with a higher heart rate; fitness unchanged",
  stable: "STABLE: within normal noise",
  insufficient: `NOT ENOUGH DATA: fewer than ${MIN_EASY_RUNS} easy runs with HR in one of the blocks`,
};

/** The digest the coach reads. Kept to a few lines per block on purpose. */
export function formatBlockAnalysis(a: BlockAnalysis): string {
  if (!a.zonesAvailable) {
    return "No heart-rate zones and no heart-rate history to estimate them from, so easy runs cannot be told apart from hard ones. Block analysis needs runs recorded with a heart-rate monitor.";
  }
  if (a.blocks.length === 0) return "No blocks in the requested range.";

  const lines: string[] = [];
  lines.push(
    `Easy runs = runs of 20+ min averaging below Z3, excluding bricks. EF = speed per heartbeat (x1000), higher is fitter.`,
  );
  if (a.band) {
    lines.push(`Fixed HR band for like-for-like pace: ${a.band.low}-${a.band.high} bpm (same band in every block).`);
  }

  a.blocks.forEach((b, i) => {
    const e = b.easy;
    const v = b.volume;
    lines.push("");
    lines.push(`## Block ${i + 1}: ${b.from} to ${b.to} (${b.weeks} weeks)`);
    lines.push(
      `Easy: ${e.n} runs, ${e.km}km | median ${pace(e.medianPaceSec)} @ ${e.medianHr ?? "-"} bpm | EF ${e.medianEf ?? "-"}` +
        (e.efSpreadPct != null ? ` (spread ${e.efSpreadPct}%)` : "") +
        (e.bricks ? ` | ${e.bricks} brick run(s) excluded` : ""),
    );
    lines.push(
      `In band: ${b.band.n} runs at ${pace(b.band.paceSec)}` +
        ` | decoupling: ${b.decoupling.medianPct != null ? `${b.decoupling.medianPct}% median of ${b.decoupling.n}` : "no steady runs scanned"}` +
        ` | climbing ${e.medianElevPerKm ?? "-"} m/km | ${Math.round(e.longShare * 100)}% long (75+ min) | ${Math.round(e.afterHardShare * 100)}% day after a hard session`,
    );
    lines.push(
      `Running: ${v.runKmPerWeek} km/week, ${v.runsPerWeek} runs/week, ${v.qualityRunsPerWeek} quality/week, longest ${v.longestRunKm}km` +
        (b.runZones
          ? ` | run time Z1-2 ${b.runZones.z12Pct}% / Z3 ${b.runZones.z3Pct}% / Z4-5 ${b.runZones.z45Pct}% (${b.runZones.covered}/${b.runZones.total} runs with HR streams)`
          : " | no time-in-zone data") +
        (b.easyAboveZ2Pct != null ? ` | easy-run time above Z2: ${b.easyAboveZ2Pct}%` : ""),
    );
    lines.push(
      `All training: ${v.hoursPerWeek} h/week (ride ${v.rideHoursPerWeek}, swim ${v.swimHoursPerWeek}, strength ${v.strengthHoursPerWeek})` +
        (b.load
          ? ` | CTL ${b.load.ctlStart} -> ${b.load.ctlEnd}, mean ATL ${b.load.meanAtl}, mean TSB ${b.load.meanTsb} (low ${b.load.minTsb})`
          : ""),
    );
    if (b.notes.length) {
      lines.push(`Athlete notes: ${b.notes.map((n) => `${n.date} "${n.text}"`).join("; ")}`);
    }
  });

  for (const c of a.comparisons) {
    lines.push("");
    lines.push(`## ${c.from.from} block -> ${c.to.from} block`);
    lines.push(
      `Verdict: ${VERDICT_TEXT[c.verdict]}` +
        ` | EF ${c.efChangePct != null ? signed(c.efChangePct, "%") : "-"}` +
        ` | easy pace ${c.paceChangeSec != null ? signed(c.paceChangeSec, "s/km") : "-"}` +
        ` | easy HR ${c.hrChange != null ? signed(c.hrChange, " bpm") : "-"}` +
        ` | in-band pace ${c.bandPaceChangeSec != null ? signed(c.bandPaceChangeSec, "s/km") : "-"}`,
    );
    lines.push(
      c.signals.length
        ? `Measured changes that could explain it:\n${c.signals.map((s) => `- ${s}`).join("\n")}`
        : "Measured changes that could explain it: none flagged (load, volume, intensity, terrain and run mix all similar).",
    );
  }

  if (a.recent.length) {
    lines.push("");
    lines.push(`## Latest easy runs (newest first)${a.latestMedianEf ? `, EF vs latest block median ${a.latestMedianEf}` : ""}`);
    for (const r of a.recent) {
      const vs = a.latestMedianEf ? ` (${signed(round(pctChange(a.latestMedianEf, r.ef), 1), "%")})` : "";
      const flags = [
        r.brick ? "brick" : null,
        r.afterHardDay ? "day after hard session" : null,
        r.decouplingPct != null ? `decoupling ${r.decouplingPct}%` : null,
      ].filter(Boolean);
      lines.push(
        `- ${r.date} "${r.name}" ${r.km}km ${r.durationMin}min ${pace(r.paceSec)} @ ${r.hr} bpm, EF ${r.ef}${vs}, ${r.elevPerKm} m/km` +
          (flags.length ? ` [${flags.join(", ")}]` : ""),
      );
    }
  }

  return lines.join("\n");
}
