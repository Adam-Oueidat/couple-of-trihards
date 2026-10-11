import { describe, expect, it } from "vitest";
import { COACH_SYSTEM_PROMPT } from "./coach";
import { formatCoachingMemory, formatTranscript } from "./coach-memory";

describe("formatCoachingMemory", () => {
  it("is null when there is nothing to remember", () => {
    expect(formatCoachingMemory([], "2026-10-11")).toBeNull();
  });

  it("stamps each chat with its weekday, date and distance from today", () => {
    const text = formatCoachingMemory(
      [{ date: "2026-10-09", kind: "recap", text: "Agreed Friday was a rest day." }],
      "2026-10-11",
    );
    expect(text).toContain("### Chat on Friday 2026-10-09 (2 days ago) — recap");
    expect(text).toContain("Agreed Friday was a rest day.");
  });

  it("orders chats oldest first and marks one still open today", () => {
    const text = formatCoachingMemory(
      [
        { date: "2026-10-11", kind: "transcript", text: "Athlete: legs feel fine" },
        { date: "2026-10-10", kind: "recap", text: "Easy ride planned." },
      ],
      "2026-10-11",
    )!;
    expect(text.indexOf("2026-10-10 (yesterday)")).toBeLessThan(
      text.indexOf("2026-10-11 (today)"),
    );
    expect(text).toContain("still open, quoted as it stands");
  });
});

describe("formatTranscript", () => {
  it("labels the two sides", () => {
    expect(
      formatTranscript([
        { role: "user", content: "I rested on Friday" },
        { role: "assistant", content: "Good, that counts." },
      ]),
    ).toBe("Athlete: I rested on Friday\nCoach: Good, that counts.");
  });

  it("drops the oldest turns first when over budget", () => {
    const text = formatTranscript(
      [
        { role: "user", content: "a".repeat(80) },
        { role: "assistant", content: "b".repeat(80) },
        { role: "user", content: "latest" },
      ],
      120,
    );
    expect(text).not.toContain("aaa");
    expect(text.endsWith("Athlete: latest")).toBe(true);
  });

  it("keeps the newest turn even when it alone exceeds the budget", () => {
    expect(formatTranscript([{ role: "user", content: "x".repeat(50) }], 10)).toContain("xxx");
  });

  it("clips a long turn from the middle, keeping how it ended", () => {
    const text = formatTranscript(
      [{ role: "assistant", content: `START${"-".repeat(500)}so Friday stays a rest day` }],
      6000,
      90,
    );
    expect(text).toContain("START");
    expect(text).toContain("[...]");
    expect(text.endsWith("so Friday stays a rest day")).toBe(true);
  });
});

// The memory section is inert unless the prompt says what it is for: both that
// it is history, and that what was agreed in it binds later advice.
describe("COACH_SYSTEM_PROMPT and chat memory", () => {
  it("treats settled chat decisions as standing", () => {
    expect(COACH_SYSTEM_PROMPT).toContain("still stands");
    expect(COACH_SYSTEM_PROMPT).toMatch(/activity analysis alike/);
  });

  it("still forbids reading the current date from memory", () => {
    expect(COACH_SYSTEM_PROMPT).toMatch(/never read today's date/i);
  });
});
