import { describe, expect, it } from "vitest";
import {
  matchSessions,
  plannedVsActualByWeek,
  SEED_PLAN,
  getWeekStart,
  type CustomWorkoutInput,
  type PlanOverride,
  type PlanOverrideMap,
} from "../src";

// Regression: the calendar can "Remove" (hide) a plan session and add custom
// workouts, but the plan tab used to ignore both — hidden sessions still showed
// and counted km, and custom workouts never appeared. matchSessions /
// plannedVsActualByWeek now honor `hidden` and merge custom workouts.

function hide(sessionId: string, date: string): PlanOverrideMap {
  const override: PlanOverride = {
    sessionId,
    originalDate: date,
    newDate: date,
    movedAt: new Date().toISOString(),
    hidden: true,
  };
  return { [sessionId]: override };
}

describe("hidden sessions", () => {
  it("drops a hidden session from matchSessions", () => {
    const s = SEED_PLAN.sessions[0];
    const visible = matchSessions(SEED_PLAN, [], undefined, s.date);
    expect(visible.some((r) => r.id === s.id)).toBe(true);

    const hidden = matchSessions(SEED_PLAN, [], hide(s.id, s.date), s.date);
    expect(hidden.some((r) => r.id === s.id)).toBe(false);
  });

  it("excludes hidden km from the weekly planned total", () => {
    const s = SEED_PLAN.sessions[0];
    const week = getWeekStart(new Date(s.date + "T12:00:00"));

    const before = plannedVsActualByWeek(SEED_PLAN, [], undefined, s.date).find(
      (w) => w.weekStart === week,
    )!;
    const after = plannedVsActualByWeek(SEED_PLAN, [], hide(s.id, s.date), s.date).find(
      (w) => w.weekStart === week,
    );

    // Either the week's planned km dropped by this session, or the week vanished
    // entirely (if it was that week's only session).
    const afterKm = after?.plannedKm ?? 0;
    expect(afterKm).toBeCloseTo(before.plannedKm - s.km, 1);
  });
});

describe("custom workouts", () => {
  const s = SEED_PLAN.sessions[0];
  const week = getWeekStart(new Date(s.date + "T12:00:00"));
  const swim: CustomWorkoutInput = {
    id: "custom-1",
    date: s.date,
    discipline: "swim",
    name: "Endurance swim",
    distanceKm: 2,
  };

  it("surfaces a custom workout in the session list with its discipline", () => {
    const result = matchSessions(SEED_PLAN, [], undefined, s.date, [swim]);
    const row = result.find((r) => r.id === "custom-1");
    expect(row).toBeDefined();
    expect(row!.isCustom).toBe(true);
    expect(row!.discipline).toBe("swim");
    // Dated today with no matching activity → "today".
    expect(row!.status).toBe("today");
  });

  it("adds custom-workout km to the weekly planned total", () => {
    const base = plannedVsActualByWeek(SEED_PLAN, [], undefined, s.date).find(
      (w) => w.weekStart === week,
    )!;
    const withSwim = plannedVsActualByWeek(SEED_PLAN, [], undefined, s.date, [swim]).find(
      (w) => w.weekStart === week,
    )!;
    expect(withSwim.plannedKm).toBeCloseTo(base.plannedKm + 2, 1);
  });
});
