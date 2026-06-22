import { describe, expect, it } from "vitest";
import { calcTrainingLoad, type StravaActivity } from "../src";

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
