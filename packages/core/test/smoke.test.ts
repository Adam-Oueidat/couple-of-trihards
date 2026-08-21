import { describe, expect, it } from "vitest";
import { getDiscipline, SEED_PLAN, type StravaActivity } from "../src";

describe("@trihards/core smoke", () => {
  it("classifies disciplines", () => {
    const stub = { sport_type: "Run", type: "Run" } as unknown as StravaActivity;
    expect(getDiscipline(stub)).toBe("run");
  });

  it("loads the bundled seed plan used by the one-time backfill", () => {
    expect(SEED_PLAN.sessions.length).toBeGreaterThan(0);
  });
});
