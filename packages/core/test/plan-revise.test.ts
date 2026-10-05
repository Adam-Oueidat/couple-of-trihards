import { describe, expect, it } from "vitest";
import {
  draftStats,
  draftToModelOutput,
  expandDraft,
  mergeRevision,
  parseRevisionRequest,
  summarizeRevision,
  type DraftModelOutput,
  type DraftSession,
  type PlanRequest,
} from "../src";

const ses = (day: DraftSession["day"], discipline: DraftSession["discipline"], durationMin: number, km = 0): DraftSession => ({
  day,
  name: `${discipline} ${day}`,
  discipline,
  type: "easy",
  km,
  durationMin,
  notes: "",
});

const request: PlanRequest = { prompt: "Olympic tri", startDate: "2026-10-07", unavailableDays: ["fri"] }; // a Wednesday

const week = (phase: string, runMin: number) => ({
  phase,
  focus: `${phase} week`,
  sessions: [ses("wed", "swim", 45, 2), ses("thu", "ride", 60), ses("sat", "run", runMin, 8), ses("sun", "ride", 120)],
});

const output: DraftModelOutput = {
  name: "Test plan",
  why: "Because.",
  assumptions: ["Pool twice a week"],
  weeks: [week("Base", 50), week("Base", 55), week("Recovery", 40), week("Build", 60)],
};

describe("draftToModelOutput", () => {
  it("turns an expanded draft back into weeks that expand to the same plan", () => {
    const draft = expandDraft(output, request);
    const back = draftToModelOutput(draft);
    expect(back.weeks).toHaveLength(4);
    expect(back.weeks[0].sessions.map((s) => s.day)).toEqual(["wed", "thu", "sat", "sun"]);
    expect(back.weeks[3].focus).toBe("Build week");
    expect(expandDraft(back, request).plan).toEqual(draft.plan);
  });

  it("keeps a week the start date cut short, and an empty week, in place", () => {
    const sparse: DraftModelOutput = { ...output, weeks: [{ phase: "Base", focus: "", sessions: [ses("mon", "run", 30)] }, week("Base", 50)] };
    const draft = expandDraft(sparse, request); // Monday is before the start, so week 1 is empty
    const back = draftToModelOutput(draft);
    expect(back.weeks).toHaveLength(2);
    expect(back.weeks[0].sessions).toEqual([]);
    expect(back.weeks[1].sessions).toHaveLength(4);
  });
});

describe("mergeRevision", () => {
  const current = draftToModelOutput(expandDraft(output, request));

  it("replaces only the weeks the coach returned and reports which changed", () => {
    const { merged, changedWeeks } = mergeRevision(current, {
      why: "More running.",
      assumptions: [],
      weeks: [
        { week: 2, ...week("Base", 70) },
        { week: 4, ...current.weeks[3] }, // returned but identical: not a change
      ],
    });
    expect(changedWeeks).toEqual([2]);
    expect(merged.weeks[0]).toEqual(current.weeks[0]);
    expect(merged.weeks[1].sessions.find((s) => s.discipline === "run")?.durationMin).toBe(70);
    expect(merged.why).toBe("More running.");
    expect(merged.assumptions).toEqual(current.assumptions); // none returned: kept
  });

  it("ignores week numbers outside the plan, so a revision can't change its length", () => {
    const { merged, changedWeeks } = mergeRevision(current, {
      why: "",
      assumptions: [],
      weeks: [{ week: 0, ...week("Base", 90) }, { week: 5, ...week("Base", 90) }],
    });
    expect(changedWeeks).toEqual([]);
    expect(merged.weeks).toEqual(current.weeks);
    expect(merged.why).toBe(current.why);
  });

  it("still drops sessions on blocked days when the merged plan is expanded", () => {
    const { merged } = mergeRevision(current, {
      why: "",
      assumptions: [],
      weeks: [{ week: 2, phase: "Base", focus: "", sessions: [ses("fri", "run", 40), ses("sat", "run", 60)] }],
    });
    const draft = expandDraft(merged, request);
    expect(draft.dropped).toBe(1);
    expect(draft.weekFocus[1]).toBe("Base week"); // empty focus keeps the old one
  });
});

describe("summarizeRevision", () => {
  it("totals each sport before and after and keeps the old weekly totals", () => {
    const before = expandDraft(output, request);
    const { merged, changedWeeks } = mergeRevision(draftToModelOutput(before), {
      why: "",
      assumptions: [],
      weeks: [{ week: 4, ...week("Build", 90) }],
    });
    const beforeStats = draftStats(before, []);
    const afterStats = draftStats(expandDraft(merged, request), []);
    const s = summarizeRevision(
      { feedback: "More running", insisted: false, stance: "agree", message: "Fine.", changedWeeks },
      beforeStats.weeks,
      afterStats.weeks,
    );
    expect(s.minutes.after.run - s.minutes.before.run).toBe(30);
    expect(s.minutes.after.ride).toBe(s.minutes.before.ride);
    expect(s.previousWeekMin).toEqual(beforeStats.weeks.map((w) => w.totalMin));
  });
});

describe("parseRevisionRequest", () => {
  it("trims the feedback", () => {
    expect(parseRevisionRequest({ feedback: "  more running " })).toEqual({ feedback: "more running" });
  });

  it("refuses empty and over-long feedback", () => {
    expect(() => parseRevisionRequest({ feedback: "  " })).toThrow(/what you'd like/);
    expect(() => parseRevisionRequest({ feedback: "x".repeat(601) })).toThrow(/under 600/);
  });
});
