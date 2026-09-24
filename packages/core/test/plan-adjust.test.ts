import { describe, expect, it } from "vitest";
import {
  applyAdjustment,
  buildTrainingPlan,
  checkAdjustment,
  joinForAdjust,
  splitAdjustment,
  parseRawTrainingPlan,
  type AdjustModelOutput,
  type ProposedChange,
  type RawTrainingPlan,
} from "../src";

const TODAY = "2026-12-01";

const plan: RawTrainingPlan = parseRawTrainingPlan({
  name: "10K block",
  source: "Runna",
  discipline: "run",
  startDate: "2026-11-23",
  raceDate: "2026-12-20",
  raceName: "10K",
  sessions: [
    { date: "2026-11-24", name: "Intervals", type: "intervals", km: 10 },
    { date: "2026-12-01", name: "Run intervals", type: "intervals", km: 11 },
    { date: "2026-12-03", name: "Run + strides", type: "easy", km: 9 },
    { date: "2026-12-06", name: "Long run", type: "long", km: 18 },
    { date: "2026-12-12", name: "Long ride", type: "long", km: 0 },
  ],
});
const id = (name: string) => buildTrainingPlan(plan).sessions.find((s) => s.name === name)!.id;

const change = (over: Partial<ProposedChange>): ProposedChange => ({
  action: "update", sessionId: "", date: TODAY, name: "", discipline: "run", type: "easy", km: 0, durationMin: 0, notes: "", why: "knee", ...over,
});
const out = (changes: ProposedChange[]): AdjustModelOutput => ({ message: "Lighter for two weeks.", changes });

describe("checkAdjustment", () => {
  it("accepts updates, sport swaps, removals and additions to upcoming sessions", () => {
    const checked = checkAdjustment(plan, {}, out([
      change({ sessionId: id("Run intervals"), date: "2026-12-01", name: "Easy run", km: 6, durationMin: 30 }),
      change({ sessionId: id("Run + strides"), date: "2026-12-03", name: "Aerobic swim", discipline: "swim", km: 2, durationMin: 50 }),
      change({ action: "remove", sessionId: id("Long run"), date: "2026-12-06" }),
      change({ action: "add", date: "2026-12-07", name: "Easy ride", discipline: "ride", durationMin: 75 }),
    ]), TODAY);
    expect(checked.changes.map((c) => c.action)).toEqual(["update", "update", "remove", "add"]);
    expect(checked.changes[1].before?.discipline).toBe("run");
    expect(checked.changes[1].after?.discipline).toBe("swim");
    expect(checked.rejected).toBe(0);
  });

  it("keeps sessions the athlete edited, and never touches the past or unknown ids", () => {
    const checked = checkAdjustment(
      plan,
      { [id("Long ride")]: { sessionId: id("Long ride"), originalDate: "2026-12-12", newDate: "2026-12-13", movedAt: "x" } },
      out([
        change({ sessionId: id("Long ride"), date: "2026-12-12", name: "Shorter ride", discipline: "ride" }),
        change({ sessionId: id("Intervals"), date: "2026-12-01" }), // in the past
        change({ sessionId: "made-up", date: "2026-12-02" }),
        change({ action: "add", date: "2026-11-30" }), // before today
        change({ action: "add", date: "2027-01-10" }), // after the plan
      ]),
      TODAY,
    );
    expect(checked.changes).toEqual([]);
    expect(checked.kept.map((k) => k.before.name)).toEqual(["Long ride"]);
    expect(checked.rejected).toBe(4);
  });
});

describe("applyAdjustment", () => {
  it("rewrites only the changed sessions and turns a run plan multi-sport when a swim arrives", () => {
    const checked = checkAdjustment(plan, {}, out([
      change({ sessionId: id("Run + strides"), date: "2026-12-03", name: "Aerobic swim", discipline: "swim", km: 2, durationMin: 50 }),
      change({ action: "remove", sessionId: id("Long run"), date: "2026-12-06" }),
    ]), TODAY);
    const next = applyAdjustment(plan, checked);
    expect(next.discipline).toBe("multi");
    expect(next.sessions.map((s) => [s.date, s.name, s.discipline])).toEqual([
      ["2026-11-24", "Intervals", "run"],
      ["2026-12-01", "Run intervals", "run"],
      ["2026-12-03", "Aerobic swim", "swim"],
      ["2026-12-12", "Long ride", "run"],
    ]);
    // Untouched sessions keep their ids, so the athlete's edits still apply.
    expect(buildTrainingPlan(next).sessions[0].id).toBe(id("Intervals"));
  });
});

describe("adjusting across a plan that took over", () => {
  const next: RawTrainingPlan = parseRawTrainingPlan({
    name: "Marathon", source: "Coach", discipline: "run", startDate: "2026-12-07", raceDate: "2027-03-01", raceName: "",
    sessions: [
      { date: "2026-12-08", name: "Easy run", type: "easy", km: 8 },
      { date: "2026-12-13", name: "Long run", type: "long", km: 20 },
    ],
  });
  const joined = joinForAdjust(plan, next);
  const jid = (name: string, date: string) => buildTrainingPlan(joined).sessions.find((s) => s.name === name && s.date === date)!.id;

  it("shows the older plan's sessions up to the new start, then the new plan", () => {
    expect(joined.sessions.map((s) => `${s.date} ${s.name}`)).toEqual([
      "2026-11-24 Intervals", "2026-12-01 Run intervals", "2026-12-03 Run + strides", "2026-12-06 Long run",
      "2026-12-08 Easy run", "2026-12-13 Long run",
    ]);
  });

  it("changes each session in the plan that owns it, and moves one across the boundary", () => {
    const checked = checkAdjustment(joined, {}, out([
      change({ sessionId: jid("Run + strides", "2026-12-03"), date: "2026-12-03", name: "Easy run", km: 6 }),
      change({ action: "remove", sessionId: jid("Long run", "2026-12-13"), date: "2026-12-13" }),
      // Moved from the older plan into the new plan's weeks.
      change({ sessionId: jid("Long run", "2026-12-06"), date: "2026-12-09", name: "Long run", type: "long", km: 12 }),
    ]), TODAY);
    const split = splitAdjustment(checked, plan, next);
    const olderAfter = applyAdjustment(plan, split.carried);
    const newerAfter = applyAdjustment(next, split.latest);
    expect(olderAfter.sessions.map((s) => `${s.date} ${s.name}`)).toEqual([
      "2026-11-24 Intervals", "2026-12-01 Run intervals", "2026-12-03 Easy run", "2026-12-12 Long ride",
    ]);
    expect(newerAfter.sessions.map((s) => `${s.date} ${s.name} ${s.km}`)).toEqual([
      "2026-12-08 Easy run 8", "2026-12-09 Long run 12",
    ]);
  });
});
