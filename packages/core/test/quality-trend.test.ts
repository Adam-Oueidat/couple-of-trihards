import { describe, expect, it } from "vitest";
import {
  buildEfficiencyTrend,
  paceAtHrBand,
  resolveZoneModel,
  summaryZones,
  type StravaActivity,
} from "../src";

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
const MODEL = resolveZoneModel(ZONES, 200);

let nextId = 1;

/** A run described by what it costs: distance, duration, heart rate. */
function run(
  date: string,
  km: number,
  minutes: number,
  avgHr: number,
  extra: Partial<StravaActivity> = {},
): StravaActivity {
  return {
    id: nextId++,
    name: `Run ${date}`,
    sport_type: "Run",
    type: "Run",
    start_date: `${date}T08:00:00Z`,
    start_date_local: `${date}T08:00:00Z`,
    distance: km * 1000,
    moving_time: minutes * 60,
    average_heartrate: avgHr,
    max_heartrate: avgHr + 20,
    manual: false,
    ...extra,
  } as unknown as StravaActivity;
}

function weekly(start: string, count: number, fn: (i: number) => StravaActivity[]) {
  const out: StravaActivity[] = [];
  for (let i = 0; i < count; i++) out.push(...fn(i));
  return out;
}

function day(base: string, offset: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().split("T")[0];
}

describe("buildEfficiencyTrend", () => {
  it("excludes hard sessions, so the series tracks fitness not session choice", () => {
    // A race has a high efficiency factor for reasons that have nothing to do
    // with aerobic fitness. Letting it in makes the trend follow what the
    // athlete chose to do that week.
    const acts = [
      run("2026-03-02", 10, 55, 150),
      run("2026-03-09", 10, 55, 150),
      // Race: Z4 average heart rate, much faster.
      run("2026-03-16", 21.1, 90, 185),
    ];
    const trend = buildEfficiencyTrend(acts, MODEL, "2026-01-01", "2026-09-21");
    expect(trend.points).toHaveLength(2);
    expect(trend.points.every((p) => p.avgHr < 165)).toBe(true);
  });

  it("excludes runs too short for their averages to mean anything", () => {
    const acts = [
      run("2026-03-02", 2, 12, 150), // 12 min, 2 km
      run("2026-03-09", 10, 55, 150),
    ];
    expect(buildEfficiencyTrend(acts, MODEL, "2026-01-01", "2026-09-21").points).toHaveLength(1);
  });

  it("excludes manually entered activities", () => {
    const acts = [
      run("2026-03-02", 10, 55, 150, { manual: true }),
      run("2026-03-09", 10, 55, 150),
    ];
    expect(buildEfficiencyTrend(acts, MODEL, "2026-01-01", "2026-09-21").points).toHaveLength(1);
  });

  it("compares thirds, so one freak session is not the whole trend", () => {
    // Nine steady runs, then one absurd outlier at the end. First-vs-last would
    // report a huge gain from a single data point; thirds absorb it.
    const acts = weekly("2026-01-05", 9, (i) => [run(day("2026-01-05", i * 7), 10, 55, 150)]);
    acts.push(run(day("2026-01-05", 9 * 7), 10, 40, 150)); // implausibly fast

    const trend = buildEfficiencyTrend(acts, MODEL, "2026-01-01", "2026-09-21");
    expect(trend.eligible).toBe(true);
    // Last third is three points, only one of which is the outlier.
    expect(trend.changePct).toBeLessThan(20);
  });

  it("reports a real improvement at the same heart rate", () => {
    // Twelve weeks, pace improving from 5:30 to 5:00/km at a constant 150 bpm.
    const acts = weekly("2026-01-05", 12, (i) => [
      run(day("2026-01-05", i * 7), 10, 55 - i * 0.5, 150),
    ]);
    const trend = buildEfficiencyTrend(acts, MODEL, "2026-01-01", "2026-09-21");
    expect(trend.eligible).toBe(true);
    expect(trend.changePct).toBeGreaterThan(5);
    expect(trend.late).toBeGreaterThan(trend.early);
  });

  it("is not eligible below eight points", () => {
    const acts = weekly("2026-01-05", 7, (i) => [run(day("2026-01-05", i * 7), 10, 55, 150)]);
    expect(buildEfficiencyTrend(acts, MODEL, "2026-01-01", "2026-09-21").eligible).toBe(false);
  });

  it("is not eligible when the points are crammed into too few weeks", () => {
    // Ten runs, all in one week — plenty of points, no trend.
    const acts = weekly("2026-01-05", 10, (i) => [run(day("2026-01-05", i % 5), 10, 55, 150)]);
    expect(buildEfficiencyTrend(acts, MODEL, "2026-01-01", "2026-09-21").eligible).toBe(false);
  });
});

describe("paceAtHrBand", () => {
  it("picks the band from the athlete's own median rather than a fixed one", () => {
    // A hard-coded 148-158 is one athlete's band; someone whose easy runs sit
    // at 128 would get an empty chart.
    const acts = weekly("2026-01-05", 10, (i) => [
      run(day("2026-01-05", i * 7), 10, 55, 128),
    ]);
    const band = paceAtHrBand(acts, MODEL, "2026-01-01", "2026-09-21")!;
    expect(band.lowBpm).toBe(123);
    expect(band.highBpm).toBe(133);
  });

  it("measures a pace improvement held at the same effort", () => {
    // Ten runs at 150 bpm: first five at 6:00/km, last five at 5:40/km.
    const acts = [
      ...weekly("2026-01-05", 5, (i) => [run(day("2026-01-05", i * 7), 10, 60, 150)]),
      ...weekly("2026-03-05", 5, (i) => [run(day("2026-03-05", i * 7), 10, 56.667, 150)]),
    ];
    const band = paceAtHrBand(acts, MODEL, "2026-01-01", "2026-09-21")!;
    expect(band.eligible).toBe(true);
    expect(band.earlyPaceSecPerKm).toBe(360);
    expect(band.latePaceSecPerKm).toBe(340);
    expect(band.deltaSecPerKm).toBe(-20);
  });

  it("is not eligible below six points in the band", () => {
    const acts = weekly("2026-01-05", 4, (i) => [run(day("2026-01-05", i * 7), 10, 55, 150)]);
    expect(paceAtHrBand(acts, MODEL, "2026-01-01", "2026-09-21")!.eligible).toBe(false);
  });

  it("is null when there are no aerobic runs at all", () => {
    expect(paceAtHrBand([], MODEL, "2026-01-01", "2026-09-21")).toBeNull();
  });
});

describe("summaryZones", () => {
  it("counts sessions by average and by peak, never seconds", () => {
    const acts = [
      run("2026-09-01", 10, 55, 150),  // avg Z2, peak 170 -> Z3
      run("2026-09-02", 10, 50, 170),  // avg Z3, peak 190 -> Z4
      run("2026-09-03", 10, 45, 185),  // avg Z4, peak 205 -> Z5
    ];
    const s = summaryZones(acts, MODEL, "2026-08-01", "2026-09-21");
    expect(s.sessions).toBe(3);
    expect(s.sessionAverage).toEqual([0, 1, 1, 1, 0]);
    expect(s.peakReached).toEqual([0, 0, 1, 1, 1]);
  });

  it("counts nothing without a zone model", () => {
    const s = summaryZones([run("2026-09-01", 10, 55, 150)], resolveZoneModel(null, null), "2026-08-01", "2026-09-21");
    expect(s.sessions).toBe(0);
  });
});
