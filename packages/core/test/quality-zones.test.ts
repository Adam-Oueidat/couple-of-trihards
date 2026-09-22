import { describe, expect, it } from "vitest";
import {
  bucketHistogram,
  buildHrHistogram,
  hrZone,
  HR_HIST_MIN,
  observedMaxHr,
  resolveZoneModel,
  sumHistograms,
  zonesUnreachable,
  type StravaActivity,
  type StreamSet,
  type ZoneModel,
} from "../src";

/** The real athlete's stored zones — Strava defaults, custom_zones false. */
const REAL_ZONES = {
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
function run(maxHr?: number, avgHr?: number): StravaActivity {
  return {
    id: nextId++,
    name: "Run",
    sport_type: "Run",
    type: "Run",
    start_date: "2026-09-01T08:00:00Z",
    start_date_local: "2026-09-01T08:00:00Z",
    distance: 10000,
    moving_time: 3000,
    max_heartrate: maxHr,
    average_heartrate: avgHr,
  } as unknown as StravaActivity;
}

function stream(hr: number[], time: number[]): StreamSet {
  return { heartrate: { data: hr }, time: { data: time } } as unknown as StreamSet;
}

describe("resolveZoneModel", () => {
  it("uses Strava's zones and records whether they are personalised", () => {
    const custom = resolveZoneModel(
      { ...REAL_ZONES, heart_rate: { ...REAL_ZONES.heart_rate, custom_zones: true } },
      200,
    );
    expect(custom.source).toBe("strava-custom");
    expect(custom.floors).toEqual([0, 133, 165, 182, 198]);

    expect(resolveZoneModel(REAL_ZONES, 200).source).toBe("strava-default");
  });

  it("falls back to a max-HR estimate that reproduces Strava's own split", () => {
    // The fallback has to land where Strava lands, or an athlete whose zones we
    // estimated cannot be compared with one whose zones we fetched.
    const model = resolveZoneModel(null, 220);
    expect(model.source).toBe("estimated-max");
    expect(model.floors[1]).toBeCloseTo(132, -1); // Strava stores 133
    expect(model.floors[2]).toBeCloseTo(165, -1); // 165
    expect(model.floors[3]).toBeCloseTo(183, -1); // 182
    expect(model.floors[4]).toBeCloseTo(198, -1); // 198
  });

  it("has no model at all when there is neither zones nor history", () => {
    expect(resolveZoneModel(null, null).source).toBe("none");
  });
});

describe("observedMaxHr", () => {
  it("takes the second highest, so one spike cannot move every zone floor", () => {
    // A cross-talk spike or a strap dropout reads as one absurd value. Using
    // the maximum would drag every derived floor up ~10% for a whole season.
    const acts = [run(235), run(196), run(191), run(188)];
    expect(observedMaxHr(acts)).toBe(196);
  });

  it("falls back to the only reading when there is just one", () => {
    expect(observedMaxHr([run(190)])).toBe(190);
  });

  it("is null with no heart-rate history", () => {
    expect(observedMaxHr([run()])).toBeNull();
  });
});

describe("zonesUnreachable", () => {
  it("is false for the real athlete, whose Z5 floor is reachable", () => {
    // Regression against a premise I initially got wrong: their Z5 floor is 198
    // and their recorded max is 204, so Z5 IS reachable. They touch it once a
    // year — which is a training-design observation, not a broken zone setting,
    // and must not be reported as a configuration problem.
    const model = resolveZoneModel(REAL_ZONES, 196);
    expect(zonesUnreachable(model, 204)).toBe(false);
  });

  it("is true only when the Z5 floor sits above the all-time max", () => {
    const model = resolveZoneModel(REAL_ZONES, 190);
    expect(zonesUnreachable(model, 190)).toBe(true);
  });

  it("says nothing without a zone model", () => {
    expect(zonesUnreachable(resolveZoneModel(null, null), 200)).toBe(false);
  });
});

describe("hrZone", () => {
  const model: ZoneModel = resolveZoneModel(REAL_ZONES, 200);

  it("puts a heart rate exactly on a floor in the higher zone", () => {
    expect(hrZone(132, model)).toBe(1);
    expect(hrZone(133, model)).toBe(2);
    expect(hrZone(165, model)).toBe(3);
    expect(hrZone(182, model)).toBe(4);
    expect(hrZone(198, model)).toBe(5);
  });

  it("keeps everything above the top floor in Z5", () => {
    expect(hrZone(210, model)).toBe(5);
  });
});

describe("buildHrHistogram", () => {
  it("attributes one second per sample on a uniform 1 Hz trace", () => {
    const hr = new Array(600).fill(150);
    const time = hr.map((_, i) => i);
    const hist = buildHrHistogram(stream(hr, time), { elapsedTime: 600 })!;
    expect(hist.status).toBe("ok");
    expect(hist.seconds[150 - HR_HIST_MIN]).toBe(600);
  });

  it("attributes by the real interval on a non-uniform smart-recording trace", () => {
    const time = [0, 5, 10, 20];
    const hist = buildHrHistogram(stream([140, 140, 140, 140], time), { elapsedTime: 25 })!;
    // 5 + 5 + 10 for the first three, plus the median interval for the last.
    expect(hist.seconds[140 - HR_HIST_MIN]).toBe(25);
  });

  it("caps a paused-watch gap instead of dumping it into one zone", () => {
    // Without the cap this 900-second hole would be credited entirely to the
    // heart rate the athlete happened to have when they hit pause.
    const hist = buildHrHistogram(stream([140, 180], [0, 900]), { elapsedTime: 900 })!;
    expect(hist.seconds[140 - HR_HIST_MIN]).toBe(10);
  });

  it("skips strap dropouts and reports the coverage they cost", () => {
    const hr = [...new Array(300).fill(150), ...new Array(300).fill(0)];
    const time = hr.map((_, i) => i);
    const hist = buildHrHistogram(stream(hr, time), { elapsedTime: 600 })!;
    expect(hist.seconds[150 - HR_HIST_MIN]).toBe(300);
    expect(hist.coverage).toBeCloseTo(0.5, 1);
    expect(hist.status).toBe("partial");
  });

  it("returns null without both heart rate and time", () => {
    expect(buildHrHistogram({} as StreamSet)).toBeNull();
    expect(buildHrHistogram(stream([150], []) )).toBeNull();
  });
});

describe("bucketHistogram", () => {
  const model = resolveZoneModel(REAL_ZONES, 200);

  it("re-buckets a stored histogram under the current zone model", () => {
    const hist = new Array(131).fill(0);
    hist[120 - HR_HIST_MIN] = 100; // Z1
    hist[150 - HR_HIST_MIN] = 200; // Z2
    hist[170 - HR_HIST_MIN] = 50;  // Z3
    const zt = bucketHistogram(hist, model);
    expect(zt.seconds).toEqual([100, 200, 50, 0, 0]);
    expect(zt.total).toBe(350);
    expect(zt.share[1]).toBeCloseTo(200 / 350, 5);
  });

  it("is all zeros with no zone model, rather than inventing a split", () => {
    const hist = new Array(131).fill(0);
    hist[150 - HR_HIST_MIN] = 200;
    expect(bucketHistogram(hist, resolveZoneModel(null, null)).total).toBe(0);
  });
});

describe("sumHistograms", () => {
  it("adds many sessions bucket by bucket", () => {
    const a = new Array(131).fill(0);
    const b = new Array(131).fill(0);
    a[10] = 5;
    b[10] = 7;
    b[20] = 3;
    const sum = sumHistograms([a, b]);
    expect(sum[10]).toBe(12);
    expect(sum[20]).toBe(3);
  });
});
