import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StravaActivity } from "@trihards/core";
import {
  daysBetween,
  epochOfDate,
  formatResolvedNow,
  isValidTimeZone,
  localDateOf,
  resolveNow,
  resolveToday,
  yearStartOf,
} from "./coach-dates";

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

  describe("against a fixed clock", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-06-22T23:30:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("uses the client timezone when no client date was sent", () => {
      expect(resolveToday(undefined, [], "Europe/Copenhagen")).toBe("2026-06-23");
      expect(resolveToday(undefined, [], "America/New_York")).toBe("2026-06-22");
    });

    it("still prefers the client date over the timezone", () => {
      expect(resolveToday("2026-06-22", [], "Pacific/Kiritimati")).toBe("2026-06-22");
    });

    it("ignores an invalid timezone and falls through to the old chain", () => {
      const acts = [activity("2026-06-20T08:00:00Z", "2026-06-20T10:00:00Z")];
      expect(resolveToday(undefined, acts, "Mars/Olympus_Mons")).toBe("2026-06-23");
      expect(resolveToday(undefined, [], "Mars/Olympus_Mons")).toBe("2026-06-22");
    });
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

describe("yearStartOf", () => {
  it("returns Jan 1 of the year the date falls in", () => {
    expect(yearStartOf("2026-08-21")).toBe("2026-01-01");
    expect(yearStartOf("2026-01-01")).toBe("2026-01-01");
    expect(yearStartOf("2025-12-31")).toBe("2025-01-01");
  });

  it("orders lexically against ISO dates, so it works as a YTD filter", () => {
    const yearStart = yearStartOf("2026-08-21");
    expect("2026-08-02" >= yearStart).toBe(true);
    expect("2026-01-01" >= yearStart).toBe(true);
    expect("2025-12-31" >= yearStart).toBe(false);
  });
});

describe("resolveNow", () => {
  // Every case pins `now`, so none of these depend on the wall clock.
  const cest = [activity("2026-06-20T08:00:00Z", "2026-06-20T10:00:00Z")];

  it("reports date, time and day of week from an explicit IANA timezone", () => {
    const now = resolveNow({
      activities: [],
      timezone: "Europe/Copenhagen",
      now: Date.parse("2026-06-22T23:30:00Z"),
    });
    expect(now).toEqual({
      date: "2026-06-23",
      time: "01:30",
      dayOfWeek: "Tuesday",
      timezone: "Europe/Copenhagen",
      utc: "2026-06-22T23:30:00.000Z",
      source: "client-timezone",
    });
  });

  it("follows DST within a zone rather than a fixed offset", () => {
    // US DST begins 2026-03-08 at 02:00 local: 06:00Z is still EST (-5),
    // 12:00Z is already EDT (-4).
    const before = resolveNow({
      activities: [],
      timezone: "America/New_York",
      now: Date.parse("2026-03-08T06:00:00Z"),
    });
    const after = resolveNow({
      activities: [],
      timezone: "America/New_York",
      now: Date.parse("2026-03-08T12:00:00Z"),
    });
    expect(before.time).toBe("01:00");
    expect(after.time).toBe("08:00");
    expect(after.date).toBe("2026-03-08");
  });

  it("handles half-hour zones and the midnight hour", () => {
    const now = resolveNow({
      activities: [],
      timezone: "Asia/Kolkata",
      now: Date.parse("2026-06-22T18:35:00Z"),
    });
    expect(now.date).toBe("2026-06-23");
    expect(now.time).toBe("00:05");
  });

  it("falls back to the activity offset when the timezone is invalid", () => {
    const now = resolveNow({
      activities: cest,
      timezone: "Mars/Olympus_Mons",
      now: Date.parse("2026-06-22T23:00:00Z"),
    });
    expect(now).toMatchObject({
      date: "2026-06-23",
      time: "01:00",
      dayOfWeek: "Tuesday",
      timezone: "UTC+02:00",
      source: "activity-offset",
    });
  });

  it("falls back to server UTC when there is no timezone and no activity", () => {
    const now = resolveNow({
      activities: [],
      now: Date.parse("2026-06-22T23:00:00Z"),
    });
    expect(now).toMatchObject({
      date: "2026-06-22",
      time: "23:00",
      timezone: "UTC",
      source: "server-utc",
    });
  });

  it("labels a negative offset correctly", () => {
    const now = resolveNow({
      activities: [activity("2026-06-20T15:00:00Z", "2026-06-20T09:30:00Z")],
      now: Date.parse("2026-06-22T12:00:00Z"),
    });
    expect(now.timezone).toBe("UTC-05:30");
    expect(now.time).toBe("06:30");
  });

  it("prefers the client's calendar date over a stale offset, keeping its time", () => {
    // Offset-derived day is the 23rd; the browser says it is still the 22nd.
    const now = resolveNow({
      activities: cest,
      clientToday: "2026-06-22",
      now: Date.parse("2026-06-22T23:00:00Z"),
    });
    expect(now).toMatchObject({
      date: "2026-06-22",
      dayOfWeek: "Monday",
      time: "01:00",
      source: "client-date",
    });
  });

  it("keeps the offset source when the client date agrees with it", () => {
    const now = resolveNow({
      activities: cest,
      clientToday: "2026-06-23",
      now: Date.parse("2026-06-22T23:00:00Z"),
    });
    expect(now.source).toBe("activity-offset");
  });

  it("ignores a malformed client date", () => {
    const now = resolveNow({
      activities: [],
      clientToday: "yesterday",
      now: Date.parse("2026-06-22T23:00:00Z"),
    });
    expect(now.date).toBe("2026-06-22");
    expect(now.source).toBe("server-utc");
  });

  it("outranks a client date with a real timezone", () => {
    const now = resolveNow({
      activities: [],
      timezone: "Europe/Copenhagen",
      clientToday: "2026-06-22",
      now: Date.parse("2026-06-22T23:30:00Z"),
    });
    expect(now.date).toBe("2026-06-23");
    expect(now.source).toBe("client-timezone");
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA zone names and rejects anything else", () => {
    expect(isValidTimeZone("Europe/Copenhagen")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    // Intl also accepts fixed-offset identifiers; they are a valid (if
    // DST-blind) answer, so we take them rather than falling back.
    expect(isValidTimeZone("+02:00")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("Europe/Kopenhagen")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone("A".repeat(200))).toBe(false);
  });
});

describe("formatResolvedNow", () => {
  it("states the date, time and how it was resolved", () => {
    const text = formatResolvedNow(
      resolveNow({
        activities: [],
        timezone: "Europe/Copenhagen",
        now: Date.parse("2026-06-22T23:30:00Z"),
      }),
    );
    expect(text).toContain("Current date: 2026-06-23 (Tuesday)");
    expect(text).toContain("Current local time: 01:30 (Europe/Copenhagen)");
    expect(text).toContain("UTC instant: 2026-06-22T23:30:00.000Z");
    expect(text).toContain("Source: the athlete's device timezone (exact)");
  });

  it("flags a UTC-only clock as unreliable for local time", () => {
    const text = formatResolvedNow(
      resolveNow({ activities: [], now: Date.parse("2026-06-22T23:30:00Z") }),
    );
    expect(text).toContain("no timezone signal was available");
  });
});

describe("daysBetween", () => {
  it("counts whole days forward and backward, across a DST change", () => {
    expect(daysBetween("2026-06-22", "2026-06-25")).toBe(3);
    expect(daysBetween("2026-06-22", "2026-06-22")).toBe(0);
    expect(daysBetween("2026-06-25", "2026-06-22")).toBe(-3);
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
  });
});

describe("epochOfDate", () => {
  it("is midnight UTC of the given day", () => {
    expect(epochOfDate("2026-01-01")).toBe(Date.parse("2026-01-01T00:00:00Z") / 1000);
  });

  it("places an activity from earlier that year before the boundary", () => {
    const boundary = epochOfDate("2026-01-01");
    expect(Date.parse("2025-11-04T09:00:00Z") / 1000).toBeLessThan(boundary);
    expect(Date.parse("2026-03-04T09:00:00Z") / 1000).toBeGreaterThan(boundary);
  });
});
