import { describe, expect, it } from "vitest";
import { calcTrainingLoad, getWeekStart, type StravaActivity } from "../src";

function activity(day: string, sufferScore: number): StravaActivity {
  return {
    sport_type: "Run",
    type: "Run",
    start_date_local: `${day}T08:00:00Z`,
    moving_time: 3600,
    distance: 10000,
    suffer_score: sufferScore,
  } as unknown as StravaActivity;
}

describe("calcTrainingLoad", () => {
  it("extends the series through `today` so Form decays past the last activity", () => {
    const points = calcTrainingLoad(
      [activity("2026-01-01", 100)],
      "2026-01-10",
    );

    // One point per day from the activity through today (inclusive).
    expect(points).toHaveLength(10);
    expect(points[0].date).toBe("2026-01-01");
    expect(points[points.length - 1].date).toBe("2026-01-10");

    // Rest days carry 0 TSS, so fatigue (ATL) decays faster than fitness (CTL)
    // and Form (TSB = CTL - ATL) climbs after the last activity.
    const lastActivityDay = points[0];
    const today = points[points.length - 1];
    expect(today.atl).toBeLessThan(lastActivityDay.atl);
    expect(today.tsb).toBeGreaterThan(lastActivityDay.tsb);
  });

  it("still ends at the last activity when today is earlier", () => {
    const points = calcTrainingLoad(
      [activity("2026-01-01", 100), activity("2026-01-05", 100)],
      "2026-01-03",
    );
    expect(points[points.length - 1].date).toBe("2026-01-05");
  });

  it("returns nothing without activities", () => {
    expect(calcTrainingLoad([], "2026-01-10")).toEqual([]);
  });
});

describe("getWeekStart", () => {
  // Jun 15 2026 is a Monday; Jun 14 is the Sunday before it.
  it("returns the local Monday for a midweek date", () => {
    // A Wednesday afternoon. Must bucket into the Mon Jun 15 week, never Jun 14
    // (the old UTC-formatting bug rolled back a day in positive-offset zones).
    expect(getWeekStart(new Date("2026-06-17T14:00:00"))).toBe("2026-06-15");
  });

  it("maps Sunday to the same week's Monday (six days earlier)", () => {
    expect(getWeekStart(new Date("2026-06-21T10:00:00"))).toBe("2026-06-15");
  });

  it("keeps a Monday on itself", () => {
    expect(getWeekStart(new Date("2026-06-15T09:00:00"))).toBe("2026-06-15");
  });
});
