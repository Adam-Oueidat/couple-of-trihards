import { describe, expect, it } from "vitest";
import { matchSessions, daysUntilRace, plan, type StravaActivity } from "../src";

// Regression: "today" used to be computed with toISOString() (UTC). For an
// athlete in a negative-offset timezone on Sunday evening, the UTC clock has
// already rolled to Monday, so the Sunday session was flagged "missed" and
// Monday's "today" a day early. matchSessions now takes an explicit local date.

function firstSession() {
  // Use real plan dates so the test exercises the same data the app does.
  return plan.sessions[0];
}

describe("matchSessions today handling", () => {
  it("labels the passed-in local date as 'today', not the UTC date", () => {
    const s = firstSession();
    const result = matchSessions([], undefined, s.date);
    const matched = result.find((r) => r.id === s.id)!;
    expect(matched.status).toBe("today");
  });

  it("flags a session in the past as 'missed' and a later one as 'upcoming'", () => {
    const [a, b] = plan.sessions;
    // Pretend "today" is the first session's day: it is today, the next is upcoming.
    const result = matchSessions([], undefined, a.date);
    expect(result.find((r) => r.id === a.id)!.status).toBe("today");
    expect(result.find((r) => r.id === b.id)!.status).toBe("upcoming");

    // Pretend "today" is the second session's day: the first is now missed.
    const later = matchSessions([], undefined, b.date);
    expect(later.find((r) => r.id === a.id)!.status).toBe("missed");
  });

  it("does not flag a completed Sunday session as missed when local 'today' is Monday", () => {
    // The reported bug: activity on Sunday, app thinks it is Monday. The session
    // has a matching run, so it must read 'completed' regardless of the date math.
    const s = firstSession();
    const act = {
      sport_type: "Run",
      type: "Run",
      start_date_local: `${s.date}T08:00:00Z`,
      moving_time: 3600,
      distance: s.km * 1000,
    } as unknown as StravaActivity;

    const nextDay = new Date(s.date + "T12:00:00Z");
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const today = nextDay.toISOString().split("T")[0];

    const result = matchSessions([act], undefined, today);
    expect(result.find((r) => r.id === s.id)!.status).toBe("completed");
  });
});

describe("daysUntilRace", () => {
  it("counts whole days from the given local date to the race", () => {
    const race = new Date(plan.raceDate + "T12:00:00");
    const tenBefore = new Date(race);
    tenBefore.setDate(tenBefore.getDate() - 10);
    const today = `${tenBefore.getFullYear()}-${String(
      tenBefore.getMonth() + 1,
    ).padStart(2, "0")}-${String(tenBefore.getDate()).padStart(2, "0")}`;
    expect(daysUntilRace(today)).toBe(10);
  });

  it("never goes negative once the race has passed", () => {
    expect(daysUntilRace("2099-01-01")).toBe(0);
  });
});
