import { describe, expect, it } from "vitest";
import type { StravaActivity } from "@trihards/core";
import { ownsActivityIn } from "./activity-access";

function activity(id: number): StravaActivity {
  return { id, name: `Activity ${id}` } as StravaActivity;
}

describe("ownsActivityIn", () => {
  const mine = [activity(1), activity(22), activity(333)];

  it("accepts an activity in the caller's own list", () => {
    expect(ownsActivityIn(mine, 22)).toBe(true);
  });

  it("rejects an id that belongs to someone else", () => {
    expect(ownsActivityIn(mine, 999)).toBe(false);
  });

  it("rejects every id when the caller has no activities", () => {
    expect(ownsActivityIn([], 1)).toBe(false);
  });

  it("does not match on string coercion", () => {
    // Guards against a `==` regression: "22" must not pass as 22.
    expect(ownsActivityIn(mine, "22" as unknown as number)).toBe(false);
  });
});
