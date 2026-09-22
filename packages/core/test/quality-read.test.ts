import { describe, expect, it } from "vitest";
import {
  buildQualityRecap,
  findRepeatedWorkouts,
  readQuality,
  HR_HIST_MIN,
  HR_HIST_LEN,
  type QualityProfile,
  type SessionStructure,
  type StravaActivity,
} from "../src";

const TODAY = "2026-09-21";

const ZONES = {
  heart_rate: {
    custom_zones: false,
    zones: [
      { min: 0, max: 133 },
      { min: 133, max: 165 },
      { min: 165, max: 182 },
      { min: 182, max: 198 },
      { min: 198, max: -1 },
    ],
  },
};

let nextId = 1;

function day(offset: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().split("T")[0];
}

function run(date: string, avgHr = 150, maxHr = 175): StravaActivity {
  return {
    id: nextId++,
    name: `Run ${date}`,
    sport_type: "Run",
    type: "Run",
    start_date: `${date}T08:00:00Z`,
    start_date_local: `${date}T08:00:00Z`,
    distance: 10000,
    moving_time: 3300,
    average_heartrate: avgHr,
    max_heartrate: maxHr,
    manual: false,
  } as unknown as StravaActivity;
}

/** A histogram putting `seconds` at a single heart rate. */
function hist(entries: [number, number][]): number[] {
  const h = new Array(HR_HIST_LEN).fill(0);
  for (const [bpm, secs] of entries) h[bpm - HR_HIST_MIN] += secs;
  return h;
}

function profile(
  activity: StravaActivity,
  over: Partial<QualityProfile> = {},
): QualityProfile {
  return {
    activityId: String(activity.id),
    date: activity.start_date_local.split("T")[0],
    name: activity.name,
    workoutKey: activity.name.toLowerCase(),
    movingTime: activity.moving_time,
    elapsedTime: activity.elapsed_time ?? activity.moving_time,
    distance: activity.distance,
    avgHr: activity.average_heartrate ?? null,
    maxHr: activity.max_heartrate ?? null,
    hrSeconds: hist([[150, 3300]]),
    hrCoverage: 1,
    decoupling: null,
    decouplingEligible: false,
    structure: null,
    streamStatus: "ok",
    lapStatus: "skipped",
    ...over,
  };
}

/** A structure with one set of `n` reps at a given pace and heart-rate shape. */
function intervals(
  n: number,
  opts: { fadePct?: number; hrDriftBpm?: number } = {},
): SessionStructure {
  return {
    kind: "intervals",
    workSeconds: n * 84,
    recoverySeconds: (n - 1) * 90,
    sets: [
      {
        label: `${n} x 400 m`,
        targetMeters: 400,
        fadePct: opts.fadePct ?? 0,
        hrDriftBpm: opts.hrDriftBpm ?? 0,
        reps: Array.from({ length: n }, (_, i) => ({
          index: i + 1,
          seconds: 84,
          meters: 400,
          paceSecPerKm: 210,
          avgHr: 175,
        })),
      },
    ],
  };
}

function recapWith(
  activities: StravaActivity[],
  profiles: QualityProfile[],
) {
  return buildQualityRecap({ activities, profiles, zones: ZONES, today: TODAY });
}

describe("readQuality — refusing to speak too soon", () => {
  it("says only that there is not enough heart-rate data", () => {
    const acts = [run(day(-3)), run(day(-2))];
    const insights = readQuality(recapWith(acts, []));
    expect(insights).toHaveLength(1);
    expect(insights[0].id).toBe("no-hr");
  });

  it("says nothing about zones when there is no zone model at all", () => {
    const recap = buildQualityRecap({
      activities: [run(day(-3))],
      profiles: [],
      zones: null,
      today: TODAY,
    });
    // No zones and no max heart rate to derive them from.
    recap.zones.source = "none";
    expect(readQuality(recap)[0].id).toBe("no-hr");
  });
});

describe("readQuality — intensity distribution", () => {
  const acts = Array.from({ length: 12 }, (_, i) => run(day(-i - 1)));

  it("flags a grey-zone block from real time in zone", () => {
    // Half the time in Z3 — the classic too-hard-easy-days pattern.
    const profiles = acts.map((a) =>
      profile(a, { hrSeconds: hist([[150, 1500], [170, 1800]]) }),
    );
    const insight = readQuality(recapWith(acts, profiles), 6).find(
      (i) => i.id === "easy-not-easy",
    );
    expect(insight?.tone).toBe("warn");
  });

  it("credits a properly polarised block", () => {
    const profiles = acts.map((a) =>
      profile(a, { hrSeconds: hist([[150, 3000], [175, 300]]) }),
    );
    expect(readQuality(recapWith(acts, profiles), 6).map((i) => i.id)).toContain(
      "easy-discipline",
    );
  });

  it("names an untouched top end only from time, never from peak heart rate", () => {
    // Substantial Z4, essentially no Z5.
    const profiles = acts.map((a) =>
      profile(a, { hrSeconds: hist([[150, 2500], [190, 100]]) }),
    );
    const insight = readQuality(recapWith(acts, profiles), 6).find(
      (i) => i.id === "top-end-untouched",
    );
    expect(insight).toBeDefined();
    expect(insight!.detail).toMatch(/Z4/);
  });

  it("falls back to peak-heart-rate wording before anything is scanned", () => {
    // 24 sessions, most peaking into Z4, one into Z5 — Adam's real shape.
    const many = [
      ...Array.from({ length: 23 }, (_, i) => run(day(-i - 1), 160, 190)),
      run(day(-24), 160, 200),
    ];
    const insight = readQuality(recapWith(many, []), 6).find(
      (i) => i.id === "top-end-summary",
    );
    expect(insight).toBeDefined();
    // It must describe PEAK heart rate and offer the scan, never claim time.
    expect(insight!.detail).toMatch(/peak heart rate is not time spent there/i);
    expect(insight!.headline).toMatch(/Peak heart rate reached/);
  });

  it("suppresses the peak-heart-rate wording once real time in zone exists", () => {
    const profiles = acts.map((a) =>
      profile(a, { hrSeconds: hist([[150, 2500], [190, 100]]) }),
    );
    const ids = readQuality(recapWith(acts, profiles), 6).map((i) => i.id);
    expect(ids).toContain("top-end-untouched");
    expect(ids).not.toContain("top-end-summary");
  });
});

describe("readQuality — rep quality", () => {
  const acts = Array.from({ length: 12 }, (_, i) => run(day(-i - 1)));

  function withSets(fade: number, drift = 0) {
    return acts.slice(0, 3).map((a) =>
      profile(a, { structure: intervals(6, { fadePct: fade, hrDriftBpm: drift }), lapStatus: "ok" }),
    );
  }

  it("flags a real fade across the set", () => {
    const insight = readQuality(recapWith(acts, withSets(4)), 6).find((i) => i.id === "rep-fade");
    expect(insight?.tone).toBe("warn");
  });

  it("stays quiet inside the lap-timing noise floor", () => {
    // 1% on an 80-second rep is under a second — indistinguishable from the
    // precision of a lap button. Claiming a fade here would be noise dressed
    // up as a finding.
    const ids = readQuality(recapWith(acts, withSets(1)), 6).map((i) => i.id);
    expect(ids).not.toContain("rep-fade");
    expect(ids).toContain("rep-even");
  });

  it("flags heart rate climbing while pace holds", () => {
    const insight = readQuality(recapWith(acts, withSets(0, 10)), 6).find(
      (i) => i.id === "rep-hr-drift",
    );
    expect(insight?.detail).toMatch(/recoveries are too short/);
  });

  it("says nothing about reps from a single session", () => {
    const one = [profile(acts[0], { structure: intervals(6, { fadePct: 6 }), lapStatus: "ok" })];
    expect(readQuality(recapWith(acts, one), 6).map((i) => i.id)).not.toContain("rep-fade");
  });
});

describe("readQuality — ranking", () => {
  it("puts the most serious finding first and honours the limit", () => {
    const acts = Array.from({ length: 12 }, (_, i) => run(day(-i - 1)));
    const profiles = acts.map((a) =>
      profile(a, {
        hrSeconds: hist([[150, 1500], [170, 1800]]), // grey zone -> warn
        structure: intervals(6, { fadePct: 5 }),      // fade -> warn
        lapStatus: "ok",
      }),
    );
    const insights = readQuality(recapWith(acts, profiles), 2);
    expect(insights).toHaveLength(2);
    expect(insights[0].tone).toBe("warn");
  });
});

describe("findRepeatedWorkouts", () => {
  function repeat(date: string, name: string, paceSecPerKm: number, reps: number) {
    const a = run(date);
    a.name = name;
    const s = intervals(reps);
    s.sets[0].reps = s.sets[0].reps.map((r) => ({ ...r, paceSecPerKm }));
    return profile(a, { name, workoutKey: name.toLowerCase(), structure: s, lapStatus: "ok" });
  }

  it("compares the same workout across occurrences", () => {
    const rows = [
      repeat(day(-60), "400m Repeats", 220, 6),
      repeat(day(-10), "400m Repeats", 210, 6),
    ];
    const found = findRepeatedWorkouts(rows);
    expect(found).toHaveLength(1);
    expect(found[0].changePct).toBeCloseTo(-4.5, 0);
  });

  it("refuses to compare a truncated session against a complete one", () => {
    // Four reps of six is not a personal best, however fast the four were —
    // without this guard, stopping early reads as improvement.
    const rows = [
      repeat(day(-60), "400m Repeats", 220, 6),
      repeat(day(-10), "400m Repeats", 200, 3),
    ];
    expect(findRepeatedWorkouts(rows)[0].changePct).toBeNull();
  });

  it("keeps different distances apart", () => {
    const rows = [
      repeat(day(-60), "400m Repeats", 210, 6),
      repeat(day(-10), "800m Repeats", 230, 6),
    ];
    expect(findRepeatedWorkouts(rows)).toHaveLength(0);
  });
});

describe("buildQualityRecap coverage", () => {
  const acts = Array.from({ length: 10 }, (_, i) => run(day(-i - 1)));

  it("reports the summary tier before anything is scanned", () => {
    const recap = recapWith(acts, []);
    expect(recap.coverage.tier).toBe("summary");
    expect(recap.timeInZone).toBeNull();
  });

  it("reports a partial tier mid-scan", () => {
    const recap = recapWith(acts, acts.slice(0, 4).map((a) => profile(a)));
    expect(recap.coverage.tier).toBe("partial");
    expect(recap.coverage.scanned).toBe(4);
    expect(recap.timeInZone).not.toBeNull();
  });

  it("excludes a low-coverage trace from the window total", () => {
    // A session whose strap dropped for half the run would understate a zone
    // if averaged in. It still exists as a row; it just does not vote.
    const profiles = [
      ...acts.slice(0, 3).map((a) => profile(a)),
      profile(acts[3], { hrCoverage: 0.4, streamStatus: "partial" }),
    ];
    expect(recapWith(acts, profiles).coverage.scanned).toBe(3);
  });

  it("does not count manual activities as still to scan", () => {
    const profiles = [
      ...acts.slice(0, 9).map((a) => profile(a)),
      profile(acts[9], { hrSeconds: null, streamStatus: "none" }),
    ];
    expect(recapWith(acts, profiles).coverage.tier).toBe("full");
  });
});
