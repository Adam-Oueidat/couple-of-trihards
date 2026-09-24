import { describe, expect, it } from "vitest";
import {
  draftStats,
  expandDraft,
  mondayOf,
  parsePlanRequest,
  startingPoint,
  type DraftModelOutput,
  type DraftSession,
  type StravaActivity,
} from "../src";

const TODAY = "2026-09-24"; // a Thursday

const ses = (day: DraftSession["day"], discipline: DraftSession["discipline"], durationMin: number, km = 0): DraftSession => ({
  day,
  name: `${discipline} ${day}`,
  discipline,
  type: "easy",
  km,
  durationMin,
  notes: "",
});

function output(weeks: DraftModelOutput["weeks"]): DraftModelOutput {
  return { name: "Test plan", why: "Because.", assumptions: ["Pool twice a week"], weeks };
}

describe("parsePlanRequest", () => {
  it("accepts the Create dialog's fields and normalises them", () => {
    const r = parsePlanRequest(
      { prompt: " Create an Ironman plan for me ", startDate: "2026-10-05", raceDate: "2027-06-27", maxHoursPerWeek: "14", unavailableDays: ["fri", "fri", "nope"] },
      TODAY,
    );
    expect(r).toEqual({ prompt: "Create an Ironman plan for me", startDate: "2026-10-05", raceDate: "2027-06-27", maxHoursPerWeek: 14, unavailableDays: ["fri"] });
  });

  it("refuses a start in the past, a race before the start, and an over-long plan", () => {
    expect(() => parsePlanRequest({ prompt: "x", startDate: "2026-09-01" }, TODAY)).toThrow(/past/);
    expect(() => parsePlanRequest({ prompt: "x", startDate: "2026-10-05", raceDate: "2026-10-01" }, TODAY)).toThrow(/after/);
    expect(() => parsePlanRequest({ prompt: "x", startDate: "2026-10-05", raceDate: "2028-01-01" }, TODAY)).toThrow(/at most/);
  });
});

describe("expandDraft", () => {
  it("dates sessions from week and weekday, starting at the start date's week", () => {
    // Start on a Wednesday: week 1's Monday and Tuesday are before the plan.
    const { plan, dropped } = expandDraft(
      output([
        { phase: "Base", focus: "", sessions: [ses("mon", "swim", 45), ses("wed", "ride", 60), ses("sun", "run", 50, 9)] },
        { phase: "Base", focus: "", sessions: [ses("tue", "strength", 30)] },
      ]),
      { prompt: "x", startDate: "2026-10-07" },
    );
    expect(mondayOf("2026-10-07")).toBe("2026-10-05");
    expect(plan.sessions.map((s) => [s.date, s.discipline])).toEqual([
      ["2026-10-07", "ride"],
      ["2026-10-11", "run"],
      ["2026-10-13", "strength"],
    ]);
    expect(dropped).toBe(1);
    expect(plan.discipline).toBe("multi");
    // No race: the plan ends with its last session and names no race.
    expect(plan.raceDate).toBe("2026-10-13");
    expect(plan.raceName).toBe("");
  });

  it("drops sessions on days the athlete can't train and after race day", () => {
    const { plan, dropped } = expandDraft(
      output([{ phase: "Race", focus: "", sessions: [ses("fri", "run", 30), ses("sat", "run", 20), ses("sun", "run", 120, 21)] }]),
      { prompt: "x", startDate: "2026-10-05", raceDate: "2026-10-10", raceName: "10K", unavailableDays: ["fri"] },
    );
    expect(plan.sessions.map((s) => s.date)).toEqual(["2026-10-10"]);
    expect(dropped).toBe(2);
    expect(plan.raceName).toBe("10K");
  });

  it("groups consecutive weeks into phases", () => {
    const { phases } = expandDraft(
      output([
        { phase: "Base", focus: "", sessions: [ses("mon", "run", 30)] },
        { phase: "Base", focus: "", sessions: [ses("mon", "run", 30)] },
        { phase: "Build", focus: "", sessions: [ses("mon", "run", 30)] },
      ]),
      { prompt: "x", startDate: "2026-10-05" },
    );
    expect(phases).toEqual([
      { name: "Base", weeks: 2, startDate: "2026-10-05" },
      { name: "Build", weeks: 1, startDate: "2026-10-19" },
    ]);
  });

  it("keeps a recovery week inside the phase around it", () => {
    const { phases } = expandDraft(
      output(["Recovery", "Base", "Base", "Recovery", "Base", "Build"].map((phase) => ({ phase, focus: "", sessions: [ses("mon", "run", 30)] }))),
      { prompt: "x", startDate: "2026-10-05" },
    );
    expect(phases.map((p) => [p.name, p.weeks])).toEqual([
      ["Recovery", 1],
      ["Base", 4],
      ["Build", 1],
    ]);
  });
});

describe("draftStats", () => {
  it("sums planned minutes by sport, spots a recovery week, and projects fitness up", () => {
    const week = (min: number) => ({ phase: "Build", focus: "", sessions: [ses("tue", "ride", min), ses("thu", "run", min), ses("sat", "strength", 30)] });
    const draft = expandDraft(output([week(90), week(100), week(50), week(110)]), { prompt: "x", startDate: "2026-10-05" });
    const stats = draftStats(draft, []);
    expect(stats.weeks[0].minutes).toEqual({ swim: 0, ride: 90, run: 90, strength: 30 });
    expect(stats.weeks.map((w) => w.recovery)).toEqual([false, false, true, false]);
    expect(stats.recoveryWeeks).toBe(1);
    expect(stats.ctlPeak).toBeGreaterThan(stats.ctlStart);
    expect(stats.hoursMax).toBeCloseTo(250 / 60, 1);
  });
});

describe("draftStats on race day", () => {
  it("reads form on race morning, before the race's own load", () => {
    const taper = { phase: "Taper", focus: "", sessions: [ses("tue", "run", 30), ses("thu", "ride", 40)] };
    const race: DraftModelOutput["weeks"][number] = {
      phase: "Race",
      focus: "",
      sessions: [ses("tue", "run", 20), { ...ses("sun", "run", 600, 42), type: "race" }],
    };
    const build = { phase: "Build", focus: "", sessions: [ses("tue", "ride", 180), ses("thu", "run", 120), ses("sat", "ride", 300), ses("sun", "run", 150)] };
    const draft = expandDraft(output([build, build, build, taper, race]), {
      prompt: "x", startDate: "2026-10-05", raceDate: "2026-11-08", raceName: "Ironman",
    });
    const stats = draftStats(draft, []);
    expect(stats.formEnd).toBeGreaterThan(0);
    expect(stats.ctl[stats.ctl.length - 1].date).toBe("2026-11-07");
  });
});

describe("startingPoint", () => {
  const act = (day: string, sport: string, min: number, km: number) =>
    ({ id: Math.random(), name: sport, sport_type: sport, type: sport, start_date: `${day}T08:00:00Z`, start_date_local: `${day}T08:00:00Z`, distance: km * 1000, moving_time: min * 60, total_elevation_gain: 0 }) as unknown as StravaActivity;

  it("reports recent hours, split, longest sessions and projects fitness to the start", () => {
    const history = [act("2026-09-20", "Ride", 180, 90), act("2026-09-21", "Run", 60, 12), act("2026-09-22", "WeightTraining", 60, 0)];
    const upcoming = new Map([["2026-09-30", 200]]);
    const sp = startingPoint(history, TODAY, "2026-10-05", upcoming);
    expect(sp.hoursPerWeek).toBe(0.6);
    expect(sp.split).toEqual({ swim: 0, ride: 60, run: 20, strength: 20 });
    expect(sp.longestRideMin).toBe(180);
    expect(sp.ctlAtStart).toBeGreaterThan(startingPoint(history, TODAY, "2026-10-05").ctlAtStart);
  });
});
