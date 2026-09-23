import { StravaActivity } from "./types/strava";
import {
  estimateTSS,
  formatSecondsAsClock,
  getDiscipline,
  localToday,
  type TrainingLoadPoint,
} from "./training";
import {
  type CustomWorkoutInput,
  type PlanOverrideMap,
  type SessionWithStatus,
  type TrainingPlan,
} from "./plan";
import {
  LONG_RUN_KM,
  disciplineOf,
  isHardSession,
  isLive,
  isPending,
  scheduledSessions,
} from "./schedule";
import { estimateRunThreshold, type RunThreshold } from "./threshold";
import { shiftDays, type ZoneModel } from "./quality";
import type { TriDiscipline } from "./recap";
import type { QualityProfile } from "./quality-recap";
import {
  EFFORT,
  blocksMinutes,
  repeats,
  runWarmup,
  type ThresholdAnchor,
  type WorkoutBlock,
} from "./workout-blocks";

/**
 * What to train next, and why.
 *
 * The hard part of a recommender is not generating a session — it is refusing
 * to. Anything that only looks for gaps will cheerfully prescribe intervals to
 * an athlete who raced yesterday, because "your top end is untouched" is still
 * true of someone who can barely walk. So the rules here run in two stages:
 * constraints first, which can remove options outright, and only then
 * opportunities, which merely reorder what survived.
 *
 * Every suggestion carries the sentence that produced it. An athlete who can
 * see "you rode 11 days ago" can disagree with it; one handed a bare ranking
 * can only obey or ignore.
 */

export type SuggestionKind =
  | "rest"
  | "recovery"
  | "easy"
  | "long"
  | "tempo"
  | "intervals"
  | "vo2";

/** How strongly the ranking stands behind a suggestion. */
export type SuggestionPriority = "do-this" | "good-option" | "optional";

export interface SessionStep {
  label: string;
  detail: string;
}

export interface SuggestedSession {
  name: string;
  discipline: TriDiscipline;
  kind: SuggestionKind;
  distanceKm?: number;
  durationMin: number;
  steps: SessionStep[];
  /**
   * The same session as intensity over time, for the workout profile chart.
   * Built by the same function as `steps`, block for step, and display-only:
   * the calendar stores only the text note.
   */
  blocks: WorkoutBlock[];
  /** What the chart's 100% line means: FTP in watts, or unlabelled effort. */
  threshold: ThresholdAnchor;
  /** One-line rendering, for the workout note written onto the calendar. */
  summary: string;
}

export interface Suggestion {
  id: string;
  priority: SuggestionPriority;
  /** What to do, in the athlete's language. */
  headline: string;
  /** Why this, today — always specific enough to be argued with. */
  why: string;
  session: SuggestedSession | null;
  /** Set when a constraint produced this rather than an opportunity. */
  constraint?: "plan" | "fatigue" | "recent-hard";
  score: number;
}

export interface SuggestInput {
  activities: StravaActivity[];
  trainingLoad: TrainingLoadPoint[];
  plan: TrainingPlan | null;
  overrides?: PlanOverrideMap;
  customWorkouts?: CustomWorkoutInput[];
  /** Scanned per-activity profiles, used as a library of the athlete's own reps. */
  profiles?: QualityProfile[];
  zones: ZoneModel;
  /** Measured seconds per zone over the recent block, when a scan has run. */
  zoneSeconds?: number[] | null;
  athlete?: { ftp?: number | null; weight?: number | null };
  today?: string;
  /** The day being planned for. Defaults to today. */
  date?: string;
}

// ---------------------------------------------------------------------------
// Reading the athlete's recent state
// ---------------------------------------------------------------------------

/** Below this, form is deep enough that no hard session will land well. */
const BURIED_TSB = -25;
/** Above this the athlete is fresh enough to absorb real intensity. */
const FRESH_TSB = -5;
/** Hard sessions need a day between them; two in 48h is how injuries start. */
const HARD_RECOVERY_DAYS = 2;
/** A long run this long ago is overdue in any endurance block. */
const LONG_RUN_INTERVAL_DAYS = 9;
/** A discipline untouched this long has started detraining. */
const DISCIPLINE_STALE_DAYS = 10;

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000,
  );
}

function dayOf(a: StravaActivity): string {
  return a.start_date_local.split("T")[0];
}

/** A session counts as hard when its load is well above the athlete's norm. */
function isHard(a: StravaActivity, medianTss: number): boolean {
  return estimateTSS(a) >= Math.max(90, medianTss * 1.4);
}

export interface AthleteState {
  tsb: number;
  ctl: number;
  /** Days since each discipline was last trained; null if never. */
  daysSince: Record<TriDiscipline, number | null>;
  daysSinceHard: number | null;
  daysSinceLong: number | null;
  /**
   * The most recent hard day before the one being planned. `scheduled` means it
   * is on the calendar but not done yet — still a hard day to recover from.
   */
  lastHard: { name: string; date: string; scheduled: boolean } | null;
  /** Typical easy-run distance, so suggestions match what they actually do. */
  medianEasyKm: number | null;
  longestRecentKm: number | null;
  medianRideMin: number | null;
  medianSwimKm: number | null;
  /** Estimated from a recent race or threshold-HR effort; null without evidence. */
  runThreshold: RunThreshold | null;
}

/**
 * Calendar sessions that shape the day being planned: ones already done, and
 * ones still to come before it. Looking at Thursday on a Tuesday, Wednesday's
 * intervals are as real as yesterday's — they just have not happened yet.
 */
function countedSessions(input: SuggestInput, today: string, date: string): SessionWithStatus[] {
  return scheduledSessions({
    plan: input.plan,
    activities: input.activities,
    overrides: input.overrides,
    customWorkouts: input.customWorkouts,
    today,
  }).filter(
    (s) =>
      isLive(s) &&
      s.date >= shiftDays(today, -90) &&
      (s.date < date || (s.date <= today && !isPending(s))),
  );
}

/** The later of two dated candidates; ties go to the first. */
function later<T extends { date: string }>(a: T | null, b: T | null): T | null {
  if (!a) return b;
  if (!b) return a;
  return b.date > a.date ? b : a;
}

export function readAthleteState(input: SuggestInput): AthleteState {
  const today = input.today ?? localToday();
  // Every "days since" is measured from the day being planned, not from today.
  const date = input.date ?? today;
  const windowStart = shiftDays(today, -90);
  const recent = input.activities
    .filter((a) => dayOf(a) >= windowStart && dayOf(a) <= today)
    .sort((a, b) => dayOf(b).localeCompare(dayOf(a)));

  const latest = input.trainingLoad[input.trainingLoad.length - 1];
  const tssValues = recent.map(estimateTSS).sort((a, b) => a - b);
  const medianTss = tssValues.length > 0 ? tssValues[Math.floor(tssValues.length / 2)] : 0;

  const daysSince: Record<TriDiscipline, number | null> = {
    swim: null,
    ride: null,
    run: null,
  };
  // Newest first, like `recent`.
  const counted = countedSessions(input, today, date).sort((a, b) =>
    b.date.localeCompare(a.date),
  );

  for (const key of ["swim", "ride", "run"] as TriDiscipline[]) {
    const act = recent.find((a) => getDiscipline(a) === key);
    const session = counted.find((s) => disciplineOf(s) === key);
    const last = later<{ date: string }>(act ? { date: dayOf(act) } : null, session ?? null);
    daysSince[key] = last ? daysBetween(last.date, date) : null;
  }

  // A completed activity is judged by the load it actually carried; a calendar
  // session by what it is. That second test is what catches a short, sharp
  // interval session whose load alone would not look hard.
  const hardAct = recent.find((a) => isHard(a, medianTss));
  const hardSession = counted.find(isHardSession);
  const lastHard = later(
    hardAct ? { name: hardAct.name, date: dayOf(hardAct), scheduled: false } : null,
    hardSession
      ? { name: hardSession.name, date: hardSession.date, scheduled: isPending(hardSession) }
      : null,
  );

  const longAct = recent.find(
    (a) => getDiscipline(a) === "run" && a.distance >= LONG_RUN_KM * 1000,
  );
  const longSession = counted.find(
    (s) =>
      disciplineOf(s) === "run" &&
      (s.km >= LONG_RUN_KM || (!s.isCustom && s.type === "long")),
  );
  const lastLong = later<{ date: string }>(longAct ? { date: dayOf(longAct) } : null, longSession ?? null);

  const easyRuns = recent.filter(
    (a) =>
      getDiscipline(a) === "run" &&
      a.distance >= 4000 &&
      (!a.average_heartrate ||
        input.zones.source === "none" ||
        a.average_heartrate < input.zones.floors[2]),
  );
  const median = (xs: number[]) =>
    xs.length > 0 ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;

  return {
    tsb: latest?.tsb ?? 0,
    ctl: latest?.ctl ?? 0,
    daysSince,
    daysSinceHard: lastHard ? daysBetween(lastHard.date, date) : null,
    daysSinceLong: lastLong ? daysBetween(lastLong.date, date) : null,
    lastHard,
    medianEasyKm: median(easyRuns.map((a) => a.distance / 1000)),
    longestRecentKm: median(
      recent
        .filter((a) => getDiscipline(a) === "run")
        .map((a) => a.distance / 1000)
        .sort((a, b) => b - a)
        .slice(0, 3),
    ),
    medianRideMin: median(
      recent.filter((a) => getDiscipline(a) === "ride").map((a) => a.moving_time / 60),
    ),
    medianSwimKm: median(
      recent.filter((a) => getDiscipline(a) === "swim").map((a) => a.distance / 1000),
    ),
    runThreshold: estimateRunThreshold({
      plan: input.plan,
      activities: input.activities,
      overrides: input.overrides,
      customWorkouts: input.customWorkouts,
      today,
      zones: input.zones,
      profiles: input.profiles,
    }),
  };
}

// ---------------------------------------------------------------------------
// Building a session
// ---------------------------------------------------------------------------

function round(n: number, to = 1): number {
  return Math.round(n / to) * to;
}

function pace(secPerKm: number): string {
  return `${formatSecondsAsClock(secPerKm)}/km`;
}

/**
 * The athlete's own most recent version of a structured session.
 *
 * Suggesting "6 x 400 m" to someone whose history is full of 400 m repeats is
 * worth far more when it comes with the pace they actually held last time —
 * and it is the difference between a generic prescription and a training plan
 * that knows them. Falls back to null, and the caller to a generic structure,
 * for a discipline or session type they have never done.
 */
export function findRepTemplate(
  profiles: QualityProfile[],
  before: string,
  opts: { maxRepMeters?: number } = {},
): QualityProfile | null {
  const structured = profiles
    .filter((p) => p.structure?.kind === "intervals" && p.date <= before)
    .filter((p) => {
      if (!opts.maxRepMeters) return true;
      // Top-end work needs short reps. Reusing a threshold session's kilometre
      // repeats produces the same prescription under a different heading, which
      // is worse than having no template at all.
      const first = p.structure!.sets[0]?.reps[0];
      return first ? first.meters <= opts.maxRepMeters : false;
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  return structured[0] ?? null;
}

/** Reps longer than this are threshold work, not top end. */
export const VO2_MAX_REP_METERS = 600;

const EFFORT_ANCHOR: ThresholdAnchor = { kind: "effort" };

/** Runs anchor to the athlete's threshold pace when there is evidence for one. */
function runAnchor(state: AthleteState): ThresholdAnchor {
  const t = state.runThreshold;
  return t
    ? { kind: "pace", secPerKm: t.secPerKm, from: `${t.activityName}, ${t.date}` }
    : EFFORT_ANCHOR;
}

export function easyRun(state: AthleteState): SuggestedSession {
  const km = round(state.medianEasyKm ?? 8, 0.5);
  const minutes = Math.round(km * 6);
  return {
    name: `${km} km easy run`,
    discipline: "run",
    kind: "easy",
    distanceKm: km,
    durationMin: minutes,
    steps: [
      { label: "Whole run", detail: `${km} km conversational, heart rate in Z2` },
    ],
    blocks: [
      {
        kind: "steady",
        label: "Whole run",
        durationSec: minutes * 60,
        intensity: EFFORT.easy,
        distanceM: km * 1000,
      },
    ],
    threshold: runAnchor(state),
    summary: `${km} km easy, Z2 throughout. Comfortable enough to hold a conversation.`,
  };
}

function recoveryRun(state: AthleteState): SuggestedSession {
  const km = round(Math.min(6, (state.medianEasyKm ?? 8) * 0.6), 0.5);
  const minutes = Math.round(km * 6.5);
  return {
    name: `${km} km recovery run`,
    discipline: "run",
    kind: "recovery",
    distanceKm: km,
    durationMin: minutes,
    steps: [{ label: "Whole run", detail: `${km} km very easy, Z1 — slower than feels natural` }],
    blocks: [
      {
        kind: "steady",
        label: "Whole run",
        durationSec: minutes * 60,
        intensity: EFFORT.recovery,
        distanceM: km * 1000,
      },
    ],
    threshold: runAnchor(state),
    summary: `${km} km recovery. Z1 only; if it feels like training, slow down.`,
  };
}

function longRun(state: AthleteState): SuggestedSession {
  // Step up from what they have actually been doing, capped: a long run that
  // jumps more than a kilometre or two past recent history is how a good block
  // turns into a calf strain.
  const base = state.longestRecentKm ?? 12;
  const km = round(Math.min(base + 1, base * 1.1), 0.5);
  const minutes = Math.round(km * 6);
  // Split on the rounded total, so the two thirds always add back up to it.
  const firstSec = Math.round((minutes * 60 * 2) / 3);
  return {
    name: `${km} km long run`,
    discipline: "run",
    kind: "long",
    distanceKm: km,
    durationMin: minutes,
    steps: [
      { label: "First two thirds", detail: "Easy, Z2 — resist going with the legs" },
      { label: "Last third", detail: "Lift to steady if it still feels controlled" },
    ],
    blocks: [
      {
        kind: "steady",
        label: "First two thirds",
        durationSec: firstSec,
        intensity: EFFORT.easy,
        distanceM: Math.round((km * 1000 * 2) / 3),
      },
      {
        kind: "steady",
        label: "Last third",
        durationSec: minutes * 60 - firstSec,
        intensity: EFFORT.steady,
        distanceM: Math.round((km * 1000) / 3),
      },
    ],
    threshold: runAnchor(state),
    summary: `${km} km long run, Z2 for two thirds then steady if controlled.`,
  };
}

/**
 * Width, in seconds per kilometre, for a rep whose pace nobody knows: a club
 * runner's 5K pace. It only sets how wide the generic session's reps are drawn
 * — the chart labels those reps by distance and never shows this as a pace.
 */
const GENERIC_REP_SEC_PER_KM = 285;

/** Run cool-downs are prescribed as "10–15 min"; drawn at the middle. */
const RUN_COOLDOWN_MIN = 12;

function runCooldown(minutes = RUN_COOLDOWN_MIN): WorkoutBlock {
  return {
    kind: "cooldown",
    label: "Cool-down",
    durationSec: minutes * 60,
    intensity: EFFORT.easy,
    endIntensity: EFFORT.recovery,
  };
}

function intervalRun(
  state: AthleteState,
  template: QualityProfile | null,
  kind: "intervals" | "vo2",
): SuggestedSession {
  const set = template?.structure?.sets?.[0];
  const reps = set?.reps ?? [];

  if (set && reps.length >= 2) {
    // Target the best rep they held last time, not the average: the set was
    // repeatable at that pace at least once.
    const best = Math.min(...reps.map((r) => r.paceSecPerKm));
    const meters = set.targetMeters ?? Math.round(reps[0].meters);
    const count = kind === "vo2" ? Math.max(4, Math.min(reps.length, 8)) : reps.length;
    const recovery = reps[0].recoverySeconds ?? 90;
    const name = `${count} x ${meters} m`;
    // Short reps are top-end work whatever the heading says; kilometre repeats
    // are threshold. The pace itself is theirs, so it rides along as the target.
    const effort = meters <= VO2_MAX_REP_METERS ? EFFORT.vo2 : EFFORT.threshold;
    const blocks = [
      ...runWarmup(20, 4),
      ...repeats(
        count,
        () => ({
          durationSec: Math.round((meters / 1000) * best),
          intensity: effort,
          distanceM: meters,
          target: pace(best),
        }),
        { durationSec: recovery, intensity: EFFORT.recovery, label: "Jog recovery" },
      ),
      runCooldown(),
    ];
    return {
      name,
      discipline: "run",
      kind,
      durationMin: blocksMinutes(blocks),
      steps: [
        { label: "Warm-up", detail: "15–20 min easy, then a few strides" },
        {
          label: name,
          detail: `${pace(best)} target — you held that on ${template!.date}`,
        },
        { label: "Recovery", detail: `${formatSecondsAsClock(recovery)} jog between reps` },
        { label: "Cool-down", detail: "10–15 min easy" },
      ],
      blocks,
      threshold: runAnchor(state),
      summary: `${name} @ ${pace(best)}, ${formatSecondsAsClock(recovery)} recovery. Based on your ${template!.name} on ${template!.date}.`,
    };
  }

  // No usable library — a standard session. Top-end work is prescribed by TIME
  // rather than distance: the point is minutes spent above threshold, and a
  // fixed distance lets a tiring athlete simply take longer over it.
  if (kind === "vo2") {
    const blocks = [
      ...runWarmup(20, 4),
      ...repeats(
        5,
        () => ({ durationSec: 180, intensity: EFFORT.vo2 }),
        { durationSec: 180, intensity: EFFORT.recovery, label: "Jog recovery" },
      ),
      runCooldown(),
    ];
    return {
      name: "5 x 3 min hard",
      discipline: "run",
      kind,
      durationMin: blocksMinutes(blocks),
      steps: [
        { label: "Warm-up", detail: "15–20 min easy, then 4 strides" },
        { label: "5 x 3 min", detail: "Hard but repeatable — into Z5 by the end of each rep" },
        { label: "Recovery", detail: "3 min easy jog, full recovery between efforts" },
        { label: "Cool-down", detail: "10–15 min easy" },
      ],
      blocks,
      threshold: runAnchor(state),
      summary: "5 x 3 min hard with 3 min full recoveries, either side of a 15-20 min warm-up and cool-down.",
    };
  }
  const blocks = [
    ...runWarmup(20, 4),
    ...repeats(
      6,
      () => ({
        durationSec: Math.round(0.4 * GENERIC_REP_SEC_PER_KM),
        intensity: EFFORT.vo2,
        distanceM: 400,
      }),
      { durationSec: 90, intensity: EFFORT.recovery, label: "Jog recovery" },
    ),
    runCooldown(),
  ];
  return {
    name: "6 x 400 m",
    discipline: "run",
    kind,
    durationMin: blocksMinutes(blocks),
    steps: [
      { label: "Warm-up", detail: "15–20 min easy, then a few strides" },
      { label: "6 x 400 m", detail: "5 km race effort" },
      { label: "Recovery", detail: "90 s jog" },
      { label: "Cool-down", detail: "10–15 min easy" },
    ],
    blocks,
    threshold: runAnchor(state),
    summary: "6 x 400 m with 90 s recoveries, either side of a 15-20 min warm-up and cool-down.",
  };
}

function tempoRun(state: AthleteState): SuggestedSession {
  const km = round(Math.max(4, (state.medianEasyKm ?? 10) * 0.4), 0.5);
  const blocks: WorkoutBlock[] = [
    {
      kind: "warmup",
      label: "Warm-up",
      durationSec: 15 * 60,
      intensity: EFFORT.recovery,
      endIntensity: EFFORT.easy,
    },
    {
      kind: "work",
      label: `${km} km continuous`,
      durationSec: Math.round(km * 5 * 60),
      intensity: EFFORT.tempo,
      distanceM: km * 1000,
    },
    runCooldown(15),
  ];
  return {
    name: `${km} km tempo`,
    discipline: "run",
    kind: "tempo",
    distanceKm: round(km + 5, 0.5),
    durationMin: blocksMinutes(blocks),
    steps: [
      { label: "Warm-up", detail: "15 min easy" },
      { label: `${km} km continuous`, detail: "Comfortably hard — Z3/low Z4, controlled to the end" },
      { label: "Cool-down", detail: "10–15 min easy" },
    ],
    blocks,
    threshold: runAnchor(state),
    summary: `${km} km continuous at comfortably hard effort, with a 15 min warm-up and cool-down.`,
  };
}

function rideSession(
  state: AthleteState,
  kind: "easy" | "intervals" | "vo2",
  ftp: number | null,
): SuggestedSession {
  const threshold: ThresholdAnchor = ftp ? { kind: "ftp", watts: ftp } : EFFORT_ANCHOR;
  const base = Math.round(state.medianRideMin ?? 60);
  if (kind === "easy") {
    return {
      name: `${base} min endurance ride`,
      discipline: "ride",
      kind: "easy",
      durationMin: base,
      steps: [{ label: "Whole ride", detail: "Z2 endurance, steady — spin rather than grind" }],
      blocks: [
        { kind: "steady", label: "Whole ride", durationSec: base * 60, intensity: EFFORT.easy },
      ],
      threshold,
      summary: `${base} min steady Z2 endurance ride.`,
    };
  }
  // FTP gives a target a rider can actually hold to; without it, fall back to
  // effort language rather than inventing a number.
  const target = ftp ? `${Math.round(ftp * 0.95)}–${Math.round(ftp * 1.0)} W` : "threshold effort";
  const blocks: WorkoutBlock[] = [
    {
      kind: "warmup",
      label: "Warm-up",
      durationSec: 15 * 60,
      intensity: EFFORT.spin,
      endIntensity: EFFORT.easy,
    },
    ...repeats(
      4,
      // The middle of the prescribed 95–100% FTP band.
      () => ({ durationSec: 8 * 60, intensity: 0.975, ...(ftp ? { target } : {}) }),
      { durationSec: 4 * 60, intensity: EFFORT.recovery, label: "Easy spin" },
    ),
    {
      kind: "cooldown",
      label: "Cool-down",
      durationSec: 10 * 60,
      intensity: EFFORT.easy,
      endIntensity: EFFORT.spin,
    },
  ];
  return {
    name: "4 x 8 min threshold",
    discipline: "ride",
    kind: "intervals",
    // The structure decides the length: warm-up, efforts, recoveries and
    // cool-down come to 69 min whatever the athlete's usual ride is.
    durationMin: blocksMinutes(blocks),
    steps: [
      { label: "Warm-up", detail: "15 min building, with 3 x 1 min spin-ups" },
      { label: "4 x 8 min", detail: `${target}${ftp ? " (95–100% FTP)" : ""}` },
      { label: "Recovery", detail: "4 min easy spin between efforts" },
      { label: "Cool-down", detail: "10 min easy" },
    ],
    blocks,
    threshold,
    summary: `4 x 8 min at ${target} with 4 min recoveries, either side of a 15 min warm-up and 10 min cool-down.`,
  };
}

/**
 * Nominal swim pace, 2:30 per 100 m including turns — the figure `km * 25` has
 * always assumed. Swim blocks are drawn to it; none of it is shown as a pace.
 */
const SWIM_SEC_PER_100 = 150;
const SWIM_REST_SEC = 20;

function swimSession(state: AthleteState): SuggestedSession {
  // The main set fills whatever the warm-up and cool-down leave of the athlete's
  // usual swim, so the session's name and its steps add up to the same distance.
  const reps = Math.max(4, Math.round(round(state.medianSwimKm ?? 1.2, 0.1) * 10) - 5);
  const meters = 300 + reps * 100 + 200;
  const blocks: WorkoutBlock[] = [
    {
      kind: "warmup",
      label: "Warm-up",
      durationSec: 3 * SWIM_SEC_PER_100,
      intensity: EFFORT.recovery,
      endIntensity: EFFORT.easy,
      distanceM: 300,
    },
    ...repeats(
      reps,
      // "Building through the set": tempo on the first rep, threshold by the last.
      (i) => ({
        durationSec: SWIM_SEC_PER_100 - SWIM_REST_SEC,
        intensity: EFFORT.tempo + ((EFFORT.threshold - EFFORT.tempo) * i) / Math.max(1, reps - 1),
        distanceM: 100,
      }),
      { durationSec: SWIM_REST_SEC, intensity: EFFORT.rest, label: "Rest at the wall" },
    ),
    {
      kind: "cooldown",
      label: "Cool-down",
      durationSec: 2 * SWIM_SEC_PER_100,
      intensity: EFFORT.easy,
      endIntensity: EFFORT.recovery,
      distanceM: 200,
    },
  ];
  return {
    name: `${meters} m swim`,
    discipline: "swim",
    kind: "intervals",
    distanceKm: meters / 1000,
    durationMin: blocksMinutes(blocks),
    steps: [
      { label: "Warm-up", detail: "300 m mixed" },
      { label: "Main set", detail: `${reps} x 100 m with 20 s rest, building through the set` },
      { label: "Cool-down", detail: "200 m easy" },
    ],
    blocks,
    threshold: EFFORT_ANCHOR,
    summary: `${meters} m: 300 warm-up, ${reps} x 100 m on 20 s rest, 200 easy.`,
  };
}

function restDay(): SuggestedSession | null {
  return null;
}

// ---------------------------------------------------------------------------
// The ranking
// ---------------------------------------------------------------------------

const DISCIPLINE_LABEL: Record<TriDiscipline, string> = {
  swim: "swim",
  ride: "bike",
  run: "run",
};

interface Candidate {
  id: string;
  kind: SuggestionKind;
  discipline: TriDiscipline;
  score: number;
  headline: string;
  why: string;
  session: SuggestedSession | null;
}

/**
 * Priority is relative to the rest of the list, not an absolute score.
 *
 * An athlete opening this tab wants an answer, and "five good options" is not
 * one. The best surviving candidate leads unless it is genuinely marginal; the
 * rest are alternatives. Absolute thresholds produced lists where nothing was
 * recommended at all, because three roughly-equal opportunities all landed just
 * under the bar.
 */
function priorityOf(score: number, rank: number): SuggestionPriority {
  if (rank === 0 && score >= 40) return "do-this";
  if (score >= 45) return "good-option";
  return "optional";
}

/**
 * Rank what to do next.
 *
 * Constraints run first and can eliminate whole classes of session; only then
 * do opportunities reorder what is left. That ordering is the entire safety
 * property — a gap-seeking ranker with no constraint stage will prescribe
 * intervals to someone who raced yesterday, because the gap is still there.
 *
 * Returns at least one suggestion in every state, including "rest", so the tab
 * is never empty and never silently omits the answer "nothing today".
 */
export function suggestWorkouts(input: SuggestInput, limit = 5): Suggestion[] {
  const today = input.today ?? localToday();
  const date = input.date ?? today;
  const state = readAthleteState(input);
  const ftp = input.athlete?.ftp ?? null;
  const template = findRepTemplate(input.profiles ?? [], date);
  // Separate lookup: a threshold template is the wrong basis for top-end work.
  const vo2Template = findRepTemplate(input.profiles ?? [], date, {
    maxRepMeters: VO2_MAX_REP_METERS,
  });

  const out: Suggestion[] = [];

  // --- Constraint: the plan, or the athlete's own calendar, already answers
  // this. Calendar workouts count even with no plan uploaded.
  const planned = scheduledSessions({
    plan: input.plan,
    activities: input.activities,
    overrides: input.overrides,
    customWorkouts: input.customWorkouts,
    today,
  }).filter((s) => s.date === date && s.status !== "skipped");

  if (planned.length > 0) {
    const s = planned[0];
    out.push({
      id: "plan-today",
      priority: "do-this",
      score: 100,
      constraint: "plan",
      headline: s.isCustom ? `On your calendar: ${s.name}` : `Your plan: ${s.name}`,
      why: s.isCustom
        ? `You already put this on ${date}${s.km ? `, ${s.km} km` : ""}. The options below are alternatives if it will not fit.`
        : `Already prescribed for ${date}${s.km ? `, ${s.km} km` : ""}. A plan you wrote when you were thinking clearly beats a suggestion made now — the options below are alternatives if it will not fit.`,
      session: null,
    });
  }

  // --- Constraint: too tired for anything that matters.
  const buried = state.tsb < BURIED_TSB;
  // A hard session yesterday is still being absorbed today.
  const tooSoon =
    state.daysSinceHard !== null && state.daysSinceHard < HARD_RECOVERY_DAYS;
  const canGoHard = !buried && !tooSoon && state.tsb > BURIED_TSB;

  if (buried) {
    out.push({
      id: "fatigue-rest",
      priority: "do-this",
      score: 95,
      constraint: "fatigue",
      headline: "Take it easy today",
      why: `Form is ${state.tsb.toFixed(0)}. Below ${BURIED_TSB} is where sessions stop landing and niggles start — a hard day now costs more than it buys.`,
      session: recoveryRun(state),
    });
  } else if (tooSoon && state.lastHard) {
    out.push({
      id: "recent-hard",
      priority: "do-this",
      score: 85,
      constraint: "recent-hard",
      headline: state.lastHard.scheduled
        ? "Easy day — a hard session comes first"
        : "Easy day — you went hard recently",
      why: `"${state.lastHard.name}" ${describeHardDay(state.lastHard, today)}. Back-to-back hard days is the pattern that turns a good block into an injury.`,
      session: easyRun(state),
    });
  }

  // --- Opportunities. Each starts from a base and is moved by what the data
  // says, so the reasoning attached to it is the reasoning that ranked it.
  const candidates: Candidate[] = [];

  // Neglected disciplines. A triathlete's biggest gap is usually a whole sport.
  for (const key of ["ride", "swim"] as TriDiscipline[]) {
    const since = state.daysSince[key];
    if (since !== null && since >= DISCIPLINE_STALE_DAYS) {
      candidates.push({
        id: `stale-${key}`,
        kind: canGoHard && key === "ride" ? "intervals" : "easy",
        discipline: key,
        score: 70 + Math.min(20, since - DISCIPLINE_STALE_DAYS),
        headline:
          key === "ride"
            ? canGoHard
              ? "Hard bike with intervals"
              : "Get back on the bike"
            : "Get back in the pool",
        why: `You have not ${key === "ride" ? "ridden" : "swum"} in ${since} days. For a three-sport athlete that is a leg quietly falling off the plan.`,
        session:
          key === "ride"
            ? rideSession(state, canGoHard ? "intervals" : "easy", ftp)
            : swimSession(state),
      });
    }
  }

  // The missing stimulus, but only when there is freshness to use it.
  const z = input.zoneSeconds;
  const topEndUntouched = z ? z[4] < 60 && z[3] > 300 : false;
  if (topEndUntouched && canGoHard && state.tsb > FRESH_TSB) {
    candidates.push({
      id: "vo2",
      kind: "vo2",
      discipline: "run",
      score: 75,
      headline: "Short, sharp intervals",
      why: `You spent under a minute above threshold in six weeks while training Z4 regularly, and form is ${state.tsb > 0 ? "+" : ""}${state.tsb.toFixed(0)} — fresh enough to use it.`,
      session: intervalRun(state, vo2Template, "vo2"),
    });
  }

  // A long run overdue.
  if (
    state.daysSinceLong !== null &&
    state.daysSinceLong >= LONG_RUN_INTERVAL_DAYS &&
    !buried
  ) {
    candidates.push({
      id: "long",
      kind: "long",
      discipline: "run",
      score: 68,
      headline: "Long run",
      why: `Your last run over 16 km was ${state.daysSinceLong} days ago. Endurance is the slowest thing to build and the first to go.`,
      session: longRun(state),
    });
  }

  // Quality, when they are fresh and nothing above outranks it.
  if (canGoHard && state.tsb > FRESH_TSB) {
    candidates.push({
      id: "intervals",
      kind: "intervals",
      discipline: "run",
      score: 60,
      headline: template ? `Intervals — like ${template.name}` : "Interval session",
      why: `Form is ${state.tsb > 0 ? "+" : ""}${state.tsb.toFixed(0)} and your last hard session was ${state.daysSinceHard ?? "over a week"} days ago${template ? `. Your own ${template.name} gives the paces` : ""}.`,
      session: intervalRun(state, template, "intervals"),
    });
    candidates.push({
      id: "tempo",
      kind: "tempo",
      discipline: "run",
      score: 55,
      headline: "Tempo run",
      why: "Sustained effort is the cheapest way to raise threshold, and you have the freshness for it.",
      session: tempoRun(state),
    });
  }

  // The baselines that are always available.
  candidates.push({
    id: "recovery",
    kind: "recovery",
    discipline: "run",
    score: buried || tooSoon ? 55 : 25,
    headline: "Recovery run",
    why:
      buried || tooSoon
        ? "Short and genuinely slow. The point is blood flow, not training — it should feel almost too easy."
        : "An option if the legs are flat but you want to move.",
    session: recoveryRun(state),
  });

  candidates.push({
    id: "easy",
    kind: "easy",
    discipline: "run",
    score: buried || tooSoon ? 30 : 45,
    headline: "Easy run",
    why: state.medianEasyKm
      ? `Your usual easy run is about ${round(state.medianEasyKm, 0.5)} km. Easy volume is what lets the hard sessions work.`
      : "Aerobic volume, nothing taxing.",
    session: easyRun(state),
  });

  candidates.push({
    id: "rest",
    kind: "rest",
    discipline: "run",
    score: buried ? 60 : 20,
    headline: "Rest day",
    why: buried
      ? `Form is ${state.tsb.toFixed(0)}. A full day off is a legitimate session and the fastest way back to training properly.`
      : "Nothing wrong with a day off if the week has been heavy.",
    session: restDay(),
  });

  // Constraints suppress intensity outright rather than merely down-ranking it:
  // a suggestion that should not be followed must not be offered as an option.
  const allowed = candidates.filter((c) => {
    if (!canGoHard && (c.kind === "intervals" || c.kind === "vo2" || c.kind === "tempo")) {
      return false;
    }
    // A long run carries no intensity but is unmistakably a hard DAY. Offering
    // 23 km directly under a card that just said "back-to-back hard days is
    // how a good block becomes an injury" contradicts itself, and the athlete
    // is right to trust neither half.
    if ((buried || tooSoon) && c.kind === "long") return false;
    return true;
  });

  // A constraint card already carries a concrete session. Repeating the same
  // one lower down as an "option" pads the list without adding a choice.
  const alreadyOffered = new Set(
    out.filter((s) => s.session).map((s) => `${s.session!.discipline}:${s.session!.name}`),
  );

  // Rank counts only the opportunity cards: when a constraint already leads the
  // list, the best opportunity is an alternative to it rather than a second
  // instruction.
  let rank = out.length > 0 ? 1 : 0;
  for (const c of allowed.sort((a, b) => b.score - a.score)) {
    // Dedupe on the generated session, not just its category: two rules can
    // reasonably want the same workout, and offering it twice is padding.
    const key = c.session ? `${c.session.discipline}:${c.session.name}` : `none:${c.id}`;
    if (c.session && alreadyOffered.has(key)) continue;
    if (c.session) alreadyOffered.add(key);
    out.push({
      id: c.id,
      priority: priorityOf(c.score, rank++),
      score: c.score,
      headline: c.headline,
      why: c.why,
      session: c.session,
    });
  }

  return out.slice(0, limit);
}

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" });

/** "Thursday", for an ISO date. */
export function weekdayOf(date: string): string {
  return WEEKDAY.format(new Date(`${date}T12:00:00Z`));
}

function describeHardDay(last: NonNullable<AthleteState["lastHard"]>, today: string): string {
  if (last.scheduled) {
    return `is on your calendar for ${last.date === today ? "today" : weekdayOf(last.date)}`;
  }
  if (last.date === today) return "was today";
  if (last.date === shiftDays(today, -1)) return "was yesterday";
  return `was on ${weekdayOf(last.date)}`;
}

/** Render a suggestion as the workout note stored on the calendar. */
export function sessionNote(session: SuggestedSession): string {
  return session.steps
    .map((s) => `${s.label}: ${s.detail}`)
    .join(" · ")
    .slice(0, 500);
}

export { DISCIPLINE_LABEL as SUGGEST_DISCIPLINE_LABEL };
