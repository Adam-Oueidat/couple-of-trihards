import { describe, expect, it } from "vitest";
import { applyDraftEdit, buildTrainingPlan, parseDraftEdit, type PlanRequest, type RawTrainingPlan } from "../src";

const request: PlanRequest = { prompt: "Olympic tri", startDate: "2026-10-05", raceDate: "2026-10-18", unavailableDays: ["fri"] };

const plan: RawTrainingPlan = {
  name: "Coach plan",
  source: "Coach",
  discipline: "multi",
  startDate: "2026-10-05",
  raceDate: "2026-10-18",
  raceName: "",
  sessions: [
    { date: "2026-10-05", name: "Easy swim", discipline: "swim", type: "easy", km: 2, durationMin: 45 },
    { date: "2026-10-07", name: "Tempo run", discipline: "run", type: "tempo", km: 8, durationMin: 50 },
    { date: "2026-10-11", name: "Long ride", discipline: "ride", type: "long", km: 0, durationMin: 150 },
    { date: "2026-10-14", name: "Tempo run", discipline: "run", type: "tempo", km: 8, durationMin: 50 },
  ],
};

const idOf = (p: RawTrainingPlan, i: number) => buildTrainingPlan(p).sessions[i].id;

describe("applyDraftEdit", () => {
  it("moves a session and keeps the plan in date order", () => {
    const next = applyDraftEdit(plan, { sessionId: idOf(plan, 0), action: "move", date: "2026-10-12" }, request);
    expect(next.sessions.map((s) => `${s.date} ${s.name}`)).toEqual([
      "2026-10-07 Tempo run",
      "2026-10-11 Long ride",
      "2026-10-12 Easy swim",
      "2026-10-14 Tempo run",
    ]);
    expect(plan.sessions[0].date).toBe("2026-10-05"); // the input is left alone
  });

  it("tells a moved session apart from one of the same name on that day", () => {
    const next = applyDraftEdit(plan, { sessionId: idOf(plan, 1), action: "move", date: "2026-10-14" }, request);
    expect(next.sessions.filter((s) => s.date === "2026-10-14").map((s) => s.name)).toEqual(["Tempo run", "Tempo run (2)"]);
    const ids = buildTrainingPlan(next).sessions.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("refuses a day outside the plan or one the athlete can't train", () => {
    const id = idOf(plan, 0);
    expect(() => applyDraftEdit(plan, { sessionId: id, action: "move", date: "2026-10-19" }, request)).toThrow(/inside the plan/);
    expect(() => applyDraftEdit(plan, { sessionId: id, action: "move", date: "2026-10-09" }, request)).toThrow(/can't train/);
  });

  it("deletes a session, but never the last one", () => {
    const next = applyDraftEdit(plan, { sessionId: idOf(plan, 2), action: "delete" }, request);
    expect(next.sessions.map((s) => s.name)).not.toContain("Long ride");
    const single = { ...plan, sessions: [plan.sessions[0]] };
    expect(() => applyDraftEdit(single, { sessionId: idOf(single, 0), action: "delete" }, request)).toThrow(/at least one/);
  });

  it("retimes a session", () => {
    const next = applyDraftEdit(plan, { sessionId: idOf(plan, 2), action: "retime", durationMin: 120 }, request);
    expect(next.sessions[2]).toMatchObject({ name: "Long ride", durationMin: 120 });
  });

  it("refuses a session that is no longer in the draft", () => {
    expect(() => applyDraftEdit(plan, { sessionId: "nope", action: "delete" }, request)).toThrow(/no longer/);
  });
});

describe("parseDraftEdit", () => {
  it("reads each kind of edit", () => {
    expect(parseDraftEdit({ sessionId: "a", edit: "move", date: "2026-10-12" })).toEqual({ sessionId: "a", action: "move", date: "2026-10-12" });
    expect(parseDraftEdit({ sessionId: "a", edit: "delete" })).toEqual({ sessionId: "a", action: "delete" });
    expect(parseDraftEdit({ sessionId: "a", edit: "retime", durationMin: "59.6" })).toEqual({ sessionId: "a", action: "retime", durationMin: 60 });
  });

  it("rejects bad input", () => {
    expect(() => parseDraftEdit({ edit: "delete" })).toThrow(/sessionId/);
    expect(() => parseDraftEdit({ sessionId: "a", edit: "move", date: "12/10" })).toThrow(/YYYY-MM-DD/);
    expect(() => parseDraftEdit({ sessionId: "a", edit: "retime", durationMin: 2 })).toThrow(/minutes/);
    expect(() => parseDraftEdit({ sessionId: "a", edit: "rename" })).toThrow(/move, delete or retime/);
  });
});
