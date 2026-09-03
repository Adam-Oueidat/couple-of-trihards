import { describe, expect, it } from "vitest";
import {
  applyPlanOverrides,
  matchSessions,
  plannedVsActualByWeek,
  SEED_PLAN,
  getWeekStart,
  type PlanOverrideMap,
  type StravaActivity,
} from "../src";

// An athlete can mark a planned session skipped and say why. That is a
// different thing from removing it: a removed session leaves the plan entirely,
// while a skipped one stays visible, keeps its reason, and reaches the coach.

function skip(sessionId: string, date: string, reason?: string): PlanOverrideMap {
  return {
    [sessionId]: {
      sessionId,
      originalDate: date,
      newDate: date,
      movedAt: new Date().toISOString(),
      skipped: true,
      skipReason: reason,
    },
  };
}

function hide(sessionId: string, date: string): PlanOverrideMap {
  return {
    [sessionId]: {
      sessionId,
      originalDate: date,
      newDate: date,
      movedAt: new Date().toISOString(),
      hidden: true,
    },
  };
}

function run(date: string, km: number): StravaActivity {
  return {
    name: "Morning Run",
    type: "Run",
    sport_type: "Run",
    distance: km * 1000,
    moving_time: 1800,
    start_date_local: `${date}T07:00:00Z`,
  } as unknown as StravaActivity;
}

describe("skipped is not removed", () => {
  it("keeps a skipped session in matchSessions where a hidden one is dropped", () => {
    const s = SEED_PLAN.sessions[0];

    const skipped = matchSessions(SEED_PLAN, [], skip(s.id, s.date), s.date);
    expect(skipped.some((r) => r.id === s.id)).toBe(true);

    const hidden = matchSessions(SEED_PLAN, [], hide(s.id, s.date), s.date);
    expect(hidden.some((r) => r.id === s.id)).toBe(false);
  });

  it("carries the reason through to the session", () => {
    const s = SEED_PLAN.sessions[0];
    const [merged] = applyPlanOverrides([s], skip(s.id, s.date, "calf was tight"));

    expect(merged.skipped).toBe(true);
    expect(merged.skipReason).toBe("calf was tight");
  });

  it("still counts the skipped distance in the week's planned km", () => {
    // Deducting it would let a week of skips read as full adherence.
    const s = SEED_PLAN.sessions[0];
    const week = getWeekStart(new Date(s.date + "T12:00:00"));
    const kmFor = (overrides?: PlanOverrideMap) =>
      plannedVsActualByWeek(SEED_PLAN, [], overrides, s.date).find(
        (w) => w.weekStart === week,
      )?.plannedKm;

    expect(kmFor(skip(s.id, s.date))).toBe(kmFor(undefined));
    expect(kmFor(hide(s.id, s.date))).toBeCloseTo(kmFor(undefined)! - s.km, 5);
  });
});

describe("skipped status ordering", () => {
  it("reports skipped rather than missed for a past session", () => {
    const s = SEED_PLAN.sessions[0];
    const later = "2099-01-01";

    expect(
      matchSessions(SEED_PLAN, [], undefined, later).find((r) => r.id === s.id)?.status,
    ).toBe("missed");
    expect(
      matchSessions(SEED_PLAN, [], skip(s.id, s.date), later).find((r) => r.id === s.id)
        ?.status,
    ).toBe("skipped");
  });

  it("does not grade a skipped session against a same-day run", () => {
    // A swap ("skipped the run, swam instead") is not a completed run, and a
    // shakeout on the same day is not a half-finished interval session.
    const s = SEED_PLAN.sessions[0];
    const activities = [run(s.date, s.km)];

    expect(
      matchSessions(SEED_PLAN, activities, undefined, s.date).find((r) => r.id === s.id)
        ?.status,
    ).toBe("completed");

    const row = matchSessions(SEED_PLAN, activities, skip(s.id, s.date), s.date).find(
      (r) => r.id === s.id,
    );
    expect(row?.status).toBe("skipped");
    expect(row?.actualKm).toBeUndefined();
    expect(row?.matchedActivity).toBeUndefined();
  });

  it("outranks today and upcoming, so a skip can be declared in advance", () => {
    const s = SEED_PLAN.sessions[0];
    const earlier = "2000-01-01";

    expect(
      matchSessions(SEED_PLAN, [], skip(s.id, s.date), s.date).find((r) => r.id === s.id)
        ?.status,
    ).toBe("skipped");
    expect(
      matchSessions(SEED_PLAN, [], skip(s.id, s.date), earlier).find(
        (r) => r.id === s.id,
      )?.status,
    ).toBe("skipped");
  });

  it("keeps a skip attached to the session after a move", () => {
    const s = SEED_PLAN.sessions[0];
    const moved = new Date(new Date(s.date + "T12:00:00").getTime() + 86400000)
      .toISOString()
      .slice(0, 10);

    const row = matchSessions(
      SEED_PLAN,
      [],
      {
        [s.id]: {
          sessionId: s.id,
          originalDate: s.date,
          newDate: moved,
          movedAt: new Date().toISOString(),
          reason: "work travel",
          skipped: true,
          skipReason: "still could not fit it in",
        },
      },
      s.date,
    ).find((r) => r.id === s.id);

    expect(row?.date).toBe(moved);
    expect(row?.movedFrom).toBe(s.originalDate);
    expect(row?.moveReason).toBe("work travel");
    expect(row?.status).toBe("skipped");
    expect(row?.skipReason).toBe("still could not fit it in");
  });
});
