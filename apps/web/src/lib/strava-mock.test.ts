import { afterEach, describe, expect, it, vi } from "vitest";
import {
  devMockEnabled,
  isMockAccessToken,
  MOCK_ACCESS_TOKEN,
  mockActivities,
  mockStravaResponse,
} from "./strava-mock";
import type { DetailedActivity, StravaActivity, StreamSet } from "@trihards/core";

afterEach(() => vi.unstubAllEnvs());

describe("dev Strava mock gating", () => {
  it("is off unless running under next dev", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(devMockEnabled()).toBe(false);
    expect(isMockAccessToken(MOCK_ACCESS_TOKEN)).toBe(false);
  });

  it("is off against a remote database, even under next dev", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TURSO_DATABASE_URL", "libsql://example.turso.io");
    expect(devMockEnabled()).toBe(false);
    expect(isMockAccessToken(MOCK_ACCESS_TOKEN)).toBe(false);
  });

  it("only answers the mock token", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TURSO_DATABASE_URL", "file:.data/local.db");
    expect(isMockAccessToken(MOCK_ACCESS_TOKEN)).toBe(true);
    expect(isMockAccessToken("a-real-strava-token")).toBe(false);
  });
});

describe("mock data", () => {
  const now = new Date("2026-09-24T18:00:00Z");

  it("has the half-marathon race four days ago, tagged as a race", () => {
    const race = mockActivities(now).find((a) => a.workout_type === 1);
    expect(race?.start_date_local.slice(0, 10)).toBe("2026-09-20");
    expect(race?.distance).toBe(21_100);
  });

  it("is newest first and never in the future", () => {
    const acts = mockActivities(now);
    const times = acts.map((a) => new Date(a.start_date).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(Math.max(...times)).toBeLessThanOrEqual(now.getTime());
  });

  it("pages /athlete/activities oldest first, like Strava with `after`", () => {
    vi.useFakeTimers({ now });
    const after = String(Math.floor(now.getTime() / 1000) - 28 * 86_400);
    const p1 = mockStravaResponse("/athlete/activities", { after, per_page: "5", page: "1" }) as StravaActivity[];
    const p2 = mockStravaResponse("/athlete/activities", { after, per_page: "5", page: "2" }) as StravaActivity[];
    expect(p1).toHaveLength(5);
    expect(p1[4].start_date < p2[0].start_date).toBe(true);
    const empty = mockStravaResponse("/athlete/activities", { after, per_page: "5", page: "99" });
    expect(empty).toEqual([]);
    vi.useRealTimers();
  });

  it("serves detail and streams for its own activities, and 404s otherwise", () => {
    vi.useFakeTimers({ now });
    const [latest] = mockActivities(now);
    const detail = mockStravaResponse(`/activities/${latest.id}`) as DetailedActivity;
    expect(detail.id).toBe(latest.id);
    expect(detail.laps?.length).toBeGreaterThan(0);
    const streams = mockStravaResponse(`/activities/${latest.id}/streams`) as StreamSet;
    expect(streams.time?.data.length).toBe(streams.heartrate?.data.length);
    expect(() => mockStravaResponse("/activities/1")).toThrow(/404/);
    expect(() => mockStravaResponse("/segments/1")).toThrow(/404/);
    vi.useRealTimers();
  });
});
