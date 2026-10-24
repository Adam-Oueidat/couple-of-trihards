import { describe, expect, it } from "vitest";
import {
  activityMetrics,
  describeActivityMetrics,
  normalizedPower,
  peakAverage,
  resampleToSeconds,
  rideMetrics,
  rideSplitMeters,
  rideSplits,
  runMetrics,
  STREAM_KEYS,
  type DetailedActivity,
  type StreamSet,
} from "../src";

function activity(over: Partial<DetailedActivity>): DetailedActivity {
  return {
    id: 1,
    name: "Test",
    sport_type: "Ride",
    type: "Ride",
    start_date: "2026-10-20T08:00:00Z",
    start_date_local: "2026-10-20T10:00:00",
    distance: 40000,
    moving_time: 3600,
    elapsed_time: 3700,
    total_elevation_gain: 200,
    average_speed: 40000 / 3600,
    max_speed: 15,
    trainer: false,
    manual: false,
    ...over,
  };
}

/** One sample per second for `seconds`, valued by `f`. */
function stream(seconds: number, f: (i: number) => number): number[] {
  return Array.from({ length: seconds }, (_, i) => f(i));
}

describe("stream maths", () => {
  it("holds each sample until the next and drops long stops", () => {
    // 0→2s at 100, 2→3s at 200, then a 60s stop, then 1s at 300.
    expect(resampleToSeconds([0, 2, 3, 63, 64], [100, 200, 0, 300, 300])).toEqual([
      100, 100, 200, 300,
    ]);
  });

  it("finds the best rolling average", () => {
    expect(peakAverage([1, 1, 5, 5, 1], 2)).toBe(5);
    expect(peakAverage([1, 2], 5)).toBeNull();
  });

  it("makes a steady effort's NP its average and a surgy one's higher", () => {
    expect(normalizedPower(stream(600, () => 200))).toBeCloseTo(200, 5);
    // Alternating 2 minutes at 100W and 300W averages 200W but costs more.
    const surgy = stream(1200, (i) => (Math.floor(i / 120) % 2 === 0 ? 100 : 300));
    expect(normalizedPower(surgy)!).toBeGreaterThan(220);
  });

  it("requests cadence and power for every activity", () => {
    expect(STREAM_KEYS).toContain("cadence");
    expect(STREAM_KEYS).toContain("watts");
  });
});

describe("ride metrics", () => {
  const time = stream(3601, (i) => i);
  const streams: StreamSet = {
    time: { data: time },
    watts: { data: time.map(() => 200) },
    // Coasting one second in ten.
    cadence: { data: time.map((i) => (i % 10 === 0 ? 0 : 90)) },
    heartrate: { data: time.map(() => 140) },
  };

  it("reads power, load and cadence from the streams", () => {
    const m = rideMetrics(activity({}), streams, { ftp: 250, weight: 70 });
    expect(m.avgPower).toBe(200);
    expect(m.normalizedPower).toBe(200);
    expect(m.intensityFactor).toBe(0.8);
    // An hour at IF 0.8 is 64 TSS.
    expect(m.tss).toBe(64);
    expect(m.workKj).toBe(720);
    expect(m.wattsPerKg).toBe(2.86);
    expect(m.avgCadence).toBe(90);
    expect(m.coastingPct).toBe(10);
    expect(m.peakPower.map((p) => p.label)).toEqual(["5s", "1min", "5min", "20min", "60min"]);
    // 200W against a 250W FTP is 80%: tempo.
    expect(m.powerZones?.find((z) => z.seconds > 0)?.name).toBe("Tempo");
    expect(m.decouplingPct).toBe(0);
  });

  it("needs FTP for intensity, TSS and zones", () => {
    const m = rideMetrics(activity({}), streams);
    expect(m.normalizedPower).toBe(200);
    expect(m.intensityFactor).toBeNull();
    expect(m.tss).toBeNull();
    expect(m.powerZones).toBeNull();
  });

  it("falls back to Strava's summary fields without streams", () => {
    const m = rideMetrics(
      activity({
        average_watts: 180,
        weighted_average_watts: 195,
        max_watts: 650,
        kilojoules: 640,
        average_cadence: 86,
        device_watts: false,
      }),
      null,
      { ftp: 260 },
    );
    expect(m.avgPower).toBe(180);
    expect(m.normalizedPower).toBe(195);
    expect(m.maxPower).toBe(650);
    expect(m.avgCadence).toBe(86);
    expect(m.intensityFactor).toBe(0.75);
    expect(m.powerSource).toBe("estimated");
    expect(m.peakPower).toEqual([]);
  });

  it("does not quote drift for a surgy ride", () => {
    const surgy: StreamSet = {
      ...streams,
      watts: { data: time.map((i) => (Math.floor(i / 60) % 2 === 0 ? 80 : 350)) },
    };
    expect(rideMetrics(activity({}), surgy).decouplingPct).toBeNull();
  });
});

describe("run metrics", () => {
  const run = activity({
    sport_type: "Run",
    type: "Run",
    distance: 10000,
    moving_time: 3000,
    total_elevation_gain: 120,
    average_cadence: 84,
    splits_metric: [
      { split: 1, distance: 1000, moving_time: 300, elapsed_time: 300, average_speed: 3.2, average_grade_adjusted_speed: 3.4, elevation_difference: 10 },
      { split: 2, distance: 1000, moving_time: 300, elapsed_time: 300, average_speed: 3.4, average_grade_adjusted_speed: 3.4, elevation_difference: 0 },
    ],
  });

  it("doubles Strava's per-leg cadence into steps per minute", () => {
    expect(runMetrics(run, null).avgCadence).toBe(168);
    const time = stream(1200, (i) => i);
    const streams: StreamSet = { time: { data: time }, cadence: { data: time.map(() => 88) } };
    expect(runMetrics(run, streams).avgCadence).toBe(176);
  });

  it("reads grade-adjusted pace from the splits and climbing per km", () => {
    const m = runMetrics(run, null);
    expect(m.gradeAdjustedSpeed).toBe(3.4);
    expect(m.climbPerKm).toBe(12);
    expect(m.avgPower).toBeNull();
  });

  it("is chosen by sport, and none for a swim", () => {
    expect(activityMetrics(run, null)?.kind).toBe("run");
    expect(activityMetrics(activity({}), null)?.kind).toBe("ride");
    expect(activityMetrics(activity({ sport_type: "Swim", type: "Swim" }), null)).toBeNull();
  });

  it("describes itself for the coach", () => {
    const text = describeActivityMetrics(runMetrics(run, null));
    expect(text).toContain("Cadence: 168 spm");
    expect(text).toContain("Grade-adjusted pace: 4:54/km");
  });
});

describe("ride splits", () => {
  // 90 km at 10 m/s, one sample a second, 200W, a 2 m climb every km.
  const seconds = 9000;
  const time = stream(seconds + 1, (i) => i);
  const streams: StreamSet = {
    time: { data: time },
    distance: { data: time.map((t) => t * 10) },
    watts: { data: time.map(() => 200) },
    heartrate: { data: time.map(() => 140) },
    cadence: { data: time.map(() => 90) },
    altitude: { data: time.map((t) => t / 50) },
  };
  const ride = activity({ distance: 90000, moving_time: seconds });

  it("cuts a 90 km ride into 5 km chunks, not 90 rows", () => {
    const splits = rideSplits(ride, streams);
    expect(splits).toHaveLength(18);
    expect(splits[0]).toEqual({
      fromKm: 0,
      toKm: 5,
      movingTime: 500,
      speed: 10,
      heartrate: 140,
      watts: 200,
      cadence: 90,
      elevationDiff: 10,
    });
  });

  it("steps up to 10 km past 100 km", () => {
    expect(rideSplitMeters(90_000)).toBe(5_000);
    expect(rideSplitMeters(160_000)).toBe(10_000);
  });

  it("folds a short final stub into the chunk before it", () => {
    // 20.5 km: four full chunks and a 0.5 km stub, which joins the fourth.
    const short: StreamSet = { ...streams, distance: { data: time.map((t) => Math.min(t * 10, 20500)) } };
    const splits = rideSplits(activity({ distance: 20500 }), short);
    expect(splits).toHaveLength(4);
    expect(splits[3]).toMatchObject({ fromKm: 15, toKm: 20.5 });
  });

  it("groups Strava's km splits when there are no streams", () => {
    const km = Array.from({ length: 12 }, (_, i) => ({
      split: i + 1,
      distance: 1000,
      moving_time: 120,
      elapsed_time: 120,
      average_speed: 1000 / 120,
      average_heartrate: 130,
      elevation_difference: 1,
    }));
    const splits = rideSplits(activity({ distance: 12000, splits_metric: km }), null);
    // 5 + 5 + 2: the 2 km stub is not under a fifth of 5 km, so it stays.
    expect(splits.map((s) => [s.fromKm, s.toKm])).toEqual([[0, 5], [5, 10], [10, 12]]);
    expect(splits[0]).toMatchObject({ movingTime: 600, heartrate: 130, watts: null, elevationDiff: 5 });
  });
});
