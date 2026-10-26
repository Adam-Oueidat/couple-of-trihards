import { describe, expect, it } from "vitest";
import {
  buildTrainingPlan,
  estimateSessionMinutes,
  parseRawTrainingPlan,
  planWeeks,
  type PlanOverrideMap,
  type StravaActivity,
} from "../src";

function act(date: string, type: string, km: number, min: number): StravaActivity {
  return {
    id: Math.floor(Math.random() * 1e9),
    name: `${type} ${date}`,
    type,
    sport_type: type,
    start_date_local: `${date}T07:00:00Z`,
    distance: km * 1000,
    moving_time: min * 60,
  } as StravaActivity;
}

// Two weeks, Mon 2026-10-05 and Mon 2026-10-19, with an empty week between.
const plan = buildTrainingPlan(
  parseRawTrainingPlan({
    name: "Tri block",
    source: "Coach",
    discipline: "multi",
    startDate: "2026-10-05",
    raceDate: "2026-10-25",
    raceName: "",
    sessions: [
      { date: "2026-10-05", name: "Swim", type: "easy", km: 2, discipline: "swim", durationMin: 45 },
      { date: "2026-10-07", name: "Tempo run", type: "tempo", km: 10, discipline: "run" },
      { date: "2026-10-10", name: "Long ride", type: "long", km: 0, discipline: "ride", durationMin: 120 },
      { date: "2026-10-20", name: "Easy run", type: "easy", km: 8, discipline: "run", durationMin: 50 },
    ],
  }),
);

describe("planWeeks", () => {
  it("is empty with no plan and nothing added", () => {
    expect(planWeeks(null, [], undefined, "2026-10-08")).toEqual([]);
  });

  it("runs from the first planned week to the last, empty weeks included", () => {
    const weeks = planWeeks(plan, [], undefined, "2026-10-01");
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-10-05", "2026-10-12", "2026-10-19"]);
    expect(weeks[1]).toMatchObject({ plannedMin: 0, sessions: [] });
    expect(weeks.every((w) => w.isFuture)).toBe(true);
  });

  it("estimates time for a session that only gives distance", () => {
    const [week] = planWeeks(plan, [], undefined, "2026-10-01");
    expect(week.sports.run!.plannedMin).toBe(estimateSessionMinutes({ discipline: "run", km: 10 }));
    expect(week.plannedMin).toBe(45 + 60 + 120);
  });

  it("splits a week by sport, crediting same-day training and keeping the rest as extra", () => {
    const [week] = planWeeks(
      plan,
      [
        act("2026-10-05", "Swim", 1.8, 40), // planned swim day
        act("2026-10-07", "Run", 10.2, 55), // planned run day
        act("2026-10-08", "Run", 5, 30), // no run planned: extra
        act("2026-10-09", "Ride", 20, 45), // no ride planned that day: extra
        act("2026-10-09", "Yoga", 0, 60), // not a tracked sport
      ],
      undefined,
      "2026-10-11",
    );
    expect(week.sports.swim).toMatchObject({ doneMin: 40, doneKm: 1.8, extraMin: 0 });
    expect(week.sports.run).toMatchObject({ doneMin: 55, doneKm: 10.2, extraMin: 30, extraKm: 5 });
    expect(week.sports.ride).toMatchObject({ plannedMin: 120, doneMin: 0, extraMin: 45 });
    expect(week).toMatchObject({ doneMin: 95, extraMin: 75 });
    expect(week.counts).toEqual({ completed: 2, partial: 0, missed: 1, skipped: 0, remaining: 0 });
  });

  it("measures the current week against what is due so far", () => {
    const [week] = planWeeks(plan, [act("2026-10-05", "Swim", 2, 45)], undefined, "2026-10-07");
    expect(week.isCurrentWeek).toBe(true);
    // Swim and today's run are due; Saturday's ride is not yet.
    expect(week.dueMin).toBe(45 + 60);
    expect(week.plannedMin).toBe(45 + 60 + 120);
    expect(week.counts).toMatchObject({ completed: 1, remaining: 2 });
  });

  it("keeps a skipped session planned but drops a removed one", () => {
    const swim = plan.sessions[0];
    const skipped: PlanOverrideMap = {
      [swim.id]: { sessionId: swim.id, originalDate: swim.date, newDate: swim.date, movedAt: "", skipped: true },
    };
    const hidden: PlanOverrideMap = {
      [swim.id]: { sessionId: swim.id, originalDate: swim.date, newDate: swim.date, movedAt: "", hidden: true },
    };
    const swimDone = [act("2026-10-05", "Swim", 2, 45)];
    const [withSkip] = planWeeks(plan, swimDone, skipped, "2026-10-11");
    expect(withSkip.sports.swim).toMatchObject({ plannedMin: 45, doneMin: 0, extraMin: 45 });
    expect(withSkip.counts.skipped).toBe(1);
    const [withHide] = planWeeks(plan, swimDone, hidden, "2026-10-11");
    expect(withHide.plannedMin).toBe(60 + 120);
  });

  it("counts a moved session in the week it moved to", () => {
    const ride = plan.sessions[2];
    const moved: PlanOverrideMap = {
      [ride.id]: { sessionId: ride.id, originalDate: ride.date, newDate: "2026-10-13", movedAt: "" },
    };
    const weeks = planWeeks(plan, [], moved, "2026-10-01");
    expect(weeks[0].sports.ride).toBeUndefined();
    expect(weeks[1].sports.ride!.plannedMin).toBe(120);
  });

  it("ignores activities after today", () => {
    const [week] = planWeeks(plan, [act("2026-10-10", "Ride", 60, 120)], undefined, "2026-10-08");
    expect(week.doneMin).toBe(0);
  });
});
