/**
 * A suggested session as a shape: intensity over time, relative to threshold.
 *
 * The step text says "6 x 400 m at 5K effort, 90 s jog"; the blocks say the
 * same thing in a form that can be drawn, the way TrainingPeaks or Zwift draw a
 * structured workout. They are generated alongside the text by the same builder
 * so the two cannot drift apart, and they are display-only: nothing is stored.
 *
 * Repeats are EXPANDED, one block per rep and per recovery, rather than held as
 * a compact "N x (work, rest)" node. A session never has more than a few dozen
 * blocks, every consumer (the chart, a tooltip per rep, a total) wants them
 * laid out anyway, and expansion lets reps within a set differ — a swim set
 * that builds through its reps is simply a run of blocks with rising intensity.
 */

export type BlockKind = "warmup" | "work" | "recovery" | "cooldown" | "steady";

export interface WorkoutBlock {
  kind: BlockKind;
  /** What the athlete would call it: "Rep 3 of 6", "Warm-up", "Last third". */
  label: string;
  durationSec: number;
  /** Fraction of threshold, 1.0 = threshold. See EFFORT. */
  intensity: number;
  /** Set on a ramp, such as a building warm-up; the block is flat without it. */
  endIntensity?: number;
  /** Set when the prescription is a distance, so the chart can say "400 m". */
  distanceM?: number;
  /**
   * The prescription's own target, verbatim — "3:33/km", "215–226 W". Only
   * ever a number the athlete's data or FTP produced; never derived from the
   * intensity mapping, which is an approximation for drawing.
   */
  target?: string;
}

/**
 * What 100% means for this session. Rides anchor to FTP when Strava has one.
 * Runs anchor to a threshold pace when a recent race or a steady effort at
 * threshold heart rate supports one (see threshold.ts), and `from` names that
 * session so the number on the chart can be traced. Everything else — swims,
 * and runs with no such evidence — is "threshold effort" with no number:
 * Strava's best efforts alone are the fastest stretches of any run, not
 * all-out efforts, and a guess would be printed on every chart as fact.
 */
export type ThresholdAnchor =
  | { kind: "ftp"; watts: number }
  | { kind: "pace"; secPerKm: number; from: string }
  | { kind: "effort" };

/**
 * The one place intensity is mapped from effort language to a fraction of
 * threshold. For rides with FTP this is literally %FTP; for runs and swims it
 * is relative effort, drawn to the same scale so a tempo run and a threshold
 * ride sit at comparable heights.
 *
 * Each value is chosen to land in the zone its step text names (see
 * ZONE_FLOORS): an "easy, Z2" run must not be drawn in Z1's colour.
 */
export const EFFORT = {
  /** Standing or floating at the wall between swim reps. */
  rest: 0.35,
  /** The gentlest pedalling: where a ride warm-up starts and its cool-down ends. */
  spin: 0.5,
  /** Recovery runs, jogs and spins between reps. Z1. */
  recovery: 0.62,
  /** Conversational running, endurance riding. Z2 (top of Coggan Z2 on a bike). */
  easy: 0.72,
  /** The lift at the end of a long run. Upper Z2. */
  steady: 0.82,
  /** Comfortably hard: Z3 into low Z4. */
  tempo: 0.9,
  threshold: 1.0,
  /** 5K effort, "hard but repeatable", short reps. Z5. */
  vo2: 1.1,
  /** Strides: fast and relaxed, too short to be a training effort. */
  stride: 1.2,
} as const;

/**
 * Lower bounds of zones 1–5 as a fraction of threshold, for colouring blocks.
 * Coarser than any one sport's zone system on purpose: the chart only needs
 * each block to read as the zone its prescription names.
 */
export const ZONE_FLOORS = [0, 0.7, 0.85, 0.95, 1.05] as const;

/** Zone 1–5 for an intensity. */
export function intensityZone(intensity: number): 1 | 2 | 3 | 4 | 5 {
  let zone = 1;
  for (let i = 0; i < ZONE_FLOORS.length; i++) {
    if (intensity >= ZONE_FLOORS[i]) zone = i + 1;
  }
  return zone as 1 | 2 | 3 | 4 | 5;
}

export function totalSeconds(blocks: WorkoutBlock[]): number {
  return blocks.reduce((s, b) => s + b.durationSec, 0);
}

/** Whole minutes, for a session's `durationMin` derived from its blocks. */
export function blocksMinutes(blocks: WorkoutBlock[]): number {
  return Math.round(totalSeconds(blocks) / 60);
}

/**
 * `count` work blocks with a recovery between each — none after the last,
 * because the cool-down follows it.
 */
export function repeats(
  count: number,
  work: (i: number) => Omit<WorkoutBlock, "kind" | "label">,
  recovery: Omit<WorkoutBlock, "kind" | "label"> & { label?: string },
): WorkoutBlock[] {
  const out: WorkoutBlock[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ kind: "work", label: `Rep ${i + 1} of ${count}`, ...work(i) });
    if (i < count - 1) {
      out.push({ ...recovery, kind: "recovery", label: recovery.label ?? "Recovery" });
    }
  }
  return out;
}

/**
 * A running warm-up: easy, building, then strides. The strides are drawn
 * because the text asks for them, and because a warm-up that ends in four
 * short spikes is recognisably the same warm-up on every chart.
 */
export function runWarmup(minutes: number, strides: number): WorkoutBlock[] {
  const strideSec = 20;
  const jogSec = 40;
  const out: WorkoutBlock[] = [
    {
      kind: "warmup",
      label: "Warm-up",
      durationSec: minutes * 60 - strides * (strideSec + jogSec),
      intensity: EFFORT.recovery,
      endIntensity: EFFORT.easy,
    },
  ];
  for (let i = 0; i < strides; i++) {
    out.push(
      { kind: "warmup", label: `Stride ${i + 1} of ${strides}`, durationSec: strideSec, intensity: EFFORT.stride },
      { kind: "warmup", label: "Jog", durationSec: jogSec, intensity: EFFORT.recovery },
    );
  }
  return out;
}
