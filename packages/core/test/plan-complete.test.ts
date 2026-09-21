import { describe, expect, it } from "vitest";
import {
  racePhase,
  isPlanComplete,
  daysUntilRace,
  planAdherence,
  matchSessions,
  type TrainingPlan,
  type StravaActivity,
} from "../src";

function plan(overrides: Partial<TrainingPlan> = {}): TrainingPlan {
  return {
    name: "Test block",
    source: "runna",
    discipline: "run",
    startDate: "2026-06-08",
    raceDate: "2026-09-20",
    raceName: "Copenhagen Half Marathon",
    sessions: [
      { id: "s1", date: "2026-06-08", originalDate: "2026-06-08", name: "Easy", type: "easy", km: 5 },
      { id: "s2", date: "2026-06-10", originalDate: "2026-06-10", name: "Intervals", type: "intervals", km: 8 },
      { id: "s3", date: "2026-09-20", originalDate: "2026-09-20", name: "Race", type: "race", km: 21.1 },
    ],
    ...overrides,
  } as TrainingPlan;
}

function run(date: string, km: number): StravaActivity {
  return {
    id: Number(date.replaceAll("-", "")),
    name: `Run ${date}`,
    sport_type: "Run",
    type: "Run",
    start_date: `${date}T08:00:00Z`,
    start_date_local: `${date}T08:00:00Z`,
    distance: km * 1000,
    moving_time: 1800,
  } as unknown as StravaActivity;
}

describe("racePhase", () => {
  it("counts down before the race", () => {
    expect(racePhase(plan(), "2026-09-10")).toEqual({ state: "upcoming", days: 10 });
  });

  it("knows race day itself", () => {
    expect(racePhase(plan(), "2026-09-20")).toEqual({ state: "raceDay" });
  });

  it("counts up after the race instead of sticking at zero", () => {
    // The bug: daysUntilRace clamps, so every day after the race reported 0
    // and the dashboard said "Race in 0 days" indefinitely.
    expect(racePhase(plan(), "2026-09-21")).toEqual({ state: "complete", days: 1 });
    expect(racePhase(plan(), "2026-10-20")).toEqual({ state: "complete", days: 30 });
  });

  it("isPlanComplete flips only after race day", () => {
    expect(isPlanComplete(plan(), "2026-09-19")).toBe(false);
    expect(isPlanComplete(plan(), "2026-09-20")).toBe(false); // race day is not "over"
    expect(isPlanComplete(plan(), "2026-09-21")).toBe(true);
  });

  it("leaves daysUntilRace's clamped contract alone", () => {
    // Still used where "days until" is the right question; it must not start
    // returning negatives on existing callers.
    expect(daysUntilRace(plan(), "2026-09-10")).toBe(10);
    expect(daysUntilRace(plan(), "2099-01-01")).toBe(0);
  });
});

describe("planAdherence", () => {
  it("rolls the session grades up without disagreeing with them", () => {
    const activities = [run("2026-06-08", 5), run("2026-09-20", 21.1)];
    const a = planAdherence(plan(), activities, {}, "2026-09-21");

    expect(a.total).toBe(3);
    expect(a.completed).toBe(2);
    expect(a.missed).toBe(1); // the 2026-06-10 intervals
    expect(a.remaining).toBe(0); // nothing is upcoming once the plan is over

    // The headline must match the rows it summarises.
    const rows = matchSessions(plan(), activities, {}, "2026-09-21");
    expect(rows.filter((r) => r.status === "completed")).toHaveLength(a.completed);
    expect(rows.filter((r) => r.status === "missed")).toHaveLength(a.missed);
  });

  it("sums planned and actual km", () => {
    const a = planAdherence(plan(), [run("2026-06-08", 6)], {}, "2026-09-21");
    expect(a.plannedKm).toBe(34.1); // 5 + 8 + 21.1
    expect(a.actualKm).toBe(6);
  });

  it("counts skips apart from misses", () => {
    const a = planAdherence(
      plan(),
      [],
      {
        s2: {
          sessionId: "s2",
          originalDate: "2026-06-10",
          newDate: "2026-06-10",
          movedAt: "2026-06-10T00:00:00Z",
          skipped: true,
          skipReason: "calf",
        },
      },
      "2026-09-21",
    );
    expect(a.skipped).toBe(1);
    expect(a.missed).toBe(2);
  });

  it("reports sessions still to come while the plan is live", () => {
    const a = planAdherence(plan(), [], {}, "2026-06-09");
    expect(a.remaining).toBe(2); // 06-10 and the race
    expect(a.missed).toBe(1); // 06-08
  });
});

describe("grading window", () => {
  it("grades a session as completed only when its activity is in range", () => {
    // Reproduces the dashboard bug: the Plan tab was handed a 12-week slice of
    // activities while the plan spanned 15 weeks, so the earliest sessions had
    // nothing to match against and showed missed forever.
    const activities = [run("2026-06-08", 5)];

    const withActivity = matchSessions(plan(), activities, {}, "2026-09-21");
    expect(withActivity.find((s) => s.id === "s1")!.status).toBe("completed");

    const slicedAway = matchSessions(plan(), [], {}, "2026-09-21");
    expect(slicedAway.find((s) => s.id === "s1")!.status).toBe("missed");
  });
});
