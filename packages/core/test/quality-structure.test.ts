import { describe, expect, it } from "vitest";
import { analyzeStructure, detectAutoLaps, isWalk, workoutKey, type Lap } from "../src";

let nextIndex = 1;

/** A lap, described the way a workout is: distance and duration. */
function lap(meters: number, seconds: number, hr?: number): Lap {
  return {
    id: nextIndex,
    name: `Lap ${nextIndex}`,
    lap_index: nextIndex++,
    distance: meters,
    moving_time: seconds,
    elapsed_time: seconds,
    average_speed: meters / seconds,
    average_heartrate: hr,
  } as unknown as Lap;
}

function reset() {
  nextIndex = 1;
}

describe("detectAutoLaps", () => {
  it("recognises a watch's automatic kilometre laps", () => {
    // The bug this prevents: without it, every easy long run comes back as
    // "10 x 1 km reps" and the interval analysis describes sessions that were
    // never interval sessions.
    reset();
    const laps = [
      ...Array.from({ length: 9 }, () => lap(1000, 330)),
      lap(420, 140), // the remainder
    ];
    expect(detectAutoLaps(laps)).toBe(true);
  });

  it("recognises automatic mile laps too", () => {
    reset();
    const laps = [...Array.from({ length: 5 }, () => lap(1609, 540)), lap(300, 100)];
    expect(detectAutoLaps(laps)).toBe(true);
  });

  it("leaves a real workout alone", () => {
    reset();
    const laps = [lap(400, 84), lap(200, 90), lap(400, 85), lap(200, 92), lap(400, 86)];
    expect(detectAutoLaps(laps)).toBe(false);
  });
});

describe("analyzeStructure", () => {
  it("reads a 6 x 400 with jog recoveries", () => {
    reset();
    const laps = [lap(2000, 660, 130)]; // warm-up
    for (let i = 0; i < 6; i++) {
      laps.push(lap(400, 84, 175));
      laps.push(lap(200, 90, 150));
    }
    laps.push(lap(1500, 520, 128)); // cool-down

    const s = analyzeStructure(laps, "run");
    expect(s.kind).toBe("intervals");
    expect(s.sets).toHaveLength(1);
    expect(s.sets[0].reps).toHaveLength(6);
    expect(s.sets[0].label).toBe("6 x 400 m");
    expect(s.sets[0].targetMeters).toBe(400);
    expect(s.workSeconds).toBe(6 * 84);
  });

  it("keeps the warm-up and cool-down out of recovery time", () => {
    // Otherwise "8 min work / 9 min recovery" is really "8 min work, 9 min
    // recovery and a 19-minute jog to the track", which describes a different
    // session entirely.
    reset();
    const laps = [lap(2000, 660, 130)];
    for (let i = 0; i < 6; i++) {
      laps.push(lap(400, 84, 175));
      laps.push(lap(200, 90, 150));
    }
    laps.push(lap(1500, 520, 128));

    const s = analyzeStructure(laps, "run");
    // Five inter-rep recoveries count. The sixth trails the last rep and is
    // folded into the cool-down, which is what it functionally is; the warm-up
    // and cool-down themselves are excluded entirely.
    expect(s.recoverySeconds).toBe(5 * 90);
    expect(s.recoverySeconds).toBeLessThan(660 + 520);
  });

  it("splits 800s into 400s into two sets", () => {
    reset();
    const laps = [lap(2000, 660, 130)];
    for (let i = 0; i < 3; i++) {
      laps.push(lap(800, 176, 176));
      laps.push(lap(200, 92, 150));
    }
    for (let i = 0; i < 4; i++) {
      laps.push(lap(400, 84, 180));
      laps.push(lap(200, 92, 152));
    }

    const s = analyzeStructure(laps, "run");
    expect(s.kind).toBe("intervals");
    expect(s.sets).toHaveLength(2);
    expect(s.sets[0].label).toBe("3 x 800 m");
    expect(s.sets[1].label).toBe("4 x 400 m");
  });

  it("describes a drop set as the descending chain it is", () => {
    reset();
    const laps = [lap(2000, 660, 130)];
    for (const m of [800, 600, 400, 200]) {
      laps.push(lap(m, Math.round(m * 0.21), 178));
      laps.push(lap(200, 92, 150));
    }

    const s = analyzeStructure(laps, "run");
    expect(s.kind).toBe("intervals");
    const reps = s.sets.flatMap((set) => set.reps);
    expect(reps.map((r) => r.meters)).toEqual([800, 600, 400, 200]);
  });

  it("calls a steady run steady rather than inventing reps", () => {
    reset();
    // Mild pacing drift only — nothing that separates work from rest.
    const laps = [lap(1500, 465), lap(1500, 470), lap(1500, 460), lap(1500, 468), lap(1500, 463)];
    const s = analyzeStructure(laps, "run");
    expect(s.kind).toBe("steady");
    expect(s.sets).toEqual([]);
  });

  it("falls through to steady when the clusters barely separate", () => {
    reset();
    // 5% apart — under the 8% guard. The right failure is "no structure", not
    // a confident claim about reps that were really just pacing variation.
    const laps = [
      lap(1000, 300), lap(1000, 315), lap(1000, 300),
      lap(1000, 315), lap(1000, 301), lap(1000, 314),
    ];
    expect(analyzeStructure(laps, "run").kind).toBe("steady");
  });

  it("drops marker laps from a double-pressed lap button", () => {
    reset();
    const laps = [lap(2000, 660, 130)];
    for (let i = 0; i < 5; i++) {
      laps.push(lap(400, 84, 175));
      laps.push(lap(8, 3)); // fat-fingered lap button
      laps.push(lap(200, 90, 150));
    }
    const s = analyzeStructure(laps, "run");
    expect(s.kind).toBe("intervals");
    expect(s.sets[0].reps).toHaveLength(5);
    expect(s.sets[0].reps.every((r) => r.meters === 400)).toBe(true);
  });

  it("never counts a walk break as a work rep", () => {
    reset();
    const laps = [lap(2000, 660, 130)];
    for (let i = 0; i < 5; i++) {
      laps.push(lap(400, 84, 175));
      laps.push(lap(200, 200, 120)); // 16:40/km — walking
    }
    const s = analyzeStructure(laps, "run");
    const reps = s.sets.flatMap((set) => set.reps);
    expect(reps.every((r) => r.meters === 400)).toBe(true);
  });

  it("computes fade and heart-rate drift across a set", () => {
    reset();
    const laps = [lap(2000, 660, 130)];
    // 80s rising to 88s: the last rep is 10% slower than the first.
    const times = [80, 82, 84, 86, 88];
    const hrs = [170, 174, 178, 182, 186];
    times.forEach((t, i) => {
      laps.push(lap(400, t, hrs[i]));
      laps.push(lap(200, 92, 150));
    });

    const s = analyzeStructure(laps, "run");
    expect(s.sets[0].fadePct).toBeCloseTo(10, 0);
    expect(s.sets[0].hrDriftBpm).toBe(16);
  });

  it("spots a progression run instead of inventing reps from it", () => {
    // A progression splits into a slow cluster and a fast one just as cleanly
    // as an interval session does. What separates them is alternation: these
    // fast laps are one contiguous block at the end, so there are no reps here.
    // Distances are deliberately not round kilometres, or auto-lap detection
    // would catch this before the clustering ever ran.
    reset();
    const laps = [lap(1200, 396), lap(1200, 380), lap(1200, 364), lap(1200, 348), lap(1200, 330)];
    const s = analyzeStructure(laps, "run");
    expect(s.kind).toBe("progression");
    expect(s.sets).toEqual([]);
  });

  it("says nothing about a session with too few laps", () => {
    reset();
    expect(analyzeStructure([lap(5000, 1500)], "run").kind).toBe("steady");
    expect(analyzeStructure([], "run").kind).toBe("steady");
  });
});

describe("isWalk", () => {
  it("is true below roughly 10 min/km for a runner", () => {
    expect(isWalk(1.5, "run")).toBe(true);
    expect(isWalk(3.0, "run")).toBe(false);
  });

  it("never applies to cycling or swimming", () => {
    expect(isWalk(1.5, "ride")).toBe(false);
    expect(isWalk(1.5, "swim")).toBe(false);
  });
});

describe("workoutKey", () => {
  it("strips the time-of-day prefix Strava prepends", () => {
    expect(workoutKey("Morning Run")).toBe("run");
    expect(workoutKey("Lunch Tempo 4-3-2-1")).toBe(workoutKey("Tempo 4-3-2-1"));
  });

  it("keeps digits, so different distances stay different workouts", () => {
    // Collapsing these would compare 400m reps against 800m reps and report a
    // two-minute-per-kilometre improvement that never happened.
    expect(workoutKey("400m Repeats")).not.toBe(workoutKey("800m Repeats"));
  });

  it("is stable across occurrences of the same session", () => {
    expect(workoutKey("Drop Set")).toBe(workoutKey("Evening Drop Set"));
    expect(workoutKey("Rolling 300s")).toBe(workoutKey("Rolling 300s"));
  });
});

/**
 * Fixtures taken from the athlete's actual Strava lap files.
 *
 * Every bug in this block was invisible to the hand-written fixtures above and
 * only appeared when the detector was first run against real sessions. Real
 * track recoveries are 60-90 seconds covering 50-130 metres at walking pace,
 * which is nothing like the tidy 200m jog a synthetic fixture reaches for.
 */
describe("analyzeStructure against real sessions", () => {
  /** Build a lap list from [metres, seconds, hr] triples. */
  function laps(rows: [number, number, number?][]): Lap[] {
    reset();
    return rows.map(([m, s, hr]) => lap(m, s, hr));
  }

  it("reads 400m Repeats — twelve reps behind sub-100m recoveries", () => {
    // The bug: recoveries here are 48-83 m, and a marker rule of "under 20 s OR
    // under 100 m" discarded every one of them as a double-pressed lap button.
    // With the separators gone the twelve reps looked like one contiguous block
    // of work, the alternation guard saw a single group, and a track session
    // came back as a steady run.
    const s = analyzeStructure(
      laps([
        [4526, 1600, 156], [23, 90, 0],
        [400, 90, 161], [73, 60, 175],
        [400, 94, 169], [75, 60, 179],
        [400, 94, 174], [73, 60, 181],
        [400, 93, 177], [76, 60, 182],
        [400, 94, 177], [65, 60, 184],
        [400, 93, 176], [75, 150, 178],
        [400, 93, 167], [48, 60, 180],
        [400, 94, 175], [72, 60, 180],
        [400, 94, 177], [73, 60, 180],
        [400, 91, 179], [83, 60, 184],
        [400, 92, 180], [77, 60, 184],
        [400, 85, 182], [111, 150, 182],
        [3000, 1109, 155], [1094, 403, 155],
      ]),
      "run",
    );
    expect(s.kind).toBe("intervals");
    expect(s.sets).toHaveLength(1);
    expect(s.sets[0].reps).toHaveLength(12);
    expect(s.sets[0].label).toBe("12 x 400 m");
    // The 4.5 km warm-up and 4 km of cool-down must not be counted as recovery.
    expect(s.recoverySeconds).toBeLessThan(15 * 60);
    // He negative-splits the set while heart rate climbs — the real finding.
    expect(s.sets[0].fadePct!).toBeLessThan(0);
    expect(s.sets[0].hrDriftBpm!).toBeGreaterThan(15);
  });

  it("reads a Drop Set as five descending pairs", () => {
    const s = analyzeStructure(
      laps([
        [4022, 1316, 151], [79, 90, 135],
        [1000, 252, 169], [125, 90, 159],
        [1000, 241, 176], [117, 90, 173],
        [800, 190, 178], [94, 90, 165],
        [800, 191, 178], [120, 90, 170],
        [600, 135, 177], [101, 90, 178],
        [600, 140, 178], [101, 90, 174],
        [400, 91, 173], [115, 90, 170],
        [400, 90, 174], [119, 90, 172],
        [200, 41, 169], [131, 90, 166],
        [200, 40, 166], [127, 90, 165],
        [3000, 1019, 160], [368, 121, 162],
      ]),
      "run",
    );
    expect(s.kind).toBe("intervals");
    expect(s.sets.map((set) => set.label)).toEqual([
      "2 x 1000 m",
      "2 x 800 m",
      "2 x 600 m",
      "2 x 400 m",
      "2 x 200 m",
    ]);
    // Recoveries here are every one of them below walking pace. Counting only
    // jogged recoveries would report this session as having none at all.
    expect(s.recoverySeconds).toBeGreaterThan(10 * 60);
  });

  it("reads a descending tempo as four blocks, not one steady run", () => {
    // Same alternation bug as the track session: the floats between blocks are
    // walk-pace, so once they were filtered out the four tempo blocks looked
    // contiguous and the session read as steady.
    const s = analyzeStructure(
      laps([
        [1745, 562, 150],
        [4000, 1122, 177], [273, 210, 160],
        [3000, 827, 182], [157, 180, 160],
        [2000, 541, 183], [103, 120, 160],
        [1000, 265, 181], [104, 90, 160],
        [1500, 526, 150], [18, 7, 140],
      ]),
      "run",
    );
    expect(s.kind).toBe("intervals");
    expect(s.sets.map((set) => set.reps[0].meters)).toEqual([4000, 3000, 2000, 1000]);
    // The 18 m / 7 s lap at the end is a genuine double-press and stays dropped.
    expect(s.sets.flatMap((set) => set.reps).every((r) => r.meters >= 1000)).toBe(true);
  });

  it("reads a rolling session where the recovery is a float, not a jog", () => {
    // No walk recoveries at all: 300 m hard alternating with 300 m easy. The
    // clustering has to separate them on speed alone.
    const rows: [number, number, number?][] = [[4016, 1378, 150]];
    const fast = [81, 80, 80, 78, 79, 77, 79, 78, 77, 76];
    const float = [93, 95, 89, 90, 91, 88, 89, 85, 88, 86];
    fast.forEach((f, i) => {
      rows.push([300, f, 178]);
      rows.push([300, float[i], 165]);
    });
    rows.push([3000, 1029, 155]);

    const s = analyzeStructure(laps(rows), "run");
    expect(s.kind).toBe("intervals");
    const reps = s.sets.flatMap((set) => set.reps);
    expect(reps.length).toBeGreaterThanOrEqual(9);
    expect(reps.every((r) => r.meters === 300)).toBe(true);
  });
});
