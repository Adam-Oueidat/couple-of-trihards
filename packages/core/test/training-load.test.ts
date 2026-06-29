import { describe, expect, it } from "vitest";
import {
  calcTrainingLoad,
  getWeekStart,
  activityDay,
  groupByWeek,
  type StravaActivity,
} from "../src";

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

  it("includes the most recent day even across a spring-forward DST transition", () => {
    // Range spans Europe/Copenhagen's 2026 spring-forward (Mar 29). Walking the
    // days with local setDate/getDate drifts the cursor to 01:00 UTC by summer
    // and drops the final day (its TSS vanishes); the UTC walk must keep it.
    // Regression: the load curve used to silently ignore the latest activity.
    const points = calcTrainingLoad(
      [activity("2025-06-23", 100), activity("2026-06-22", 145)],
      "2026-06-22",
    );
    const last = points[points.length - 1];
    expect(last.date).toBe("2026-06-22");
    expect(last.dailyTSS).toBe(145);
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

describe("activityDay", () => {
  // start_date_local is wall-clock time with a misleading trailing "Z". Reading
  // the date part keeps the athlete's calendar day regardless of the runtime's
  // timezone — `new Date(start_date_local)` would shift an evening activity.
  it("preserves the wall-clock day from a late-evening start_date_local", () => {
    const d = activityDay("2026-06-28T22:00:00Z");
    expect(getWeekStart(d)).toBe("2026-06-22"); // Sunday Jun 28 → week of Jun 22
  });
});

describe("groupByWeek timezone handling", () => {
  // Regression: a Sunday-evening run leaked into the *next* week (Mon Jun 29)
  // because groupByWeek parsed start_date_local as UTC, shifting it to Monday in
  // a positive-offset runtime. It must bucket into the week of Jun 22.
  it("buckets a Sunday-evening run into its own week, not the next one", () => {
    const sundayRun = {
      sport_type: "Run",
      type: "Run",
      start_date_local: "2026-06-28T22:00:00Z",
      moving_time: 3180,
      distance: 8760,
    } as unknown as StravaActivity;

    const weeks = groupByWeek([sundayRun]);
    expect(weeks).toHaveLength(1);
    expect(weeks[0].weekStart).toBe("2026-06-22");
    expect(weeks[0].run).toBeCloseTo(8.76, 2);
  });
});
