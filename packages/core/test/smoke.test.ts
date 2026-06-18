import { describe, expect, it } from "vitest";
import { getDiscipline, plan, type StravaActivity } from "../src";

describe("@trihards/core smoke", () => {
  it("classifies disciplines", () => {
    const stub = { sport_type: "Run", type: "Run" } as unknown as StravaActivity;
    expect(getDiscipline(stub)).toBe("run");
  });

  it("loads the bundled training plan", () => {
    expect(plan.sessions.length).toBeGreaterThan(0);
  });
});
