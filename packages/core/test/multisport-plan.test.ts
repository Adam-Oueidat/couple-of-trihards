import { describe, expect, it } from "vitest";
import {
  buildTrainingPlan,
  findMisdatedSessions,
  matchSessions,
  parseRawTrainingPlan,
  plannedVsActualByWeek,
  type StravaActivity,
} from "../src";

let nextId = 1;
function act(date: string, sport: string, km: number, minutes: number): StravaActivity {
  return {
    id: nextId++,
    name: `${sport} ${date}`,
    sport_type: sport,
    type: sport,
    start_date: `${date}T08:00:00Z`,
    start_date_local: `${date}T08:00:00Z`,
    distance: km * 1000,
    moving_time: minutes * 60,
    total_elevation_gain: 0,
  } as unknown as StravaActivity;
}

function triPlan() {
  return buildTrainingPlan(
    parseRawTrainingPlan({
      name: "Ironman build",
      source: "Coach",
      discipline: "multi",
      startDate: "2026-10-05",
      raceDate: "2027-06-27",
      raceName: "Ironman Frankfurt",
      sessions: [
        { date: "2026-10-05", name: "Technique swim", type: "easy", km: 2, discipline: "swim", durationMin: 45, notes: "Drills" },
        { date: "2026-10-06", name: "Endurance ride", type: "easy", km: 0, discipline: "ride", durationMin: 75, notes: "" },
        { date: "2026-10-07", name: "Strength", type: "easy", km: 0, discipline: "strength", durationMin: 0, notes: "Hips, core" },
        { date: "2026-10-08", name: "Run + strides", type: "easy", km: 8, discipline: "run", durationMin: 50, notes: "" },
      ],
    }),
  );
}

describe("multi-sport plans", () => {
  it("validates per-session sport, duration and notes, dropping empty ones", () => {
    const plan = triPlan();
    expect(plan.discipline).toBe("multi");
    const [swim, ride, strength] = plan.sessions;
    expect(swim).toMatchObject({ discipline: "swim", durationMin: 45, notes: "Drills" });
    expect(ride.notes).toBeUndefined();
    expect(strength.durationMin).toBeUndefined();
  });

  it("requires a sport on every session of a multi-sport plan", () => {
    expect(() =>
      parseRawTrainingPlan({
        name: "x", source: "x", discipline: "multi", startDate: "2026-10-05", raceDate: "2026-10-10", raceName: "x",
        sessions: [{ date: "2026-10-05", name: "Swim", type: "easy", km: 2 }],
      }),
    ).toThrow(/discipline is required/);
  });

  it("gives an uploaded single-sport plan's sessions the plan's sport", () => {
    const plan = buildTrainingPlan(
      parseRawTrainingPlan({
        name: "10K", source: "Runna", discipline: "run", startDate: "2026-10-05", raceDate: "2026-10-10", raceName: "10K",
        sessions: [{ date: "2026-10-05", name: "Easy", type: "easy", km: 6 }],
      }),
    );
    expect(plan.sessions[0].discipline).toBe("run");
  });

  it("grades each session against its own sport: km, then time, then presence", () => {
    const graded = matchSessions(
      triPlan(),
      [
        act("2026-10-05", "Run", 5, 30), // a run is not the planned swim
        act("2026-10-06", "Ride", 30, 70), // 70 of 75 planned minutes
        act("2026-10-07", "WeightTraining", 0, 20), // strength with no target
        act("2026-10-08", "Run", 4, 25), // half the planned km
      ],
      undefined,
      "2026-10-09",
    );
    const status = Object.fromEntries(graded.map((s) => [s.discipline, s.status]));
    expect(status).toEqual({ swim: "missed", ride: "completed", strength: "completed", run: "partial" });
    expect(graded.find((s) => s.discipline === "ride")?.actualMin).toBe(70);
  });

  it("compares planned and actual minutes per week, counting only planned sports", () => {
    const [week] = plannedVsActualByWeek(
      triPlan(),
      [act("2026-10-06", "Ride", 30, 70), act("2026-10-07", "Yoga", 0, 60)],
      undefined,
      "2026-10-09",
    );
    expect(week.plannedMin).toBe(45 + 75 + 50);
    expect(week.actualMin).toBe(70);
  });

  it("offers a missed session a same-sport activity from the next day only", () => {
    const found = findMisdatedSessions(
      triPlan(),
      [act("2026-10-06", "Swim", 2, 45), act("2026-10-09", "Run", 8, 48)],
      undefined,
      "2026-10-10",
    );
    expect(found.map((f) => [f.session.discipline, f.offsetDays])).toEqual([
      ["swim", 1],
      ["run", 1],
    ]);
  });
});
