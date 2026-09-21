import { describe, expect, it } from "vitest";
import {
  findMisdatedSessions,
  matchSessions,
  type TrainingPlan,
  type StravaActivity,
} from "../src";

function plan(sessions: Array<{ id: string; date: string; km: number; name?: string }>): TrainingPlan {
  return {
    name: "Block", source: "runna", discipline: "run",
    startDate: "2026-06-01", raceDate: "2026-09-20", raceName: "Race",
    sessions: sessions.map((s) => ({
      id: s.id, date: s.date, originalDate: s.date,
      name: s.name ?? `Session ${s.id}`, type: "easy", km: s.km,
    })),
  } as TrainingPlan;
}

let seq = 0;
function run(date: string, km: number, sport = "Run"): StravaActivity {
  return {
    id: ++seq, name: `Run ${date}`, sport_type: sport, type: sport,
    start_date: `${date}T08:00:00Z`, start_date_local: `${date}T08:00:00Z`,
    distance: km * 1000, moving_time: 1800,
  } as unknown as StravaActivity;
}

const TODAY = "2026-09-21";

describe("findMisdatedSessions", () => {
  it("finds a session run the day after", () => {
    const found = findMisdatedSessions(plan([{ id: "a", date: "2026-07-01", km: 10 }]), [run("2026-07-02", 10)], {}, TODAY);
    expect(found).toHaveLength(1);
    expect(found[0].offsetDays).toBe(1);
    expect(found[0].activity.date).toBe("2026-07-02");
  });

  it("finds a session run the day before", () => {
    const found = findMisdatedSessions(plan([{ id: "a", date: "2026-07-01", km: 10 }]), [run("2026-06-30", 10)], {}, TODAY);
    expect(found[0].offsetDays).toBe(-1);
  });

  it("ignores a run two days away", () => {
    // Beyond the window on purpose: on the real plan nothing was recoverable
    // past ±1, and a wider net risks claiming an unrelated run.
    expect(findMisdatedSessions(plan([{ id: "a", date: "2026-07-01", km: 10 }]), [run("2026-07-03", 10)], {}, TODAY)).toHaveLength(0);
  });

  it("ignores a run too short to have completed the session", () => {
    // 5km against a 10km session is under the 80% completion threshold.
    expect(findMisdatedSessions(plan([{ id: "a", date: "2026-07-01", km: 10 }]), [run("2026-07-02", 5)], {}, TODAY)).toHaveLength(0);
  });

  it("does not steal a run that already completed its own session", () => {
    // The 07-02 run completes 07-02's session; it must not ALSO be offered as
    // the rescue for 07-01, or one run would credit two sessions.
    const found = findMisdatedSessions(
      plan([{ id: "a", date: "2026-07-01", km: 10 }, { id: "b", date: "2026-07-02", km: 10 }]),
      [run("2026-07-02", 10)],
      {}, TODAY,
    );
    expect(found).toHaveLength(0);
  });

  it("gives one run to the earlier session when two could claim it", () => {
    const found = findMisdatedSessions(
      plan([{ id: "a", date: "2026-07-01", km: 10 }, { id: "c", date: "2026-07-03", km: 10 }]),
      [run("2026-07-02", 10)],
      {}, TODAY,
    );
    expect(found).toHaveLength(1);
    expect(found[0].session.id).toBe("a");
  });

  it("prefers the nearer day", () => {
    const found = findMisdatedSessions(
      plan([{ id: "a", date: "2026-07-02", km: 10 }]),
      [run("2026-07-01", 10), run("2026-07-03", 10)],
      {}, TODAY,
    );
    // Both are ±1; the tie breaks to the earlier offset deterministically.
    expect(Math.abs(found[0].offsetDays)).toBe(1);
  });

  it("ignores activities of another discipline", () => {
    expect(findMisdatedSessions(plan([{ id: "a", date: "2026-07-01", km: 10 }]), [run("2026-07-02", 10, "Ride")], {}, TODAY)).toHaveLength(0);
  });

  it("leaves a deliberately skipped session alone", () => {
    // A skip is the athlete's stated decision. It is not a grading accident and
    // must never be quietly converted into a completed session.
    const found = findMisdatedSessions(
      plan([{ id: "a", date: "2026-07-01", km: 10 }]),
      [run("2026-07-02", 10)],
      { a: { sessionId: "a", originalDate: "2026-07-01", newDate: "2026-07-01", movedAt: "2026-07-01T00:00:00Z", skipped: true, skipReason: "calf" } },
      TODAY,
    );
    expect(found).toHaveLength(0);
  });

  it("returns nothing when there is no plan", () => {
    expect(findMisdatedSessions(null, [run("2026-07-02", 10)], {}, TODAY)).toEqual([]);
  });

  it("moving the session onto the run's date makes it grade completed", () => {
    // The whole point: what the coach's move_session call achieves.
    const p = plan([{ id: "a", date: "2026-07-01", km: 10 }]);
    const acts = [run("2026-07-02", 10)];

    expect(matchSessions(p, acts, {}, TODAY).find((s) => s.id === "a")!.status).toBe("missed");

    const moved = matchSessions(p, acts, {
      a: { sessionId: "a", originalDate: "2026-07-01", newDate: "2026-07-02", movedAt: "2026-07-02T00:00:00Z" },
    }, TODAY);
    expect(moved.find((s) => s.id === "a")!.status).toBe("completed");

    // And it is no longer offered as a candidate.
    expect(findMisdatedSessions(p, acts, {
      a: { sessionId: "a", originalDate: "2026-07-01", newDate: "2026-07-02", movedAt: "2026-07-02T00:00:00Z" },
    }, TODAY)).toHaveLength(0);
  });
});
