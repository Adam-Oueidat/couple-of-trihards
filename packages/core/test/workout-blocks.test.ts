import { describe, expect, it } from "vitest";
import {
  EFFORT,
  intensityZone,
  resolveZoneModel,
  suggestWorkouts,
  totalSeconds,
  type QualityProfile,
  type StravaActivity,
  type SuggestedSession,
  type SuggestInput,
  type TrainingLoadPoint,
} from "../src";

/**
 * The workout profile chart draws `blocks`; the athlete reads `steps`. These
 * tests hold the two to the same session — a chart that disagrees with the
 * text beside it is worse than no chart.
 */

const TODAY = "2026-09-22";

const ZONES = resolveZoneModel(
  {
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
  },
  200,
);

let nextId = 1;

function day(offset: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().split("T")[0];
}

function act(date: string, sport: "Run" | "Ride" | "Swim", km: number, minutes: number): StravaActivity {
  return {
    id: nextId++,
    name: `${sport} ${date}`,
    sport_type: sport,
    type: sport,
    start_date: `${date}T08:00:00Z`,
    start_date_local: `${date}T08:00:00Z`,
    distance: km * 1000,
    moving_time: minutes * 60,
    average_heartrate: 150,
    manual: false,
  } as unknown as StravaActivity;
}

function baseHistory(): StravaActivity[] {
  const out: StravaActivity[] = [];
  for (let i = 2; i < 80; i += 2) out.push(act(day(-i), "Run", 10, 60));
  return out;
}

function load(tsb: number): TrainingLoadPoint[] {
  return [{ date: TODAY, ctl: 60, atl: 60 - tsb, tsb, dailyTSS: 0 }];
}

function input(over: Partial<SuggestInput> = {}): SuggestInput {
  return {
    activities: baseHistory(),
    trainingLoad: load(10),
    plan: null,
    zones: ZONES,
    today: TODAY,
    ...over,
  };
}

function repProfile(meters: number, count: number, paceSecPerKm: number): QualityProfile {
  return {
    activityId: "1",
    date: day(-7),
    name: `${meters}m Repeats`,
    workoutKey: `${meters}m repeats`,
    movingTime: 3600,
    elapsedTime: 3700,
    distance: 12000,
    avgHr: 165,
    maxHr: 185,
    hrSeconds: null,
    hrCoverage: null,
    decoupling: null,
    decouplingEligible: false,
    streamStatus: "ok",
    lapStatus: "ok",
    structure: {
      kind: "intervals",
      workSeconds: 0,
      recoverySeconds: 0,
      sets: [
        {
          label: `${count} x ${meters} m`,
          targetMeters: meters,
          fadePct: 0,
          hrDriftBpm: 0,
          reps: Array.from({ length: count }, (_, i) => ({
            index: i + 1,
            seconds: Math.round((meters / 1000) * paceSecPerKm),
            meters,
            paceSecPerKm,
            recoverySeconds: 75,
          })),
        },
      ],
    },
  };
}

function session(over: Partial<SuggestInput>, id: string): SuggestedSession {
  const s = suggestWorkouts(input(over), 10).find((x) => x.id === id)?.session;
  if (!s) throw new Error(`no ${id} suggestion`);
  return s;
}

const staleRide = [...baseHistory(), act(day(-14), "Ride", 40, 80)];
const staleSwim = [...baseHistory(), act(day(-14), "Swim", 1.6, 40)];
const longOverdue = [...baseHistory(), act(day(-12), "Run", 18, 110)];

/** One of every builder, in the states that produce them. */
function everySession(): [string, SuggestedSession][] {
  return [
    ["easy", session({}, "easy")],
    ["recovery", session({}, "recovery")],
    ["tempo", session({}, "tempo")],
    ["long", session({ activities: longOverdue }, "long")],
    ["generic intervals", session({}, "intervals")],
    ["generic vo2", session({ zoneSeconds: [0, 0, 0, 900, 0] }, "vo2")],
    ["template intervals", session({ profiles: [repProfile(1000, 5, 250)] }, "intervals")],
    [
      "template vo2",
      session({ profiles: [repProfile(400, 10, 215)], zoneSeconds: [0, 0, 0, 900, 0] }, "vo2"),
    ],
    ["ride with FTP", session({ activities: staleRide, athlete: { ftp: 226 } }, "stale-ride")],
    ["ride without FTP", session({ activities: staleRide }, "stale-ride")],
    ["easy ride", session({ activities: staleRide, trainingLoad: load(-30) }, "stale-ride")],
    ["swim", session({ activities: staleSwim }, "stale-swim")],
  ];
}

describe("every builder draws the session it describes", () => {
  it.each(everySession())("%s: blocks add up to the session's duration", (_, s) => {
    expect(s.blocks.length).toBeGreaterThan(0);
    expect(Math.abs(totalSeconds(s.blocks) / 60 - s.durationMin)).toBeLessThanOrEqual(1);
    for (const b of s.blocks) {
      expect(b.durationSec).toBeGreaterThan(0);
      expect(b.intensity).toBeGreaterThan(0);
    }
  });

  it.each(everySession())("%s: every rep sits above every recovery", (_, s) => {
    const work = s.blocks.filter((b) => b.kind === "work");
    const rest = s.blocks.filter((b) => b.kind === "recovery");
    if (work.length === 0 || rest.length === 0) return;
    expect(Math.min(...work.map((b) => b.intensity))).toBeGreaterThan(
      Math.max(...rest.map((b) => b.intensity)),
    );
  });

  it.each(everySession())("%s: a structured session warms up first and cools down last", (_, s) => {
    if (!s.blocks.some((b) => b.kind === "work" && s.blocks.length > 2)) return;
    expect(s.blocks[0].kind).toBe("warmup");
    expect(s.blocks[s.blocks.length - 1].kind).toBe("cooldown");
  });

  it("draws as many reps as the text prescribes", () => {
    for (const [, s] of everySession()) {
      const match = s.steps.map((st) => /(\d+) x /.exec(`${st.label} ${st.detail}`)).find(Boolean);
      // Only the main set counts; a ride's "3 x 1 min spin-ups" is warm-up.
      if (!match || s.discipline === "ride") continue;
      expect(s.blocks.filter((b) => b.kind === "work")).toHaveLength(Number(match[1]));
    }
    const ride = session({ activities: staleRide }, "stale-ride");
    expect(ride.blocks.filter((b) => b.kind === "work")).toHaveLength(4);
  });

  it("colours each block as the zone its text names", () => {
    const zoneOf = (s: SuggestedSession, kind: string) =>
      intensityZone(s.blocks.find((b) => b.kind === kind)!.intensity);
    expect(zoneOf(session({}, "easy"), "steady")).toBe(2);
    expect(zoneOf(session({}, "recovery"), "steady")).toBe(1);
    expect(zoneOf(session({}, "tempo"), "work")).toBe(3);
    expect(zoneOf(session({ zoneSeconds: [0, 0, 0, 900, 0] }, "vo2"), "work")).toBe(5);
    expect(zoneOf(session({ activities: staleRide, athlete: { ftp: 226 } }, "stale-ride"), "work")).toBe(4);
  });

  it("treats short reps as top end and kilometre reps as threshold", () => {
    const short = session({ profiles: [repProfile(400, 8, 215)] }, "intervals");
    const long = session({ profiles: [repProfile(1000, 5, 250)] }, "intervals");
    expect(short.blocks.find((b) => b.kind === "work")!.intensity).toBe(EFFORT.vo2);
    expect(long.blocks.find((b) => b.kind === "work")!.intensity).toBe(EFFORT.threshold);
  });

  it("draws the athlete's own reps at the pace they held", () => {
    const s = session({ profiles: [repProfile(1000, 5, 250)] }, "intervals");
    const rep = s.blocks.find((b) => b.kind === "work")!;
    expect(rep.durationSec).toBe(250);
    expect(rep.distanceM).toBe(1000);
    expect(rep.target).toBe("4:10/km");
  });
});

describe("the threshold line only carries a number that is real", () => {
  it("anchors a ride to FTP, with watts on the efforts", () => {
    const s = session({ activities: staleRide, athlete: { ftp: 226 } }, "stale-ride");
    expect(s.threshold).toEqual({ kind: "ftp", watts: 226 });
    const work = s.blocks.filter((b) => b.kind === "work");
    expect(work.every((b) => b.target === "215–226 W")).toBe(true);
  });

  it("puts no watts anywhere when FTP is unknown", () => {
    const s = session({ activities: staleRide }, "stale-ride");
    expect(s.threshold).toEqual({ kind: "effort" });
    expect(s.blocks.some((b) => b.target?.includes("W"))).toBe(false);
  });

  it("never invents a run or swim threshold pace", () => {
    for (const [name, s] of everySession()) {
      if (s.discipline === "ride") continue;
      expect(s.threshold, name).toEqual({ kind: "effort" });
    }
  });

  it("shows no pace on reps whose pace nobody knows", () => {
    const s = session({}, "intervals");
    expect(s.name).toBe("6 x 400 m");
    expect(s.blocks.some((b) => b.target)).toBe(false);
  });
});

describe("the swim adds up", () => {
  it("fills the athlete's usual distance, and says so in the steps", () => {
    const s = session({ activities: staleSwim }, "stale-swim");
    const meters = s.blocks.reduce((m, b) => m + (b.distanceM ?? 0), 0);
    expect(s.distanceKm).toBeCloseTo(meters / 1000);
    expect(s.name).toBe(`${meters} m swim`);
    const reps = s.blocks.filter((b) => b.kind === "work").length;
    expect(s.steps.some((st) => st.detail.startsWith(`${reps} x 100 m`))).toBe(true);
  });

  it("builds through the set", () => {
    const s = session({ activities: staleSwim }, "stale-swim");
    const work = s.blocks.filter((b) => b.kind === "work").map((b) => b.intensity);
    expect(work[work.length - 1]).toBeGreaterThan(work[0]);
  });
});
