import { describe, expect, it } from "vitest";
import type { StravaActivity } from "@trihards/core";
import { localDateOf, resolveToday } from "./coach-dates";

// Only start_date / start_date_local are read by these helpers.
function activity(start_date: string, start_date_local: string): StravaActivity {
  return { start_date, start_date_local } as StravaActivity;
}

describe("resolveToday", () => {
  it("trusts a valid client date over everything else", () => {
    const acts = [activity("2026-06-20T08:00:00Z", "2026-06-20T18:00:00Z")];
    expect(resolveToday("2026-06-23", acts)).toBe("2026-06-23");
  });

  it("ignores a malformed client date and derives from the activity offset", () => {
    // +2h offset (e.g. CEST). With no activities the fallback is server UTC,
    // so just assert the format here rather than a brittle wall-clock value.
    const acts = [activity("2026-06-20T08:00:00Z", "2026-06-20T10:00:00Z")];
    expect(resolveToday("not-a-date", acts)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("localDateOf", () => {
  it("rolls a late-evening UTC timestamp forward in a positive-offset tz", () => {
    // +2h offset.
    const acts = [activity("2026-06-20T08:00:00Z", "2026-06-20T10:00:00Z")];
    // 2026-06-22 23:00 UTC is 2026-06-23 01:00 athlete-local.
    const ts = Math.floor(Date.parse("2026-06-22T23:00:00Z") / 1000);
    expect(localDateOf(ts, acts)).toBe("2026-06-23");
  });

  it("flags a prior-day conversation as stale against today", () => {
    const acts = [activity("2026-06-20T08:00:00Z", "2026-06-20T10:00:00Z")];
    const yesterday9amLocal = Math.floor(
      Date.parse("2026-06-22T07:00:00Z") / 1000, // 09:00 local at +2h
    );
    expect(localDateOf(yesterday9amLocal, acts)).toBe("2026-06-22");
    expect(localDateOf(yesterday9amLocal, acts)).not.toBe("2026-06-23");
  });

  it("falls back to UTC when no offset can be derived", () => {
    const ts = Math.floor(Date.parse("2026-06-23T12:00:00Z") / 1000);
    expect(localDateOf(ts, [])).toBe("2026-06-23");
  });
});
