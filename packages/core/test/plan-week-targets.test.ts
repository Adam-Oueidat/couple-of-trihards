import { describe, expect, it } from "vitest";
import { buildTrainingPlan, plannedKmForWeek, type PlanOverrideMap } from "../src";

// The feed's week strip fills a discipline toward the plan's target when the
// plan prescribes one this week. That target has to be the week as the athlete
// sees it on the calendar: moves and removals applied, not the plan as stored.

const WEEK = "2026-05-04"; // a Monday

const plan = buildTrainingPlan({
  name: "Test plan",
  source: "test",
  discipline: "run",
  startDate: "2026-04-27",
  raceDate: "2026-06-28",
  raceName: "Test race",
  sessions: [
    { date: "2026-05-03", name: "Long run", type: "long", km: 16 }, // the Sunday before
    { date: "2026-05-05", name: "Easy run", type: "easy", km: 8 },
    { date: "2026-05-07", name: "Intervals", type: "intervals", km: 10 },
    { date: "2026-05-10", name: "Long run", type: "long", km: 18 },
    { date: "2026-05-12", name: "Easy run", type: "easy", km: 6 }, // the Tuesday after
  ],
});

function idOf(date: string): string {
  return plan.sessions.find((s) => s.date === date)!.id;
}

function override(date: string, fields: { newDate?: string; hidden?: boolean; skipped?: boolean; km?: number }): PlanOverrideMap {
  const sessionId = idOf(date);
  return {
    [sessionId]: {
      sessionId,
      originalDate: date,
      newDate: fields.newDate ?? date,
      movedAt: new Date().toISOString(),
      hidden: fields.hidden,
      skipped: fields.skipped,
      km: fields.km,
    },
  };
}

describe("plannedKmForWeek", () => {
  it("sums the week's sessions for the plan's discipline only", () => {
    expect(plannedKmForWeek(plan, WEEK)).toEqual({ run: 36 });
  });

  it("is empty with no plan, or no sessions that week", () => {
    expect(plannedKmForWeek(null, WEEK)).toEqual({});
    expect(plannedKmForWeek(plan, "2026-08-03")).toEqual({});
  });

  it("drops a session moved out of the week", () => {
    expect(plannedKmForWeek(plan, WEEK, override("2026-05-10", { newDate: "2026-05-11" }))).toEqual({
      run: 18,
    });
  });

  it("counts a session moved into the week", () => {
    expect(plannedKmForWeek(plan, WEEK, override("2026-05-03", { newDate: "2026-05-04" }))).toEqual({
      run: 52,
    });
    expect(plannedKmForWeek(plan, WEEK, override("2026-05-12", { newDate: "2026-05-09" }))).toEqual({
      run: 42,
    });
  });

  it("drops a removed session but keeps a skipped one", () => {
    expect(plannedKmForWeek(plan, WEEK, override("2026-05-07", { hidden: true }))).toEqual({ run: 26 });
    expect(plannedKmForWeek(plan, WEEK, override("2026-05-07", { skipped: true }))).toEqual({ run: 36 });
  });

  it("uses the athlete's edited distance", () => {
    expect(plannedKmForWeek(plan, WEEK, override("2026-05-05", { km: 5.5 }))).toEqual({ run: 33.5 });
  });

  it("splits a multi-sport week by discipline and leaves out time-only sessions", () => {
    const multi = buildTrainingPlan({
      ...plan,
      discipline: "multi",
      sessions: [
        { date: "2026-05-05", name: "Swim", type: "easy", km: 2.5, discipline: "swim" },
        { date: "2026-05-06", name: "Ride", type: "long", km: 60, discipline: "ride" },
        { date: "2026-05-07", name: "Turbo", type: "easy", km: 0, durationMin: 45, discipline: "ride" },
        { date: "2026-05-08", name: "Gym", type: "easy", km: 0, durationMin: 40, discipline: "strength" },
        { date: "2026-05-09", name: "Brick run", type: "easy", km: 5, discipline: "run" },
      ],
    });
    expect(plannedKmForWeek(multi, WEEK)).toEqual({ swim: 2.5, ride: 60, run: 5 });
  });
});
