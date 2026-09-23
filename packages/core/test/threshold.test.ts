import { describe, expect, it } from "vitest";
import {
  buildTrainingPlan,
  estimateRunThreshold,
  resolveZoneModel,
  suggestWorkouts,
  thresholdPaceFrom,
  type QualityProfile,
  type StravaActivity,
  type ThresholdInput,
  type TrainingPlan,
} from "../src";

const TODAY = "2026-09-23";

// Z4 starts at 182 bpm, as in the athlete's real Strava zones.
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

function run(date: string, km: number, seconds: number, over: Partial<StravaActivity> = {}): StravaActivity {
  return {
    id: nextId++,
    name: `Run ${date}`,
    sport_type: "Run",
    type: "Run",
    start_date: `${date}T08:00:00Z`,
    start_date_local: `${date}T08:00:00Z`,
    distance: km * 1000,
    moving_time: seconds,
    elapsed_time: seconds,
    average_heartrate: 150,
    manual: false,
    ...over,
  } as unknown as StravaActivity;
}

function raceOn(date: string, name = "Copenhagen Half Marathon"): TrainingPlan {
  return buildTrainingPlan({
    name: "Block",
    source: "runna",
    discipline: "run",
    startDate: day(-120),
    raceDate: date,
    raceName: name,
    sessions: [{ date, name, type: "race", km: 21.1 }],
  });
}

function input(over: Partial<ThresholdInput>): ThresholdInput {
  return { plan: null, activities: [], zones: ZONES, today: TODAY, ...over };
}

/** The real Copenhagen result: 21.39 km by watch in 1:37:52 moving. */
const HALF = { km: 21.39, sec: 5872 };

describe("race equivalence", () => {
  it("returns an hour-long effort's own pace", () => {
    expect(thresholdPaceFrom(15000, 3600)).toBe(240);
  });

  it("puts threshold a little faster than half-marathon pace", () => {
    // 4:35/km for 98 minutes is about 4:27/km for an hour.
    expect(thresholdPaceFrom(HALF.km * 1000, HALF.sec)).toBe(267);
  });

  it("puts threshold a little slower than 5K pace", () => {
    const fiveK = 5000 / 1200; // 4:00/km for 20 minutes
    expect(thresholdPaceFrom(5000, 1200)).toBeGreaterThan(1000 / fiveK);
  });
});

describe("where the threshold comes from", () => {
  it("sets it from the most recent race on the plan", () => {
    const half = run(day(-3), HALF.km, HALF.sec, { name: "Copenhagen Half Marathon", average_heartrate: 185 });
    const t = estimateRunThreshold(input({ plan: raceOn(day(-3)), activities: [half] }));
    expect(t).toMatchObject({
      secPerKm: 267,
      source: "race",
      activityName: "Copenhagen Half Marathon",
      date: day(-3),
    });
  });

  it("counts a run Strava has tagged as a race, with no plan", () => {
    const tagged = run(day(-10), 10, 2700, { workout_type: 1, name: "Parkrun x2" });
    expect(estimateRunThreshold(input({ activities: [tagged] }))?.source).toBe("race");
  });

  it("takes the race itself, not the warm-up jog on race day", () => {
    const warmup = run(day(-3), 2, 720, { name: "Warm-up" });
    const half = run(day(-3), HALF.km, HALF.sec, { name: "Copenhagen Half Marathon" });
    const t = estimateRunThreshold(input({ plan: raceOn(day(-3)), activities: [warmup, half] }));
    expect(t?.activityName).toBe("Copenhagen Half Marathon");
  });

  it("ignores races too long to say anything about an hour", () => {
    const marathon = run(day(-5), 42.2, 3.5 * 3600, { workout_type: 1 });
    expect(estimateRunThreshold(input({ activities: [marathon] }))).toBeNull();
  });

  it("forgets a race older than twelve weeks", () => {
    const old = run(day(-90), HALF.km, HALF.sec, { workout_type: 1 });
    expect(estimateRunThreshold(input({ activities: [old] }))).toBeNull();
  });

  it("is null rather than a guess with no evidence at all", () => {
    const easy = run(day(-2), 10, 3600);
    expect(estimateRunThreshold(input({ activities: [easy] }))).toBeNull();
  });
});

describe("steady efforts at threshold heart rate", () => {
  const half = () => run(day(-20), HALF.km, HALF.sec, { workout_type: 1, name: "Half" });

  it("raises the threshold when a newer one is faster", () => {
    // 40 minutes at 4:10/km with HR above the Z4 floor.
    const tempo = run(day(-5), 9.6, 2400, { average_heartrate: 184, name: "Tempo 40'" });
    const t = estimateRunThreshold(input({ activities: [half(), tempo] }));
    expect(t?.source).toBe("steady-effort");
    expect(t?.activityName).toBe("Tempo 40'");
    expect(t!.secPerKm).toBeLessThan(267);
  });

  it("never lowers it when a newer one is slower", () => {
    // A hot day: threshold heart rate at a slower pace is not lost fitness.
    const hot = run(day(-5), 8, 2700, { average_heartrate: 186 });
    expect(estimateRunThreshold(input({ activities: [half(), hot] }))?.source).toBe("race");
  });

  it("does not let an older effort override a newer race", () => {
    const earlier = run(day(-30), 9.6, 2400, { average_heartrate: 184 });
    expect(estimateRunThreshold(input({ activities: [half(), earlier] }))?.source).toBe("race");
  });

  it("does not count a run below threshold heart rate", () => {
    const tempo = run(day(-5), 9.6, 2400, { average_heartrate: 176 });
    expect(estimateRunThreshold(input({ activities: [tempo] }))).toBeNull();
  });

  it("does not count an interval session, whose average mixes reps and jogs", () => {
    const reps = run(day(-5), 9.6, 2400, { average_heartrate: 184 });
    const profile = {
      activityId: String(reps.id),
      date: day(-5),
      structure: { kind: "intervals", sets: [] },
    } as unknown as QualityProfile;
    expect(estimateRunThreshold(input({ activities: [reps], profiles: [profile] }))).toBeNull();
  });

  it("needs real zones to judge heart rate at all", () => {
    const tempo = run(day(-5), 9.6, 2400, { average_heartrate: 184 });
    const noZones = resolveZoneModel(null, null);
    expect(estimateRunThreshold(input({ activities: [tempo], zones: noZones }))).toBeNull();
  });
});

describe("on the workout chart", () => {
  function sessions(activities: StravaActivity[]) {
    return suggestWorkouts(
      {
        activities,
        trainingLoad: [{ date: TODAY, ctl: 60, atl: 60, tsb: 0, dailyTSS: 0 }],
        plan: null,
        zones: ZONES,
        today: TODAY,
      },
      8,
    ).flatMap((s) => (s.session ? [s.session] : []));
  }

  it("anchors runs to the threshold pace and names its source", () => {
    const history = [run(day(-10), HALF.km, HALF.sec, { workout_type: 1, name: "Copenhagen Half Marathon" })];
    const runs = sessions(history).filter((s) => s.discipline === "run");
    expect(runs.length).toBeGreaterThan(0);
    for (const s of runs) {
      expect(s.threshold).toEqual({
        kind: "pace",
        secPerKm: 267,
        from: `Copenhagen Half Marathon, ${day(-10)}`,
      });
    }
  });

  it("leaves runs on effort when there is no evidence", () => {
    const runs = sessions([run(day(-2), 10, 3600)]).filter((s) => s.discipline === "run");
    for (const s of runs) expect(s.threshold).toEqual({ kind: "effort" });
  });
});
