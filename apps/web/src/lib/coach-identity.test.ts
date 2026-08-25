import { describe, expect, it } from "vitest";
import { COACH_SYSTEM_PROMPT } from "./coach";

// The identity block is assembled inside buildTrainingContext, which needs a
// database and a live Strava session. What is worth pinning here is the
// contract the block relies on: the system prompt must actually tell the model
// what to do with an "# Athlete" section, or the block is inert text.

describe("COACH_SYSTEM_PROMPT", () => {
  it("directs the coach to the athlete identity section", () => {
    expect(COACH_SYSTEM_PROMPT).toContain('"Athlete" section');
  });

  it("forbids guessing a name when the profile is unavailable", () => {
    expect(COACH_SYSTEM_PROMPT).toMatch(/never guess a name/i);
  });

  it("still refuses to invent plan details", () => {
    // Guards the pre-existing no-default-plan rule against edits to the
    // guidelines list above it.
    expect(COACH_SYSTEM_PROMPT).toContain("if it says NONE");
  });
});
