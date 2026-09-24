import { describe, expect, it } from "vitest";
import {
  buildBlockRecap,
  calcTrainingLoad,
  estimateTSS,
  getDiscipline,
  groupByWeek,
  isEnduranceDiscipline,
  timeShare,
  type StravaActivity,
} from "../src";

const TODAY = "2026-09-21";
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

describe("strength as a discipline", () => {
  it("recognises Strava's strength activity types", () => {
    for (const t of ["WeightTraining", "Crossfit", "Workout", "HighIntensityIntervalTraining"]) {
      expect(getDiscipline(act(TODAY, t, 0, 30))).toBe("strength");
    }
    expect(getDiscipline(act(TODAY, "Yoga", 0, 30))).toBe("other");
  });

  it("is training time but not an endurance discipline", () => {
    expect(isEnduranceDiscipline("strength")).toBe(false);
    expect(isEnduranceDiscipline("run")).toBe(true);
  });

  it("adds strength minutes to the week without touching the tri totals", () => {
    const [week] = groupByWeek([
      act("2026-09-15", "WeightTraining", 0, 45),
      act("2026-09-16", "Run", 10, 50),
    ]);
    expect(week.strengthTime).toBe(45);
    expect(week.runTime).toBe(50);
    expect(week.run).toBe(10);
  });

  it("weighs a strength minute below a run minute when there is no suffer score", () => {
    expect(estimateTSS(act(TODAY, "WeightTraining", 0, 60))).toBe(36);
    expect(estimateTSS(act(TODAY, "Run", 10, 60))).toBe(60);
  });

  it("counts strength in the block recap's totals and time share", () => {
    const activities = [
      act("2026-09-15", "WeightTraining", 0, 30),
      act("2026-09-16", "Run", 10, 60),
      act("2026-09-17", "Ride", 30, 60),
    ];
    const recap = buildBlockRecap(activities, calcTrainingLoad(activities, TODAY), TODAY);
    expect(recap.totals.byDiscipline.strength).toMatchObject({ sessions: 1, minutes: 30 });
    expect(recap.totals.sessions).toBe(3);
    expect(timeShare(recap.totals).strength).toBe(20);
    // A gym hour is not the block's longest session.
    expect(recap.longestSession?.discipline).not.toBe("strength");
  });
});
