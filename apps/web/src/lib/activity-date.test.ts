import { describe, expect, it } from "vitest";
import { activityLocalDate } from "./activity-date";

describe("activityLocalDate", () => {
  it("keeps the wall-clock calendar day from start_date_local's date part", () => {
    // A Sunday-evening activity: start_date_local is wall-clock time with a
    // misleading trailing "Z". The displayed day must stay June 28, not roll to
    // June 29 the way `new Date(start_date_local)` + toLocaleDateString would.
    const d = activityLocalDate("2026-06-28T20:30:00Z");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5); // June (0-indexed)
    expect(d.getDate()).toBe(28);
  });

  it("anchors at local noon so it never rolls across midnight", () => {
    const d = activityLocalDate("2026-06-28T00:05:00Z");
    expect(d.getHours()).toBe(12);
    expect(d.getDate()).toBe(28);
  });
});
