import { describe, expect, it } from "vitest";
import {
  applyPlanOverrides,
  matchSessions,
  plannedVsActualByWeek,
  SEED_PLAN,
  getWeekStart,
  type PlanOverride,
  type PlanOverrideMap,
} from "../src";

// An athlete can edit a plan session's name, type and distance. The edit is
// stored as an override layered on top of the plan rather than written back
// into it, so re-uploading the plan cannot silently discard it.

function edit(
  sessionId: string,
  date: string,
  fields: Partial<Pick<PlanOverride, "name" | "type" | "km" | "newDate">>,
): PlanOverrideMap {
  return {
    [sessionId]: {
      sessionId,
      originalDate: date,
      newDate: fields.newDate ?? date,
      movedAt: new Date().toISOString(),
      name: fields.name,
      type: fields.type,
      km: fields.km,
    },
  };
}

describe("applyPlanOverrides base fields", () => {
  it("layers name, type and distance over the plan's own values", () => {
    const s = SEED_PLAN.sessions[0];
    const [merged] = applyPlanOverrides(
      [s],
      edit(s.id, s.date, { name: "Club run", type: "tempo", km: 12.5 }),
    );

    expect(merged.name).toBe("Club run");
    expect(merged.type).toBe("tempo");
    expect(merged.km).toBe(12.5);
  });

  it("leaves an unedited field on the plan's value", () => {
    const s = SEED_PLAN.sessions[0];
    const [merged] = applyPlanOverrides([s], edit(s.id, s.date, { km: 3 }));

    expect(merged.km).toBe(3);
    expect(merged.name).toBe(s.name);
    expect(merged.type).toBe(s.type);
  });

  it("keeps a zero-distance edit rather than falling back to the plan", () => {
    // Guards against `override.km || s.km`: 0 is falsy but a legitimate edit.
    const s = SEED_PLAN.sessions[0];
    const [merged] = applyPlanOverrides([s], edit(s.id, s.date, { km: 0 }));
    expect(merged.km).toBe(0);
  });

  it("does not disturb the session id when the name changes", () => {
    // The id is derived from the stored plan's (date, name) in
    // buildTrainingPlan, before overrides apply. If a rename re-derived it the
    // override row would orphan itself and the edit would vanish.
    const s = SEED_PLAN.sessions[0];
    const [merged] = applyPlanOverrides(
      [s],
      edit(s.id, s.date, { name: "Totally different name" }),
    );
    expect(merged.id).toBe(s.id);
  });

  it("applies a base-field edit and a date move together", () => {
    const s = SEED_PLAN.sessions[0];
    const moved = new Date(new Date(s.date + "T12:00:00").getTime() + 86400000)
      .toISOString()
      .slice(0, 10);

    const [merged] = applyPlanOverrides(
      [s],
      edit(s.id, s.date, { name: "Moved and renamed", newDate: moved }),
    );

    expect(merged.date).toBe(moved);
    expect(merged.movedFrom).toBe(s.originalDate);
    expect(merged.name).toBe("Moved and renamed");
  });
});

describe("edited distance reaches the downstream views", () => {
  it("counts the edited km in the weekly planned total", () => {
    const s = SEED_PLAN.sessions[0];
    const week = getWeekStart(new Date(s.date + "T12:00:00"));

    const before = plannedVsActualByWeek(SEED_PLAN, [], undefined, s.date).find(
      (w) => w.weekStart === week,
    );
    const after = plannedVsActualByWeek(
      SEED_PLAN,
      [],
      edit(s.id, s.date, { km: s.km + 10 }),
      s.date,
    ).find((w) => w.weekStart === week);

    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after!.plannedKm).toBeCloseTo(before!.plannedKm + 10, 5);
  });

  it("shows the edited name through matchSessions", () => {
    const s = SEED_PLAN.sessions[0];
    const rows = matchSessions(
      SEED_PLAN,
      [],
      edit(s.id, s.date, { name: "Renamed session" }),
      s.date,
    );
    expect(rows.find((r) => r.id === s.id)?.name).toBe("Renamed session");
  });
});
