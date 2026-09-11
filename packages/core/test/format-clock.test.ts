import { describe, expect, it } from "vitest";
import {
  formatSecondsAsClock,
  formatDuration,
  formatPace,
  type StravaActivity,
} from "../src";

function activity(
  sport: string,
  distance: number,
  movingTime: number,
): StravaActivity {
  return {
    sport_type: sport,
    type: sport,
    start_date_local: "2026-09-09T08:00:00Z",
    moving_time: movingTime,
    distance,
  } as unknown as StravaActivity;
}

describe("formatSecondsAsClock", () => {
  it("never prints :60 — the carry lands in the minutes", () => {
    // The whole half-second window below a minute boundary used to floor the
    // minutes and round the seconds up to 60 independently.
    expect(formatSecondsAsClock(299.5)).toBe("5:00");
    expect(formatSecondsAsClock(299.6)).toBe("5:00");
    expect(formatSecondsAsClock(299.9)).toBe("5:00");
    expect(formatSecondsAsClock(300)).toBe("5:00");
    expect(formatSecondsAsClock(59.6)).toBe("1:00");
    expect(formatSecondsAsClock(3599.7)).toBe("60:00");
  });

  it("rounds to the nearer second below the boundary", () => {
    expect(formatSecondsAsClock(299.4)).toBe("4:59");
    expect(formatSecondsAsClock(0)).toBe("0:00");
    expect(formatSecondsAsClock(65)).toBe("1:05");
  });

  it("holds across every fractional second in a minute", () => {
    for (let i = 0; i < 6000; i++) {
      const out = formatSecondsAsClock(i / 10);
      expect(out).toMatch(/^\d+:[0-5]\d$/);
    }
  });
});

describe("formatDuration", () => {
  it("carries 60 minutes into the hour", () => {
    expect(formatDuration(119.6)).toBe("2h 0m");
    expect(formatDuration(59.6)).toBe("1h 0m");
    expect(formatDuration(59.4)).toBe("59m");
    expect(formatDuration(90)).toBe("1h 30m");
  });
});

describe("formatPace", () => {
  it("prints 5:00/km for a 10km in 49:56, not 4:60/km", () => {
    expect(formatPace(activity("Run", 10000, 2996))).toBe("5:00/km");
  });

  it("never prints :60 for a swim either", () => {
    // 1900m in 30:19 → 95.7 s/100m
    expect(formatPace(activity("Swim", 1900, 1819))).toBe("1:36/100m");
    // exactly on the carry boundary: 100m in 59.6s per 100m
    expect(formatPace(activity("Swim", 1000, 596))).toBe("1:00/100m");
  });

  it("still reports rides as speed", () => {
    expect(formatPace(activity("Ride", 40000, 3600))).toBe("40.0 km/h");
  });

  it("returns a dash for empty activities", () => {
    expect(formatPace(activity("Run", 0, 0))).toBe("-");
  });
});
