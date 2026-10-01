import { describe, expect, it } from "vitest";
import {
  buildBlockAnalysis,
  calcTrainingLoad,
  formatBlockAnalysis,
  resolveBlockWindows,
  resolveZoneModel,
  HR_HIST_MIN,
  HR_HIST_LEN,
  type QualityProfile,
  type StravaActivity,
} from "../src";

const TODAY = "2026-09-27";

const MODEL = resolveZoneModel(
  {
    heart_rate: {
      custom_zones: true,
      zones: [
        { min: 0, max: 130 },
        { min: 130, max: 160 },
        { min: 160, max: 175 },
        { min: 175, max: 190 },
        { min: 190, max: -1 },
      ],
    },
  } as never,
  195,
);

let nextId = 1;

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

function activity(
  date: string,
  over: Partial<StravaActivity> & { paceSec?: number; km?: number; time?: string } = {},
): StravaActivity {
  const km = over.km ?? 10;
  const moving = over.moving_time ?? Math.round((over.paceSec ?? 330) * km);
  const time = over.time ?? "08:00:00";
  return {
    id: nextId++,
    name: `Run ${date}`,
    sport_type: "Run",
    type: "Run",
    start_date: `${date}T${time}Z`,
    start_date_local: `${date}T${time}Z`,
    distance: km * 1000,
    moving_time: moving,
    elapsed_time: moving,
    total_elevation_gain: 50,
    average_speed: (km * 1000) / moving,
    max_speed: 4,
    average_heartrate: 145,
    trainer: false,
    manual: false,
    ...over,
  } as StravaActivity;
}

/** Six weeks of easy runs, three a week, at a given pace and heart rate. */
function block(endDate: string, paceSec: number, hr: number): StravaActivity[] {
  const out: StravaActivity[] = [];
  for (let d = 0; d < 42; d += 2) {
    if (out.length >= 18) break;
    out.push(activity(shift(endDate, -d), { paceSec, average_heartrate: hr }));
  }
  return out;
}

const windows = resolveBlockWindows({ weeks: 6, count: 2 }, TODAY, "2025-10-01");

function analyse(activities: StravaActivity[], profiles: QualityProfile[] = [], notes = []) {
  return buildBlockAnalysis({
    activities,
    model: MODEL,
    profiles,
    load: calcTrainingLoad(activities, TODAY),
    blocks: windows,
    notes,
  });
}

describe("resolveBlockWindows", () => {
  it("builds back-to-back blocks ending today, oldest first", () => {
    const w = resolveBlockWindows({ weeks: 6, count: 3 }, TODAY, "2025-10-01");
    expect(w).toHaveLength(3);
    expect(w[2]).toEqual({ from: shift(TODAY, -41), to: TODAY });
    expect(w[1].to).toBe(shift(w[2].from, -1));
    expect(w[0].to).toBe(shift(w[1].from, -1));
  });

  it("clips explicit blocks to the available history and today", () => {
    const w = resolveBlockWindows(
      { blocks: [{ from: "2025-01-01", to: "2025-12-31" }, { from: "2026-09-01", to: "2027-01-01" }] },
      TODAY,
      "2025-10-01",
    );
    expect(w[0]).toEqual({ from: "2025-10-01", to: "2025-12-31" });
    expect(w[1].to).toBe(TODAY);
  });

  it("rejects overlapping and malformed blocks", () => {
    expect(() =>
      resolveBlockWindows(
        { blocks: [{ from: "2026-07-01", to: "2026-08-15" }, { from: "2026-08-01", to: "2026-09-01" }] },
        TODAY,
        "2025-10-01",
      ),
    ).toThrow(/overlap/);
    expect(() => resolveBlockWindows({ blocks: [{ from: "July", to: "2026-08-01" }] }, TODAY, "2025-10-01")).toThrow();
  });
});

describe("buildBlockAnalysis", () => {
  it("calls it worse when pace slows at the same heart rate", () => {
    const acts = [...block(shift(windows[0].to, 0), 330, 145), ...block(TODAY, 345, 145)];
    const a = analyse(acts);
    const c = a.comparisons[0];
    expect(c.verdict).toBe("worse");
    expect(c.paceChangeSec).toBe(15);
    expect(c.hrChange).toBe(0);
    expect(c.bandPaceChangeSec).toBe(15);
  });

  it("calls a slower pace at a lower heart rate running easier, not lost fitness", () => {
    // Same speed per beat: 330s @ 150 vs 341s @ 145.
    const acts = [...block(windows[0].to, 330, 150), ...block(TODAY, 341, 145)];
    const c = analyse(acts).comparisons[0];
    expect(c.verdict).toBe("easier");
    expect(c.paceChangeSec).toBeGreaterThanOrEqual(5);
  });

  it("uses one heart-rate band for every block", () => {
    const acts = [...block(windows[0].to, 330, 140), ...block(TODAY, 330, 150)];
    const a = analyse(acts);
    expect(a.band).toEqual({ low: 140, high: 150 });
    // Both blocks fall inside the shared band at its edges.
    expect(a.blocks[0].band.n).toBeGreaterThan(0);
    expect(a.blocks[1].band.n).toBeGreaterThan(0);
  });

  it("excludes brick runs from the comparable set and flags them", () => {
    const ride = activity(shift(TODAY, -1), {
      sport_type: "Ride",
      type: "Ride",
      km: 40,
      moving_time: 5400,
      elapsed_time: 5400,
      time: "07:00:00",
      average_heartrate: 135,
    } as never);
    const brick = activity(shift(TODAY, -1), { paceSec: 400, time: "08:40:00", average_heartrate: 145 });
    const acts = [...block(windows[0].to, 330, 145), ...block(TODAY, 330, 145), ride, brick];
    const a = analyse(acts);
    expect(a.blocks[1].easy.bricks).toBe(1);
    expect(a.blocks[1].easy.medianPaceSec).toBe(330);
    expect(a.recent.find((r) => r.id === brick.id)?.brick).toBe(true);
  });

  it("surfaces measured causes: more hard running, hillier runs, athlete notes", () => {
    const later = block(TODAY, 345, 145).map((r) => ({ ...r, total_elevation_gain: 150 }));
    const hard = [0, 7, 14, 21, 28, 35].map((d) =>
      activity(shift(TODAY, -d - 1), { paceSec: 270, average_heartrate: 170 }),
    );
    const a = analyse([...block(windows[0].to, 330, 145), ...later, ...hard], [], [
      { date: shift(TODAY, -3), text: "calf niggle" },
    ] as never);
    const text = a.comparisons[0].signals.join("\n");
    expect(text).toMatch(/More hard running/);
    expect(text).toMatch(/Hillier easy runs/);
    expect(text).toMatch(/calf niggle/);
    expect(text).toMatch(/tired legs/);
  });

  it("flags fitness (CTL) falling inside the latest block", () => {
    // Heavy daily training until the latest block starts, then three easy runs a week.
    const heavy = Array.from({ length: 120 }, (_, d) =>
      activity(shift(windows[1].from, -d - 1), { km: 15, paceSec: 330, average_heartrate: 145 }),
    );
    const text = analyse([...heavy, ...block(TODAY, 330, 145)]).comparisons[0].signals.join("\n");
    expect(text).toMatch(/Fitness \(CTL\) fell/);
  });

  it("reads time above Z2 from stored histograms", () => {
    const later = block(TODAY, 330, 150);
    const hist = new Array(HR_HIST_LEN).fill(0);
    hist[165 - HR_HIST_MIN] = 1200;
    hist[150 - HR_HIST_MIN] = 2100;
    const profiles = later.map((r) => ({
      activityId: String(r.id),
      hrSeconds: hist,
      hrCoverage: 1,
      decoupling: 6,
      decouplingEligible: true,
    })) as unknown as QualityProfile[];
    const a = analyse([...block(windows[0].to, 330, 150), ...later], profiles);
    expect(a.blocks[1].easyAboveZ2Pct).toBe(36);
    expect(a.blocks[1].decoupling.medianPct).toBe(6);
    expect(a.comparisons[0].signals.join("\n")).toMatch(/Easy runs not fully easy/);
  });

  it("says when there is not enough data instead of guessing", () => {
    const acts = [...block(windows[0].to, 330, 145).slice(0, 2), ...block(TODAY, 345, 145)];
    expect(analyse(acts).comparisons[0].verdict).toBe("insufficient");
  });

  it("refuses to analyse without any zone model", () => {
    const a = buildBlockAnalysis({
      activities: block(TODAY, 330, 145),
      model: resolveZoneModel(null, null),
      profiles: [],
      load: [],
      blocks: windows,
    });
    expect(formatBlockAnalysis(a)).toMatch(/heart-rate/);
  });

  it("formats a compact digest", () => {
    const acts = [...block(windows[0].to, 330, 145), ...block(TODAY, 345, 145)];
    const text = formatBlockAnalysis(analyse(acts));
    expect(text).toMatch(/Verdict: WORSE/);
    expect(text).toMatch(/Latest easy runs/);
    expect(text.split("\n").length).toBeLessThan(40);
  });
});
