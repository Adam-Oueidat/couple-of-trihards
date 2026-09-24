import { StravaActivity } from "./types/strava";
import {
  estimateTSS,
  getDiscipline,
  getWeekStart,
  localToday,
  type TrainingLoadPoint,
} from "./training";
import {
  matchSessions,
  planAdherence,
  racePhase,
  type CustomWorkoutInput,
  type PlanAdherence,
  type PlanOverrideMap,
  type SessionType,
  type TrainingPlan,
} from "./plan";

/**
 * How much training history a recap looks back over, and why it is six weeks
 * and not four or eight.
 *
 * CTL — the "Fitness" number this app already shows — is an exponential moving
 * average with a 42-day time constant. Six weeks is therefore not a round
 * number picked for tidiness: it is precisely the span of training that
 * produced the fitness the athlete is carrying today. A shorter window reads as
 * noise (one rest week swings it), a longer one averages across what are
 * usually two different training phases and stops describing anything.
 *
 * The window is then compared against the six weeks immediately before it, so
 * every figure has something to be bigger or smaller than. A recap with no
 * comparison is a list of numbers, not a summary.
 */
export const BLOCK_WEEKS = 6;
export const BLOCK_DAYS = BLOCK_WEEKS * 7;

/** The three triathlon disciplines. Excludes `other`, which no recap counts. */
export type TriDiscipline = "swim" | "ride" | "run";

export const TRI_DISCIPLINES: readonly TriDiscipline[] = ["swim", "ride", "run"];

/**
 * Everything that counts as training time: the three legs plus strength.
 * Totals, daily breakdowns and time shares use this; insights about a leg
 * "falling off" and the endurance-only reads stay on TRI_DISCIPLINES.
 */
export type TrainingDiscipline = TriDiscipline | "strength";

export const TRAINING_DISCIPLINES: readonly TrainingDiscipline[] = ["swim", "ride", "run", "strength"];

export interface DisciplineTotals {
  km: number;
  minutes: number;
  sessions: number;
}

export interface BlockTotals {
  sessions: number;
  minutes: number;
  elevation: number;
  tss: number;
  byDiscipline: Record<TrainingDiscipline, DisciplineTotals>;
}

export interface RecapDay {
  date: string;
  /** Sessions started on this day. Zero means a rest day. */
  sessions: number;
  tss: number;
  minutes: number;
  /** The discipline that took the most time this day; null on a rest day. */
  dominant: TrainingDiscipline | null;
  /** Fitness (CTL) at the end of this day. */
  ctl: number;
}

export interface RecapWeek {
  /**
   * First day of this rolling week. Rolling, not calendar: the window is
   * anchored on today, so chunking it into calendar weeks would produce two
   * partial weeks at the ends whose totals are not comparable with the four
   * full ones in between. Seven-day chunks from the window's start give six
   * equal weeks that the day strip can line up with exactly.
   */
  start: string;
  end: string;
  minutes: number;
  tss: number;
  sessions: number;
  daysTrained: number;
}

export interface BlockFitness {
  /** CTL on the day before the window opened — what the athlete brought in. */
  ctlStart: number;
  ctlEnd: number;
  ctlPeak: number;
  atlEnd: number;
  tsbEnd: number;
  /** CTL points gained per week across the window. */
  rampPerWeek: number;
}

export interface BlockRecap {
  start: string;
  end: string;
  priorStart: string;
  priorEnd: string;
  days: number;
  weeks: number;
  totals: BlockTotals;
  prior: BlockTotals;
  daily: RecapDay[];
  weekly: RecapWeek[];
  daysTrained: number;
  /** Longest run of consecutive rest days inside the window. */
  longestGap: number;
  /** Longest run of consecutive days with at least one session. */
  longestStreak: number;
  fitness: BlockFitness | null;
  biggestWeek: RecapWeek | null;
  longestSession: {
    name: string;
    date: string;
    minutes: number;
    km: number;
    discipline: TriDiscipline;
  } | null;
}

function emptyTotals(): BlockTotals {
  return {
    sessions: 0,
    minutes: 0,
    elevation: 0,
    tss: 0,
    byDiscipline: {
      swim: { km: 0, minutes: 0, sessions: 0 },
      ride: { km: 0, minutes: 0, sessions: 0 },
      run: { km: 0, minutes: 0, sessions: 0 },
      strength: { km: 0, minutes: 0, sessions: 0 },
    },
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Step a calendar date by whole days in UTC.
 *
 * Deliberately UTC rather than local: stepping with the local setDate/getDate
 * across a DST boundary keeps the wall clock and drifts the cursor off
 * midnight, which eventually drops or duplicates a day. The same reasoning as
 * the day walk in calcTrainingLoad.
 */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

/** ISO dates compare correctly as strings, so the window test is a string test. */
function inWindow(day: string, start: string, end: string): boolean {
  return day >= start && day <= end;
}

function accumulate(totals: BlockTotals, act: StravaActivity): void {
  const discipline = getDiscipline(act);
  if (discipline === "other") return;
  const minutes = act.moving_time / 60;
  totals.sessions++;
  totals.minutes += minutes;
  totals.elevation += act.total_elevation_gain ?? 0;
  totals.tss += estimateTSS(act);
  const d = totals.byDiscipline[discipline];
  d.sessions++;
  d.minutes += minutes;
  d.km += act.distance / 1000;
}

function finalizeTotals(totals: BlockTotals): BlockTotals {
  totals.minutes = round1(totals.minutes);
  totals.elevation = Math.round(totals.elevation);
  totals.tss = Math.round(totals.tss);
  for (const key of TRAINING_DISCIPLINES) {
    const d = totals.byDiscipline[key];
    d.minutes = round1(d.minutes);
    d.km = round1(d.km);
  }
  return totals;
}

function totalsFor(
  activities: StravaActivity[],
  start: string,
  end: string,
): BlockTotals {
  const totals = emptyTotals();
  for (const act of activities) {
    if (!inWindow(act.start_date_local.split("T")[0], start, end)) continue;
    accumulate(totals, act);
  }
  return finalizeTotals(totals);
}

/**
 * Fitness on any date, carried forward from the last day the series covers.
 *
 * calcTrainingLoad emits a contiguous run of days from the first activity to
 * today, so a date inside that run is a direct hit. A date before it (an
 * athlete whose history starts mid-window) has no fitness yet and reads 0,
 * which is the honest answer rather than a borrowed one.
 */
function ctlLookup(trainingLoad: TrainingLoadPoint[]): (date: string) => TrainingLoadPoint | null {
  const byDate = new Map<string, TrainingLoadPoint>();
  for (const p of trainingLoad) byDate.set(p.date, p);
  const first = trainingLoad[0]?.date;
  const last = trainingLoad[trainingLoad.length - 1];
  return (date: string) => {
    const hit = byDate.get(date);
    if (hit) return hit;
    if (!first || date < first) return null;
    // Past the end of the series (shouldn't happen — it runs through today) —
    // the last known point is the best available answer.
    return last ?? null;
  };
}

/**
 * Condense the last six weeks of training into one object the UI can render
 * without doing arithmetic of its own.
 *
 * `today` is the athlete's local date. Server callers must pass their resolved
 * local date rather than leaning on the default, which reads the server clock.
 */
export function buildBlockRecap(
  activities: StravaActivity[],
  trainingLoad: TrainingLoadPoint[],
  today: string = localToday(),
): BlockRecap {
  const end = today;
  const start = addDays(end, -(BLOCK_DAYS - 1));
  const priorEnd = addDays(start, -1);
  const priorStart = addDays(priorEnd, -(BLOCK_DAYS - 1));

  const totals = totalsFor(activities, start, end);
  const prior = totalsFor(activities, priorStart, priorEnd);

  const ctlAt = ctlLookup(trainingLoad);

  // One pass over the window's activities, bucketed by day.
  const byDay = new Map<string, StravaActivity[]>();
  for (const act of activities) {
    const day = act.start_date_local.split("T")[0];
    if (!inWindow(day, start, end)) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), act]);
  }

  const daily: RecapDay[] = [];
  for (let i = 0; i < BLOCK_DAYS; i++) {
    const date = addDays(start, i);
    const acts = byDay.get(date) ?? [];
    let tss = 0;
    let minutes = 0;
    const timeByDiscipline: Record<TrainingDiscipline, number> = { swim: 0, ride: 0, run: 0, strength: 0 };
    for (const act of acts) {
      const discipline = getDiscipline(act);
      if (discipline === "other") continue;
      tss += estimateTSS(act);
      minutes += act.moving_time / 60;
      timeByDiscipline[discipline] += act.moving_time / 60;
    }
    let dominant: TrainingDiscipline | null = null;
    for (const key of TRAINING_DISCIPLINES) {
      if (timeByDiscipline[key] > 0 && (!dominant || timeByDiscipline[key] > timeByDiscipline[dominant])) {
        dominant = key;
      }
    }
    daily.push({
      date,
      sessions: dominant ? acts.filter((a) => getDiscipline(a) !== "other").length : 0,
      tss: Math.round(tss),
      minutes: round1(minutes),
      dominant,
      ctl: ctlAt(date)?.ctl ?? 0,
    });
  }

  const weekly: RecapWeek[] = [];
  for (let w = 0; w < BLOCK_WEEKS; w++) {
    const days = daily.slice(w * 7, w * 7 + 7);
    weekly.push({
      start: days[0].date,
      end: days[days.length - 1].date,
      minutes: round1(days.reduce((sum, d) => sum + d.minutes, 0)),
      tss: days.reduce((sum, d) => sum + d.tss, 0),
      sessions: days.reduce((sum, d) => sum + d.sessions, 0),
      daysTrained: days.filter((d) => d.sessions > 0).length,
    });
  }

  let longestGap = 0;
  let longestStreak = 0;
  let gap = 0;
  let streak = 0;
  for (const d of daily) {
    if (d.sessions > 0) {
      streak++;
      gap = 0;
    } else {
      gap++;
      streak = 0;
    }
    longestGap = Math.max(longestGap, gap);
    longestStreak = Math.max(longestStreak, streak);
  }

  const endPoint = ctlAt(end);
  const startPoint = ctlAt(priorEnd);
  const fitness: BlockFitness | null = endPoint
    ? {
        ctlStart: round1(startPoint?.ctl ?? 0),
        ctlEnd: round1(endPoint.ctl),
        ctlPeak: round1(Math.max(...daily.map((d) => d.ctl))),
        atlEnd: round1(endPoint.atl),
        tsbEnd: round1(endPoint.tsb),
        rampPerWeek: round1((endPoint.ctl - (startPoint?.ctl ?? 0)) / BLOCK_WEEKS),
      }
    : null;

  const biggestWeek =
    weekly.reduce<RecapWeek | null>(
      (best, w) => (w.minutes > 0 && (!best || w.minutes > best.minutes) ? w : best),
      null,
    ) ?? null;

  let longestSession: BlockRecap["longestSession"] = null;
  for (const act of activities) {
    const day = act.start_date_local.split("T")[0];
    if (!inWindow(day, start, end)) continue;
    const discipline = getDiscipline(act);
    // The longest endurance session: an hour in the gym is not a long day.
    if (discipline === "other" || discipline === "strength") continue;
    if (!longestSession || act.moving_time / 60 > longestSession.minutes) {
      longestSession = {
        name: act.name,
        date: day,
        minutes: round1(act.moving_time / 60),
        km: round1(act.distance / 1000),
        discipline,
      };
    }
  }

  return {
    start,
    end,
    priorStart,
    priorEnd,
    days: BLOCK_DAYS,
    weeks: BLOCK_WEEKS,
    totals,
    prior,
    daily,
    weekly,
    daysTrained: daily.filter((d) => d.sessions > 0).length,
    longestGap,
    longestStreak,
    fitness,
    biggestWeek,
    longestSession,
  };
}

/** Share of a block's training time taken by each discipline, as percentages. */
export function timeShare(totals: BlockTotals): Record<TrainingDiscipline, number> {
  const total = totals.minutes;
  const share = { swim: 0, ride: 0, run: 0, strength: 0 };
  if (total <= 0) return share;
  for (const key of TRAINING_DISCIPLINES) {
    share[key] = Math.round((totals.byDiscipline[key].minutes / total) * 100);
  }
  return share;
}

// ---------------------------------------------------------------------------
// Plan recap
// ---------------------------------------------------------------------------

export interface PlanTypeAdherence {
  type: SessionType;
  done: number;
  total: number;
  plannedKm: number;
  actualKm: number;
}

export interface PlanWeekRecap {
  weekStart: string;
  plannedKm: number;
  actualKm: number;
  done: number;
  total: number;
}

/**
 * What the plan did to the athlete's fitness, measured AT THE START LINE.
 *
 * Every figure here is read from the day before the race, never from race day
 * itself, and that distinction is the whole correctness of this block. The
 * load series applies a day's training at the END of that day, so the race —
 * by far the hardest effort in the plan — lands in race day's own ATL. Reading
 * TSB there answers "how wrecked did the race leave me", and the recap was
 * reporting that as "how fresh did you arrive": one real half marathon showed
 * +24.8 the evening before and -8.4 once its own 328 TSS was counted, so a
 * textbook taper was being read back to the athlete as racing tired.
 *
 * The race is the exam, not the study. Measuring at the start line is what
 * makes these numbers a verdict on the plan rather than on the race.
 */
export interface PlanRecapFitness {
  /** CTL the day before the plan started. */
  ctlStart: number;
  /** CTL on the morning of the race — the fitness the plan actually built. */
  ctlStartLine: number;
  /** Highest CTL reached between the plan's start and the start line. */
  ctlPeak: number;
  /** Fatigue on the morning of the race — how far the taper shed it. */
  atlStartLine: number;
  /** Form on the morning of the race — whether the taper landed. */
  tsbStartLine: number;
}

export interface PlanRecap {
  name: string;
  raceName: string;
  raceDate: string;
  startDate: string;
  discipline: string;
  weeks: number;
  daysSinceRace: number;
  adherence: PlanAdherence;
  /** Session types the plan actually used, ordered by how many it prescribed. */
  byType: PlanTypeAdherence[];
  weekly: PlanWeekRecap[];
  fitness: PlanRecapFitness | null;
  /** Reasons the athlete gave for skipping, most common first. */
  skips: { reason: string; count: number }[];
}

function planWeeks(startDate: string, raceDate: string): number {
  const ms =
    new Date(raceDate + "T12:00:00").getTime() -
    new Date(startDate + "T12:00:00").getTime();
  return Math.max(1, Math.round(ms / (7 * 24 * 3600 * 1000)));
}

/**
 * How a plan actually went, once it is over.
 *
 * Built on top of matchSessions and planAdherence rather than counting
 * independently, for the same reason PlanCompleteCard is: the headline and the
 * breakdowns have to be two views of one grading pass, or they will eventually
 * disagree in front of the athlete.
 *
 * The per-type breakdown is the part that earns its keep. "You did 78% of your
 * sessions" is a scoreboard; "you did every long run and half your intervals"
 * is a finding the next plan can act on.
 */
export function buildPlanRecap(
  plan: TrainingPlan,
  activities: StravaActivity[],
  trainingLoad: TrainingLoadPoint[],
  overrides?: PlanOverrideMap,
  today: string = localToday(),
  customWorkouts: CustomWorkoutInput[] = [],
): PlanRecap {
  const sessions = matchSessions(plan, activities, overrides, today, customWorkouts);
  const adherence = planAdherence(plan, activities, overrides, today, customWorkouts);

  // Custom workouts are excluded from the per-type breakdown: their `type` is a
  // placeholder ("easy") that carries no meaning, so folding them in would put
  // a swim into the run plan's "easy" bucket and quietly distort it.
  const planSessions = sessions.filter((s) => !s.isCustom);

  const typeMap = new Map<SessionType, PlanTypeAdherence>();
  for (const s of planSessions) {
    const entry = typeMap.get(s.type) ?? {
      type: s.type,
      done: 0,
      total: 0,
      plannedKm: 0,
      actualKm: 0,
    };
    entry.total++;
    entry.plannedKm += s.km;
    entry.actualKm += s.actualKm ?? 0;
    if (s.status === "completed" || s.status === "partial") entry.done++;
    typeMap.set(s.type, entry);
  }
  const byType = Array.from(typeMap.values())
    .map((t) => ({
      ...t,
      plannedKm: round1(t.plannedKm),
      actualKm: round1(t.actualKm),
    }))
    .sort((a, b) => b.total - a.total);

  const weekMap = new Map<string, PlanWeekRecap>();
  for (const s of planSessions) {
    const weekStart = getWeekStart(new Date(s.date + "T12:00:00"));
    const week = weekMap.get(weekStart) ?? {
      weekStart,
      plannedKm: 0,
      actualKm: 0,
      done: 0,
      total: 0,
    };
    week.plannedKm += s.km;
    week.actualKm += s.actualKm ?? 0;
    week.total++;
    if (s.status === "completed" || s.status === "partial") week.done++;
    weekMap.set(weekStart, week);
  }
  const weekly = Array.from(weekMap.values())
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .map((w) => ({
      ...w,
      plannedKm: round1(w.plannedKm),
      actualKm: round1(w.actualKm),
    }));

  const ctlAt = ctlLookup(trainingLoad);
  // The day before the race, for the reason set out on PlanRecapFitness: the
  // race's own load lands in race day and would be read as the athlete's
  // freshness on the start line.
  const startLine = addDays(plan.raceDate, -1);
  const startLinePoint = ctlAt(startLine);
  const startPoint = ctlAt(addDays(plan.startDate, -1));
  const peak = trainingLoad
    .filter((p) => p.date >= plan.startDate && p.date <= startLine)
    .reduce((max, p) => Math.max(max, p.ctl), 0);
  const fitness: PlanRecapFitness | null = startLinePoint
    ? {
        ctlStart: round1(startPoint?.ctl ?? 0),
        ctlStartLine: round1(startLinePoint.ctl),
        ctlPeak: round1(peak),
        atlStartLine: round1(startLinePoint.atl),
        tsbStartLine: round1(startLinePoint.tsb),
      }
    : null;

  const skipCounts = new Map<string, number>();
  for (const s of planSessions) {
    if (s.status !== "skipped") continue;
    const reason = (s.skipReason ?? "").trim() || "No reason given";
    skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1);
  }
  const skips = Array.from(skipCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const phase = racePhase(plan, today);

  return {
    name: plan.name,
    raceName: plan.raceName,
    raceDate: plan.raceDate,
    startDate: plan.startDate,
    discipline: plan.discipline,
    weeks: planWeeks(plan.startDate, plan.raceDate),
    daysSinceRace: phase.state === "complete" ? phase.days : 0,
    adherence,
    byType,
    weekly,
    fitness,
    skips,
  };
}

// ---------------------------------------------------------------------------
// Reading the numbers
// ---------------------------------------------------------------------------

export type InsightTone = "ok" | "accent" | "warn" | "err";

export interface Insight {
  id: string;
  tone: InsightTone;
  /** A short verdict — what is true. */
  headline: string;
  /** One sentence of evidence and, where there is one, what to do about it. */
  detail: string;
}

const TONE_RANK: Record<InsightTone, number> = { err: 0, warn: 1, accent: 2, ok: 3 };

/**
 * CTL points a block has to move before it counts as a build or a decline.
 * Below five points over six weeks is inside the noise of how TSS is estimated
 * from Strava, so calling it either way would be reading a trend into rounding.
 */
const FLAT_BAND = 5;

/** Severity first, then the order the rules produced them. */
function rank(insights: Insight[], limit: number): Insight[] {
  return insights
    .map((insight, i) => ({ insight, i }))
    .sort((a, b) => TONE_RANK[a.insight.tone] - TONE_RANK[b.insight.tone] || a.i - b.i)
    .slice(0, limit)
    .map((entry) => entry.insight);
}

function pct(now: number, before: number): number | null {
  if (before <= 0) return null;
  return Math.round(((now - before) / before) * 100);
}

function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const DISCIPLINE_LABEL: Record<TrainingDiscipline, string> = {
  swim: "Swim",
  ride: "Ride",
  run: "Run",
  strength: "Strength",
};

/**
 * The block's numbers, read as findings.
 *
 * Every rule here is deterministic and bounded by a stated threshold, so the
 * athlete gets the same reading from the same data every time and can check the
 * reasoning against the figures next to it. That is the whole point of doing
 * this in code rather than asking a model: a summary the athlete cannot verify
 * is one they are right not to trust.
 *
 * Ranked by severity and capped, because four findings get read and ten do not.
 */
export function readBlock(recap: BlockRecap, limit = 4): Insight[] {
  const found: Insight[] = [];
  const { totals, prior, fitness } = recap;

  if (totals.sessions === 0) {
    return [
      {
        id: "empty",
        tone: "warn",
        headline: "Nothing logged in six weeks",
        detail:
          "No activities in this window. Sync Strava if you have been training — otherwise this is the block to restart.",
      },
    ];
  }

  // --- Ramp rate. The one number that predicts injury better than volume does.
  // The 5 CTL/week guardrail is the standard conservative ceiling for a healthy
  // build; above 8 is where the acute:chronic ratio starts spending most of the
  // block in the danger band.
  if (fitness) {
    const ramp = fitness.rampPerWeek;
    // Build and decline are judged on the TOTAL move across the block, not on
    // the weekly rate. A rate of -1.3/week rounds to "barely moving" and reads
    // as flat, but over six weeks it is an eight-point drop — a real loss of
    // fitness that the athlete can feel and that the recap must not call
    // steady. Only a block that genuinely went nowhere is flat.
    const built = fitness.ctlEnd - fitness.ctlStart;
    if (ramp >= 8) {
      found.push({
        id: "ramp-steep",
        tone: "err",
        headline: `Fitness climbing ${ramp.toFixed(1)} a week`,
        detail: `CTL went ${fitness.ctlStart.toFixed(0)} to ${fitness.ctlEnd.toFixed(0)} in six weeks — well past the 5-a-week ceiling most builds hold to. Flatten volume for a week before adding anything.`,
      });
    } else if (ramp >= 5) {
      found.push({
        id: "ramp-fast",
        tone: "warn",
        headline: `Ramping at ${ramp.toFixed(1)} a week`,
        detail: `CTL ${fitness.ctlStart.toFixed(0)} to ${fitness.ctlEnd.toFixed(0)}. That is the top of the safe band — hold it here rather than pushing further.`,
      });
    } else if (built <= -FLAT_BAND) {
      found.push({
        id: "ramp-down",
        tone: "warn",
        headline: `Fitness down ${Math.abs(built).toFixed(0)} points`,
        detail: `CTL fell from ${fitness.ctlStart.toFixed(0)} to ${fitness.ctlEnd.toFixed(0)}. Deliberate after a race or in a recovery block; otherwise six weeks of training did not hold the level you had.`,
      });
    } else if (built >= FLAT_BAND) {
      found.push({
        id: "ramp-steady",
        tone: "ok",
        headline: `Fitness built ${built.toFixed(0)} points`,
        detail: `CTL ${fitness.ctlStart.toFixed(0)} to ${fitness.ctlEnd.toFixed(0)}, ${ramp.toFixed(1)} a week — a sustainable rate you can keep running.`,
      });
    } else {
      found.push({
        id: "ramp-flat",
        tone: "accent",
        headline: "Fitness held flat",
        detail: `CTL sat around ${fitness.ctlEnd.toFixed(0)} all block. Maintenance, not progression — fine between goals, not enough before one.`,
      });
    }

    // --- Form. Where the athlete is standing right now, which is the question
    // they actually opened the dashboard to answer.
    if (fitness.tsbEnd < -25) {
      found.push({
        id: "form-buried",
        tone: "err",
        headline: "Carrying deep fatigue",
        detail: `Form is ${fitness.tsbEnd.toFixed(0)}. Below -25 is where good sessions stop happening and niggles start — take the easy days easy.`,
      });
    } else if (fitness.tsbEnd > 20) {
      found.push({
        id: "form-fresh",
        tone: "accent",
        headline: "Very fresh",
        detail: `Form is +${fitness.tsbEnd.toFixed(0)}. Ideal in race week; outside it, it usually means the training stopped.`,
      });
    }
  }

  // --- Consistency. Endurance fitness is a function of how rarely you stop.
  const ratio = recap.daysTrained / recap.days;
  if (recap.longestGap >= 5) {
    found.push({
      id: "gap",
      tone: "warn",
      headline: `A ${recap.longestGap}-day break cut the block`,
      detail: `${recap.daysTrained} of ${recap.days} days had training, but the longest unbroken gap was ${recap.longestGap} days — enough to show up in the fitness line.`,
    });
  } else if (ratio >= 0.65) {
    found.push({
      id: "consistent",
      tone: "ok",
      headline: `Trained ${recap.daysTrained} of ${recap.days} days`,
      detail: `Longest gap was ${recap.longestGap} day${recap.longestGap === 1 ? "" : "s"}, longest streak ${recap.longestStreak}. Consistency is doing more for you here than any single session.`,
    });
  }

  // --- Discipline balance. The imbalance a triathlete cannot see from inside
  // the week, only across a block.
  const shareNow = timeShare(totals);
  const sharePrior = timeShare(prior);
  if (prior.minutes > 0) {
    let biggest: { key: TriDiscipline; delta: number } | null = null;
    for (const key of TRI_DISCIPLINES) {
      const delta = shareNow[key] - sharePrior[key];
      if (!biggest || Math.abs(delta) > Math.abs(biggest.delta)) biggest = { key, delta };
    }
    // A discipline has "gone quiet" when it both halved against the previous
    // block and now accounts for almost none of the training time. Requiring it
    // to reach exactly zero missed the case that actually matters to a
    // triathlete: the swim that did not stop, it just shrank to one session a
    // month and quietly stopped counting.
    const quiet = TRI_DISCIPLINES.filter(
      (key) =>
        prior.byDiscipline[key].minutes > 60 &&
        totals.byDiscipline[key].minutes <= prior.byDiscipline[key].minutes * 0.5 &&
        shareNow[key] < 10,
    );
    if (quiet.length > 0) {
      const names = quiet.map((key) => DISCIPLINE_LABEL[key].toLowerCase());
      const worst = quiet[0];
      const now = totals.byDiscipline[worst];
      found.push({
        id: "dropped",
        tone: "warn",
        headline:
          now.minutes === 0
            ? `No ${names.join(" or ")} at all`
            : `${DISCIPLINE_LABEL[worst]} has gone quiet`,
        detail:
          now.minutes === 0
            ? `${hours(prior.byDiscipline[worst].minutes)} of ${names[0]} in the previous six weeks and none in these. A leg you stop training is a leg that does not come back quickly.`
            : `${hours(now.minutes)} across ${now.sessions} session${now.sessions === 1 ? "" : "s"} — ${shareNow[worst]}% of your time, down from ${hours(prior.byDiscipline[worst].minutes)}. For a three-sport athlete that is a leg quietly falling off the plan.`,
      });
    } else if (biggest && Math.abs(biggest.delta) >= 10) {
      const label = DISCIPLINE_LABEL[biggest.key];
      found.push({
        id: "balance",
        tone: "accent",
        headline:
          biggest.delta > 0
            ? `${label} took over the block`
            : `${label} gave up ground`,
        detail: `${label} went from ${sharePrior[biggest.key]}% to ${shareNow[biggest.key]}% of your training time. Worth it if that is the plan; worth fixing if it is not.`,
      });
    }
  }

  // --- Volume against the previous block, which is the only honest yardstick
  // for whether this was a big six weeks or a quiet one.
  const volumeDelta = pct(totals.minutes, prior.minutes);
  if (volumeDelta !== null && Math.abs(volumeDelta) >= 15) {
    found.push({
      id: "volume",
      tone: volumeDelta > 0 ? "ok" : "accent",
      headline:
        volumeDelta > 0
          ? `Volume up ${volumeDelta}%`
          : `Volume down ${Math.abs(volumeDelta)}%`,
      detail: `${hours(totals.minutes)} across ${totals.sessions} sessions, against ${hours(prior.minutes)} in the six weeks before.`,
    });
  }

  // --- A single week that dwarfs the rest is a spike, however good the block
  // average looks.
  const meanWeek = totals.minutes / recap.weeks;
  if (recap.biggestWeek && meanWeek > 0 && recap.biggestWeek.minutes >= meanWeek * 1.7) {
    found.push({
      id: "spike",
      tone: "warn",
      headline: "One week ran away from the rest",
      detail: `The week of ${recap.biggestWeek.start} was ${hours(recap.biggestWeek.minutes)} against a ${hours(meanWeek)} block average. Spikes like that, not totals, are what pull muscles.`,
    });
  }

  return rank(found, limit);
}

/** Percentage of a plan's sessions that were done, partials included. */
export function adherencePct(adherence: PlanAdherence): number {
  const graded = adherence.completed + adherence.partial + adherence.missed + adherence.skipped;
  if (graded === 0) return 0;
  return Math.round(((adherence.completed + adherence.partial) / graded) * 100);
}

/** The same treatment for a finished plan: what it says about how it went. */
export function readPlan(recap: PlanRecap, limit = 4): Insight[] {
  const found: Insight[] = [];
  const { adherence, fitness } = recap;
  const done = adherence.completed + adherence.partial;
  const rate = adherencePct(adherence);

  if (rate >= 90) {
    found.push({
      id: "adherence-high",
      tone: "ok",
      headline: `You did ${rate}% of the plan`,
      detail: `${done} of ${adherence.total} sessions, ${Math.round(adherence.actualKm)} km against ${Math.round(adherence.plannedKm)} planned. Whatever the result, the work was there.`,
    });
  } else if (rate >= 70) {
    found.push({
      id: "adherence-mid",
      tone: "accent",
      headline: `You did ${rate}% of the plan`,
      detail: `${done} of ${adherence.total} sessions. ${adherence.missed} missed and ${adherence.skipped} deliberately skipped — the gap is worth reading before the next block.`,
    });
  } else {
    found.push({
      id: "adherence-low",
      tone: "warn",
      headline: `You did ${rate}% of the plan`,
      detail: `${done} of ${adherence.total} sessions. A plan you complete two thirds of is a plan that asked for more than the weeks allowed — size the next one to the life around it.`,
    });
  }

  // --- Which sessions survived contact with real life. This is the finding
  // that changes the next plan, so it outranks the totals above it.
  const graded = recap.byType.filter((t) => t.total >= 3);
  if (graded.length >= 2) {
    const withRate = graded
      .map((t) => ({ ...t, rate: Math.round((t.done / t.total) * 100) }))
      .sort((a, b) => b.rate - a.rate);
    const best = withRate[0];
    const worst = withRate[withRate.length - 1];
    if (best.rate - worst.rate >= 25) {
      found.push({
        id: "type-split",
        tone: "accent",
        headline: `${typeLabel(worst.type)} sessions were the ones that slipped`,
        detail: `${worst.done} of ${worst.total} ${typeLabel(worst.type).toLowerCase()} done (${worst.rate}%), against ${best.done} of ${best.total} ${typeLabel(best.type).toLowerCase()} (${best.rate}%). Protect the weak one next time, or stop prescribing as many.`,
      });
    }
  }

  // --- Did the taper land. Race-day form is the single number that answers it.
  if (fitness) {
    if (fitness.tsbStartLine >= 10) {
      found.push({
        id: "taper-good",
        tone: "ok",
        headline: `You started on +${fitness.tsbStartLine.toFixed(0)} form`,
        detail: `Fatigue was down to ${fitness.atlStartLine.toFixed(0)} against ${fitness.ctlStartLine.toFixed(0)} fitness on the morning of the race — a taper that did its job. Repeat the last two weeks next time.`,
      });
    } else if (fitness.tsbStartLine >= -5) {
      found.push({
        id: "taper-thin",
        tone: "accent",
        headline: `You started on ${fitness.tsbStartLine.toFixed(0)} form`,
        detail: "Close to neutral on the morning of the race — rested, but not sharp. A slightly deeper taper is usually worth a few minutes.",
      });
    } else {
      found.push({
        id: "taper-tired",
        tone: "warn",
        headline: `You started tired at ${fitness.tsbStartLine.toFixed(0)} form`,
        detail: "Fatigue was still in your legs on the morning of the race. The fitness was there; the freshness to use it was not.",
      });
    }

    // What the plan BUILT is measured to the peak, not to the start line. A
    // taper sheds CTL on purpose — that is the entire point of it — so
    // measuring the build against race-week fitness makes every well-executed
    // taper read as a plan that destroyed the athlete's fitness. One real block
    // came in at 74, peaked at 82 and tapered to 55: it built seven points and
    // would have been reported as losing nineteen.
    const built = fitness.ctlPeak - fitness.ctlStart;
    if (Math.abs(built) >= FLAT_BAND) {
      found.push({
        id: "plan-fitness",
        tone: built > 0 ? "ok" : "warn",
        headline:
          built > 0
            ? `The plan added ${built.toFixed(0)} points of fitness`
            : `Fitness fell ${Math.abs(built).toFixed(0)} points across the plan`,
        detail: `CTL went ${fitness.ctlStart.toFixed(0)} to a peak of ${fitness.ctlPeak.toFixed(0)}, then tapered to ${fitness.ctlStartLine.toFixed(0)} for the start line. That peak is the level your next plan starts from, not zero.`,
      });
    }
  }

  // --- Repeated skips for one reason are a pattern, not a run of bad luck.
  const topSkip = recap.skips[0];
  if (topSkip && topSkip.count >= 3 && topSkip.reason !== "No reason given") {
    found.push({
      id: "skip-pattern",
      tone: "warn",
      headline: `${topSkip.count} sessions skipped for the same reason`,
      detail: `"${topSkip.reason}" came up ${topSkip.count} times. A reason that recurs is a constraint to plan around, not an excuse to work on.`,
    });
  }

  return rank(found, limit);
}

export function typeLabel(type: SessionType): string {
  switch (type) {
    case "time_trial":
      return "Time trial";
    case "intervals":
      return "Interval";
    case "long":
      return "Long";
    case "tempo":
      return "Tempo";
    case "race":
      return "Race";
    case "easy":
      return "Easy";
  }
}
