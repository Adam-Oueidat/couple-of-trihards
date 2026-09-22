import { describe, expect, it } from "vitest";
import {
  readAthleteState,
  resolveZoneModel,
  sessionNote,
  suggestWorkouts,
  type QualityProfile,
  type StravaActivity,
  type SuggestInput,
  type TrainingLoadPoint,
  type TrainingPlan,
} from "../src";

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

function act(
  date: string,
  sport: "Run" | "Ride" | "Swim",
  km: number,
  minutes: number,
  over: Partial<StravaActivity> = {},
): StravaActivity {
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
    ...over,
  } as unknown as StravaActivity;
}

/** A believable recent history: easy runs every other day for three months. */
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
    trainingLoad: load(0),
    plan: null,
    zones: ZONES,
    today: TODAY,
    ...over,
  };
}

function ids(over: Partial<SuggestInput> = {}, limit = 8): string[] {
  return suggestWorkouts(input(over), limit).map((s) => s.id);
}

describe("constraints outrank opportunities", () => {
  it("leads with the planned session rather than a suggestion of its own", () => {
    // A plan written in advance beats a ranking computed now. The suggester
    // offers alternatives; it does not argue with the plan.
    const plan: TrainingPlan = {
      name: "Block",
      source: "runna",
      discipline: "run",
      startDate: day(-30),
      raceDate: day(30),
      raceName: "Race",
      sessions: [
        {
          id: "s1",
          date: TODAY,
          originalDate: TODAY,
          name: "Threshold 5 x 1km",
          type: "intervals",
          km: 12,
        },
      ],
    } as TrainingPlan;

    const out = suggestWorkouts(input({ plan }));
    expect(out[0].id).toBe("plan-today");
    expect(out[0].constraint).toBe("plan");
    expect(out[0].headline).toContain("Threshold 5 x 1km");
  });

  it("refuses to offer intensity when form is buried", () => {
    // The gap-seeking rules would still like to prescribe intervals here —
    // "your top end is untouched" stays true of someone who cannot walk. The
    // constraint stage has to remove the option, not merely rank it lower.
    const out = suggestWorkouts(
      input({ trainingLoad: load(-30), zoneSeconds: [0, 0, 0, 900, 0] }),
      8,
    );
    expect(out[0].constraint).toBe("fatigue");
    const kinds = out.map((s) => s.session?.kind);
    expect(kinds).not.toContain("intervals");
    expect(kinds).not.toContain("vo2");
    expect(kinds).not.toContain("tempo");
  });

  it("refuses intensity the day after a hard session", () => {
    const acts = [...baseHistory(), act(day(-1), "Run", 14, 75, { suffer_score: 240 })];
    const out = suggestWorkouts(input({ activities: acts, trainingLoad: load(5) }), 8);
    expect(out[0].constraint).toBe("recent-hard");
    expect(out.map((s) => s.session?.kind)).not.toContain("intervals");
  });

  it("allows intensity again once the hard session is absorbed", () => {
    const acts = [...baseHistory(), act(day(-3), "Run", 14, 75, { suffer_score: 240 })];
    const kinds = suggestWorkouts(
      input({ activities: acts, trainingLoad: load(5) }),
      8,
    ).map((s) => s.session?.kind);
    expect(kinds).toContain("intervals");
  });

  it("never returns an empty list, even with no history at all", () => {
    const out = suggestWorkouts(input({ activities: [], trainingLoad: [] }));
    expect(out.length).toBeGreaterThan(0);
  });

  it("offers a rest day as a real option rather than hiding it", () => {
    expect(ids({ trainingLoad: load(-30) })).toContain("rest");
  });
});

describe("opportunities", () => {
  it("surfaces a discipline that has gone quiet", () => {
    // Rides stop twelve days ago; runs continue.
    const acts = [...baseHistory(), act(day(-12), "Ride", 40, 80)];
    const top = suggestWorkouts(input({ activities: acts }), 8).find(
      (s) => s.id === "stale-ride",
    );
    expect(top).toBeDefined();
    expect(top!.why).toContain("12 days");
    expect(top!.session?.discipline).toBe("ride");
  });

  it("does not nag about a discipline that was never trained", () => {
    // Suggesting a swim to someone with no swim history at all is noise, not
    // insight — there is no gap, just a sport they do not do.
    expect(ids()).not.toContain("stale-swim");
  });

  it("asks for top-end work only when there is freshness to use it", () => {
    const zoneSeconds = [0, 0, 0, 900, 0]; // plenty of Z4, no Z5
    expect(ids({ zoneSeconds, trainingLoad: load(10) })).toContain("vo2");
    // Same gap, no freshness — the gap is real but today is not the day.
    expect(ids({ zoneSeconds, trainingLoad: load(-20) })).not.toContain("vo2");
  });

  it("asks for a long run once one is overdue", () => {
    const acts = [...baseHistory(), act(day(-12), "Run", 20, 110)];
    const long = suggestWorkouts(input({ activities: acts }), 8).find(
      (s) => s.id === "long",
    );
    expect(long?.why).toContain("12 days ago");
  });

  it("ranks a neglected sport above a routine easy run", () => {
    const acts = [...baseHistory(), act(day(-14), "Ride", 40, 80)];
    const out = suggestWorkouts(input({ activities: acts }), 8);
    const ride = out.findIndex((s) => s.id === "stale-ride");
    const easy = out.findIndex((s) => s.id === "easy");
    expect(ride).toBeGreaterThanOrEqual(0);
    expect(ride).toBeLessThan(easy);
  });
});

describe("generated sessions", () => {
  it("sizes an easy run to what the athlete actually runs", () => {
    const acts = Array.from({ length: 20 }, (_, i) => act(day(-i - 2), "Run", 14, 82));
    const easy = suggestWorkouts(input({ activities: acts }), 8).find(
      (s) => s.id === "easy",
    );
    expect(easy!.session!.distanceKm).toBe(14);
  });

  it("steps a long run up from recent history rather than inventing a distance", () => {
    // A long run that jumps well past what they have been doing is how a good
    // block becomes a calf strain.
    const acts = [
      ...baseHistory(),
      act(day(-20), "Run", 18, 100),
      act(day(-27), "Run", 17, 95),
      act(day(-34), "Run", 18, 100),
    ];
    const long = suggestWorkouts(input({ activities: acts }), 8).find(
      (s) => s.id === "long",
    );
    expect(long!.session!.distanceKm).toBeGreaterThan(17);
    expect(long!.session!.distanceKm).toBeLessThanOrEqual(20);
  });

  it("builds intervals from the athlete's own reps and paces", () => {
    const profile: QualityProfile = {
      activityId: "1",
      date: day(-7),
      name: "400m Repeats",
      workoutKey: "400m repeats",
      movingTime: 3600,
      elapsedTime: 3700,
      distance: 14000,
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
        workSeconds: 1080,
        recoverySeconds: 540,
        sets: [
          {
            label: "12 x 400 m",
            targetMeters: 400,
            fadePct: -5.3,
            hrDriftBpm: 21,
            reps: Array.from({ length: 12 }, (_, i) => ({
              index: i + 1,
              seconds: 93,
              meters: 400,
              paceSecPerKm: i === 11 ? 213 : 233,
              avgHr: 175,
              recoverySeconds: 60,
            })),
          },
        ],
      },
    };

    const out = suggestWorkouts(
      input({ profiles: [profile], trainingLoad: load(10) }),
      8,
    ).find((s) => s.id === "intervals");

    expect(out!.headline).toContain("400m Repeats");
    expect(out!.session!.name).toBe("12 x 400 m");
    // Targets the best rep they held, not the average — the set was provably
    // repeatable at that pace at least once.
    expect(out!.session!.summary).toContain("3:33/km");
    expect(out!.session!.summary).toContain(day(-7));
  });

  it("falls back to a standard session with no library to draw on", () => {
    const out = suggestWorkouts(input({ trainingLoad: load(10) }), 8).find(
      (s) => s.id === "intervals",
    );
    expect(out!.session!.name).toMatch(/\d+ x \d+ m/);
    expect(out!.session!.summary).not.toContain("Based on your");
  });

  it("gives a bike session real watts when FTP is known, and effort when not", () => {
    const acts = [...baseHistory(), act(day(-14), "Ride", 40, 80)];
    const withFtp = suggestWorkouts(
      input({ activities: acts, athlete: { ftp: 226 }, trainingLoad: load(10) }),
      8,
    ).find((s) => s.id === "stale-ride");
    expect(withFtp!.session!.steps.some((s) => s.detail.includes("W"))).toBe(true);

    const without = suggestWorkouts(
      input({ activities: acts, trainingLoad: load(10) }),
      8,
    ).find((s) => s.id === "stale-ride");
    expect(without!.session!.steps.some((s) => s.detail.includes("threshold effort"))).toBe(true);
  });

  it("writes a calendar note that fits the column", () => {
    const easy = suggestWorkouts(input(), 8).find((s) => s.id === "easy");
    const note = sessionNote(easy!.session!);
    expect(note.length).toBeGreaterThan(0);
    expect(note.length).toBeLessThanOrEqual(500);
  });
});

describe("readAthleteState", () => {
  it("reports days since each discipline", () => {
    const acts = [
      act(day(-1), "Run", 10, 60),
      act(day(-5), "Ride", 30, 60),
      act(day(-20), "Swim", 1.2, 30),
    ];
    const s = readAthleteState(input({ activities: acts }));
    expect(s.daysSince).toEqual({ run: 1, ride: 5, swim: 20 });
  });

  it("names the hard session still being absorbed", () => {
    const acts = [...baseHistory(), act(day(-1), "Run", 14, 75, { suffer_score: 250 })];
    const s = readAthleteState(input({ activities: acts }));
    expect(s.daysSinceHard).toBe(1);
    expect(s.lastHard?.name).toContain("Run");
  });

  it("is null rather than zero for a discipline never trained", () => {
    expect(readAthleteState(input()).daysSince.swim).toBeNull();
  });
});

describe("the list never contradicts itself", () => {
  /** Hard session today: the constraint stage fires. */
  const hardToday = () => [
    ...baseHistory(),
    act(TODAY, "Run", 14, 75, { suffer_score: 250, name: "Drop Set" }),
    act(day(-12), "Run", 20, 110),
  ];

  it("does not offer a long run under a card warning against hard days", () => {
    // Found on real data: the panel said "back-to-back hard days is how a good
    // block becomes an injury" and then offered 23 km directly beneath it. A
    // long run carries no intensity but is unmistakably a hard day, and an
    // athlete is right to trust neither half of a self-contradicting list.
    const out = suggestWorkouts(input({ activities: hardToday(), trainingLoad: load(-3) }), 8);
    expect(out[0].constraint).toBe("recent-hard");
    expect(out.map((s) => s.session?.kind)).not.toContain("long");
  });

  it("still offers a long run when there is no constraint in the way", () => {
    const acts = [...baseHistory(), act(day(-12), "Run", 20, 110)];
    expect(
      suggestWorkouts(input({ activities: acts, trainingLoad: load(5) }), 8).map(
        (s) => s.session?.kind,
      ),
    ).toContain("long");
  });

  it("does not repeat a session the constraint card already offered", () => {
    // The constraint card carries a concrete easy run; listing the identical
    // session again lower down pads the list without adding a choice.
    const out = suggestWorkouts(input({ activities: hardToday(), trainingLoad: load(-3) }), 8);
    const keys = out
      .filter((s) => s.session)
      .map((s) => `${s.session!.discipline}:${s.session!.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("still leaves something to choose between when constrained", () => {
    const out = suggestWorkouts(input({ activities: hardToday(), trainingLoad: load(-3) }), 8);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });
});

describe("suggestions are distinct from one another", () => {
  /** A threshold session: kilometre repeats. */
  function thresholdTemplate(): QualityProfile {
    return {
      activityId: "t1",
      date: day(-6),
      name: "Race Pace K's",
      workoutKey: "race pace k s",
      movingTime: 3600,
      elapsedTime: 3700,
      distance: 14000,
      avgHr: 168,
      maxHr: 182,
      hrSeconds: null,
      hrCoverage: null,
      decoupling: null,
      decouplingEligible: false,
      streamStatus: "ok",
      lapStatus: "ok",
      structure: {
        kind: "intervals",
        workSeconds: 1060,
        recoverySeconds: 270,
        sets: [
          {
            label: "4 x 1000 m",
            targetMeters: 1000,
            fadePct: 3,
            hrDriftBpm: -4,
            reps: Array.from({ length: 4 }, (_, i) => ({
              index: i + 1,
              seconds: 265,
              meters: 1000,
              paceSecPerKm: 264,
              avgHr: 174,
              recoverySeconds: 90,
            })),
          },
        ],
      },
    };
  }

  it("does not dress a threshold session up as top-end work", () => {
    // Found on real data: both rules drew on the same kilometre-repeat template
    // and produced the identical "4 x 1000 m" under two different headings.
    // Kilometre repeats at threshold pace are not VO2 work whatever the card
    // above them says.
    const out = suggestWorkouts(
      input({
        profiles: [thresholdTemplate()],
        zoneSeconds: [0, 0, 0, 900, 0],
        trainingLoad: load(10),
      }),
      8,
    );
    const vo2 = out.find((s) => s.id === "vo2");
    const intervals = out.find((s) => s.id === "intervals");
    expect(vo2).toBeDefined();
    expect(intervals).toBeDefined();
    expect(vo2!.session!.name).not.toBe(intervals!.session!.name);
    // Top-end work is prescribed by time when there is no short-rep history.
    expect(vo2!.session!.name).toBe("5 x 3 min hard");
  });

  it("uses a short-rep session from the athlete's own history for top-end work", () => {
    const shortReps = { ...thresholdTemplate(), date: day(-5), name: "Rolling 400s" };
    shortReps.structure = {
      kind: "intervals",
      workSeconds: 700,
      recoverySeconds: 600,
      sets: [
        {
          label: "8 x 400 m",
          targetMeters: 400,
          fadePct: 1,
          hrDriftBpm: 6,
          reps: Array.from({ length: 8 }, (_, i) => ({
            index: i + 1,
            seconds: 88,
            meters: 400,
            paceSecPerKm: 220,
            avgHr: 180,
            recoverySeconds: 75,
          })),
        },
      ],
    };
    const vo2 = suggestWorkouts(
      input({
        profiles: [thresholdTemplate(), shortReps],
        zoneSeconds: [0, 0, 0, 900, 0],
        trainingLoad: load(10),
      }),
      8,
    ).find((s) => s.id === "vo2");
    expect(vo2!.session!.name).toBe("8 x 400 m");
  });

  it("never offers the same generated session twice", () => {
    const out = suggestWorkouts(
      input({
        profiles: [thresholdTemplate()],
        zoneSeconds: [0, 0, 0, 900, 0],
        trainingLoad: load(10),
      }),
      8,
    );
    const names = out.filter((s) => s.session).map((s) => `${s.session!.discipline}:${s.session!.name}`);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the list always has a lead", () => {
  it("names one thing to do rather than five equal options", () => {
    // Absolute score bands produced lists where nothing was recommended at all,
    // because three roughly-equal opportunities all landed just under the bar.
    // An athlete opening this wants an answer.
    const acts = [...baseHistory(), act(day(-14), "Ride", 40, 80)];
    const out = suggestWorkouts(input({ activities: acts, trainingLoad: load(5) }), 8);
    expect(out.filter((s) => s.priority === "do-this")).toHaveLength(1);
    expect(out[0].priority).toBe("do-this");
  });

  it("lets a constraint hold the lead, leaving the rest as alternatives", () => {
    const acts = [...baseHistory(), act(day(-1), "Run", 14, 75, { suffer_score: 250 })];
    const out = suggestWorkouts(input({ activities: acts, trainingLoad: load(0) }), 8);
    expect(out[0].constraint).toBe("recent-hard");
    expect(out.filter((s) => s.priority === "do-this")).toHaveLength(1);
  });
});
