import { describe, expect, it } from "vitest";
import {
  BLOCK_DAYS,
  BLOCK_WEEKS,
  adherencePct,
  buildBlockRecap,
  buildPlanRecap,
  calcTrainingLoad,
  readBlock,
  readPlan,
  timeShare,
  type StravaActivity,
  type TrainingLoadPoint,
  type TrainingPlan,
} from "../src";

const TODAY = "2026-09-21";

function day(offsetFromToday: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetFromToday);
  return d.toISOString().split("T")[0];
}

let nextId = 1;

function activity(
  date: string,
  sport: "Run" | "Ride" | "Swim",
  km: number,
  minutes: number,
): StravaActivity {
  return {
    id: nextId++,
    name: `${sport} ${date}`,
    sport_type: sport,
    type: sport,
    start_date: `${date}T08:00:00Z`,
    start_date_local: `${date}T08:00:00Z`,
    distance: km * 1000,
    moving_time: minutes * 60,
    total_elevation_gain: 10,
  } as unknown as StravaActivity;
}

/** A flat CTL/ATL series, so fitness assertions are about the recap's reading
 *  of the series rather than about calcTrainingLoad's arithmetic. */
function loadSeries(
  from: number,
  to: number,
  point: (date: string, i: number) => Partial<TrainingLoadPoint>,
): TrainingLoadPoint[] {
  const points: TrainingLoadPoint[] = [];
  for (let i = from; i <= to; i++) {
    const date = day(i);
    points.push({ date, atl: 0, ctl: 0, tsb: 0, dailyTSS: 0, ...point(date, i - from) });
  }
  return points;
}

describe("buildBlockRecap", () => {
  it("covers exactly six weeks back from today, and the six before that", () => {
    const recap = buildBlockRecap([], [], TODAY);
    expect(recap.end).toBe(TODAY);
    expect(recap.start).toBe(day(-(BLOCK_DAYS - 1)));
    expect(recap.priorEnd).toBe(day(-BLOCK_DAYS));
    expect(recap.priorStart).toBe(day(-(BLOCK_DAYS * 2 - 1)));
    expect(recap.daily).toHaveLength(BLOCK_DAYS);
    expect(recap.weekly).toHaveLength(BLOCK_WEEKS);
  });

  it("excludes the day before the window and includes today", () => {
    const acts = [
      activity(day(-BLOCK_DAYS), "Run", 10, 60), // one day too early
      activity(TODAY, "Run", 5, 30),
    ];
    const recap = buildBlockRecap(acts, [], TODAY);
    expect(recap.totals.sessions).toBe(1);
    expect(recap.prior.sessions).toBe(1);
    expect(recap.daily[BLOCK_DAYS - 1].sessions).toBe(1);
  });

  it("splits volume by discipline and keeps swim in km", () => {
    const acts = [
      activity(day(-3), "Swim", 2, 40),
      activity(day(-2), "Ride", 40, 80),
      activity(day(-1), "Run", 10, 50),
    ];
    const recap = buildBlockRecap(acts, [], TODAY);
    expect(recap.totals.byDiscipline.swim).toMatchObject({ km: 2, minutes: 40, sessions: 1 });
    expect(recap.totals.byDiscipline.ride).toMatchObject({ km: 40, minutes: 80 });
    expect(recap.totals.byDiscipline.run).toMatchObject({ km: 10, minutes: 50 });
    expect(recap.totals.minutes).toBe(170);
    expect(timeShare(recap.totals)).toEqual({ swim: 24, ride: 47, run: 29 });
  });

  it("ignores activities that are not one of the three disciplines", () => {
    const walk = { ...activity(day(-1), "Run", 5, 30), sport_type: "Walk", type: "Walk" };
    const recap = buildBlockRecap([walk as StravaActivity], [], TODAY);
    expect(recap.totals.sessions).toBe(0);
    expect(recap.daily[BLOCK_DAYS - 2].dominant).toBeNull();
  });

  it("picks the day's dominant discipline by time, not by distance", () => {
    // The ride covers far more ground; the swim took longer. A day is named by
    // where the time went.
    const acts = [activity(day(-1), "Ride", 30, 20), activity(day(-1), "Swim", 2, 60)];
    const recap = buildBlockRecap(acts, [], TODAY);
    const yesterday = recap.daily[BLOCK_DAYS - 2];
    expect(yesterday.dominant).toBe("swim");
    expect(yesterday.sessions).toBe(2);
  });

  it("measures the longest rest gap and the longest training streak", () => {
    // Train the first three days of the window, rest six, train the rest.
    const acts = [
      ...[0, 1, 2].map((i) => activity(day(-(BLOCK_DAYS - 1) + i), "Run", 5, 30)),
      ...[9, 10].map((i) => activity(day(-(BLOCK_DAYS - 1) + i), "Run", 5, 30)),
    ];
    const recap = buildBlockRecap(acts, [], TODAY);
    expect(recap.longestStreak).toBe(3);
    expect(recap.longestGap).toBe(BLOCK_DAYS - 11); // the tail after the last session
    expect(recap.daysTrained).toBe(5);
  });

  it("reads fitness from the day before the window, so the ramp is the block's own", () => {
    // CTL 20 entering the block, 50 leaving it: 30 points over six weeks.
    const load = loadSeries(-BLOCK_DAYS * 2, 0, (_d, i) => ({
      ctl: i <= BLOCK_DAYS ? 20 : 20 + (i - BLOCK_DAYS) * (30 / BLOCK_DAYS),
      atl: 40,
      tsb: -10,
    }));
    const recap = buildBlockRecap([], load, TODAY);
    expect(recap.fitness?.ctlStart).toBe(20);
    expect(recap.fitness?.ctlEnd).toBe(50);
    expect(recap.fitness?.rampPerWeek).toBe(5);
    expect(recap.fitness?.tsbEnd).toBe(-10);
  });

  it("has no fitness reading at all when there is no load history", () => {
    expect(buildBlockRecap([], [], TODAY).fitness).toBeNull();
  });

  it("names the biggest week and the longest single session", () => {
    const acts = [
      activity(day(-(BLOCK_DAYS - 1)), "Run", 8, 45),
      activity(day(-3), "Ride", 60, 150),
      activity(day(-2), "Run", 20, 110),
    ];
    const recap = buildBlockRecap(acts, [], TODAY);
    expect(recap.biggestWeek?.start).toBe(recap.weekly[BLOCK_WEEKS - 1].start);
    expect(recap.longestSession).toMatchObject({ minutes: 150, discipline: "ride" });
  });

  it("survives a DST transition without losing or duplicating a day", () => {
    // Europe's clocks go back on 2026-10-25; a local-time day walk drifts here.
    const recap = buildBlockRecap([], [], "2026-11-15");
    expect(recap.daily).toHaveLength(BLOCK_DAYS);
    expect(new Set(recap.daily.map((d) => d.date)).size).toBe(BLOCK_DAYS);
    expect(recap.daily[0].date).toBe("2026-10-05");
  });
});

describe("readBlock", () => {
  const consistent = Array.from({ length: BLOCK_DAYS }, (_, i) =>
    i % 3 === 0 ? null : activity(day(-(BLOCK_DAYS - 1) + i), "Run", 8, 45),
  ).filter((a): a is StravaActivity => a !== null);

  function withRamp(ctlEnd: number): TrainingLoadPoint[] {
    return loadSeries(-BLOCK_DAYS * 2, 0, (_d, i) => ({
      ctl: i <= BLOCK_DAYS ? 20 : 20 + ((i - BLOCK_DAYS) * (ctlEnd - 20)) / BLOCK_DAYS,
      atl: 25,
      tsb: -5,
    }));
  }

  it("says so plainly when the window is empty", () => {
    const insights = readBlock(buildBlockRecap([], [], TODAY));
    expect(insights).toHaveLength(1);
    expect(insights[0].id).toBe("empty");
  });

  it("flags a ramp past the 5-a-week guardrail", () => {
    const recap = buildBlockRecap(consistent, withRamp(20 + 6 * BLOCK_WEEKS), TODAY);
    const ramp = readBlock(recap).find((i) => i.id.startsWith("ramp"));
    expect(ramp?.id).toBe("ramp-fast");
    expect(ramp?.tone).toBe("warn");
  });

  it("escalates a very steep ramp to an error", () => {
    const recap = buildBlockRecap(consistent, withRamp(20 + 9 * BLOCK_WEEKS), TODAY);
    expect(readBlock(recap).find((i) => i.id.startsWith("ramp"))?.id).toBe("ramp-steep");
  });

  it("calls a healthy build a build", () => {
    const recap = buildBlockRecap(consistent, withRamp(20 + 3 * BLOCK_WEEKS), TODAY);
    const ramp = readBlock(recap).find((i) => i.id.startsWith("ramp"));
    expect(ramp?.id).toBe("ramp-steady");
    expect(ramp?.tone).toBe("ok");
  });

  it("ranks the most serious finding first", () => {
    const load = loadSeries(-BLOCK_DAYS * 2, 0, (_d, i) => ({
      ctl: 20 + i * 0.1,
      atl: 60,
      tsb: i === BLOCK_DAYS * 2 ? -30 : -10,
    }));
    const insights = readBlock(buildBlockRecap(consistent, load, TODAY));
    expect(insights[0].tone).toBe("err");
    expect(insights[0].id).toBe("form-buried");
  });

  it("calls an eight-point decline a decline, not a flat block", () => {
    // Real data caught this: CTL 77 -> 69 is -1.3 a week, which rounds to
    // "barely moving" and used to read as flat — while the athlete had lost
    // eight points of fitness over six weeks.
    const recap = buildBlockRecap(consistent, withRamp(12), TODAY);
    const ramp = readBlock(recap).find((i) => i.id.startsWith("ramp"));
    expect(ramp?.id).toBe("ramp-down");
    expect(ramp?.headline).toBe("Fitness down 8 points");
  });

  it("only calls a block flat when it genuinely went nowhere", () => {
    const recap = buildBlockRecap(consistent, withRamp(22), TODAY);
    expect(readBlock(recap).find((i) => i.id.startsWith("ramp"))?.id).toBe("ramp-flat");
  });

  it("flags a discipline that shrank to a sliver, not only one that hit zero", () => {
    const acts = [
      // Previous block: five swims. This block: one, and a lot of running.
      ...[0, 2, 4, 6, 8].map((i) => activity(day(-(BLOCK_DAYS * 2 - 1) + i), "Swim", 2, 45)),
      activity(day(-10), "Swim", 1, 25),
      ...consistent,
    ];
    const insight = readBlock(buildBlockRecap(acts, [], TODAY), 6).find(
      (i) => i.id === "dropped",
    );
    expect(insight?.headline).toBe("Swim has gone quiet");
    expect(insight?.tone).toBe("warn");
  });

  it("notices a discipline that disappeared between blocks", () => {
    const acts = [
      // Previous block: plenty of swimming. This block: none.
      ...[0, 2, 4, 6].map((i) => activity(day(-(BLOCK_DAYS * 2 - 1) + i), "Swim", 2, 45)),
      ...consistent,
    ];
    const insights = readBlock(buildBlockRecap(acts, [], TODAY), 6);
    expect(insights.map((i) => i.id)).toContain("dropped");
  });

  it("never returns more than the cap", () => {
    const recap = buildBlockRecap(consistent, withRamp(80), TODAY);
    expect(readBlock(recap, 2)).toHaveLength(2);
  });
});

function plan(overrides: Partial<TrainingPlan> = {}): TrainingPlan {
  return {
    name: "Copenhagen block",
    source: "runna",
    discipline: "run",
    startDate: "2026-06-08",
    raceDate: "2026-09-13",
    raceName: "Copenhagen Half Marathon",
    sessions: [
      { id: "e1", date: "2026-06-08", originalDate: "2026-06-08", name: "Easy", type: "easy", km: 5 },
      { id: "e2", date: "2026-06-10", originalDate: "2026-06-10", name: "Easy", type: "easy", km: 5 },
      { id: "e3", date: "2026-06-15", originalDate: "2026-06-15", name: "Easy", type: "easy", km: 5 },
      { id: "i1", date: "2026-06-09", originalDate: "2026-06-09", name: "Intervals", type: "intervals", km: 8 },
      { id: "i2", date: "2026-06-16", originalDate: "2026-06-16", name: "Intervals", type: "intervals", km: 8 },
      { id: "i3", date: "2026-06-23", originalDate: "2026-06-23", name: "Intervals", type: "intervals", km: 8 },
      { id: "l1", date: "2026-06-13", originalDate: "2026-06-13", name: "Long", type: "long", km: 15 },
      { id: "l2", date: "2026-06-20", originalDate: "2026-06-20", name: "Long", type: "long", km: 16 },
      { id: "l3", date: "2026-06-27", originalDate: "2026-06-27", name: "Long", type: "long", km: 18 },
      { id: "r1", date: "2026-09-13", originalDate: "2026-09-13", name: "Race", type: "race", km: 21.1 },
    ],
    ...overrides,
  } as TrainingPlan;
}

describe("buildPlanRecap", () => {
  // Every long run done, no intervals done — the split the per-type breakdown
  // exists to surface.
  const runs = [
    activity("2026-06-13", "Run", 15, 80),
    activity("2026-06-20", "Run", 16, 85),
    activity("2026-06-27", "Run", 18, 95),
    activity("2026-06-08", "Run", 5, 28),
    activity("2026-09-13", "Run", 21.1, 100),
  ];

  it("breaks adherence down by session type", () => {
    const recap = buildPlanRecap(plan(), runs, [], undefined, TODAY);
    const byType = Object.fromEntries(recap.byType.map((t) => [t.type, t]));
    expect(byType.long).toMatchObject({ done: 3, total: 3 });
    expect(byType.intervals).toMatchObject({ done: 0, total: 3 });
    expect(byType.easy).toMatchObject({ done: 1, total: 3 });
    expect(byType.race).toMatchObject({ done: 1, total: 1 });
  });

  it("keeps custom workouts out of the type breakdown", () => {
    // A swim carries the placeholder type "easy"; counting it would inflate the
    // run plan's easy bucket with a session that was never prescribed.
    const recap = buildPlanRecap(plan(), runs, [], undefined, TODAY, [
      { id: "w1", date: "2026-06-11", discipline: "swim", name: "Easy swim", distanceKm: 2 },
    ]);
    expect(recap.byType.find((t) => t.type === "easy")?.total).toBe(3);
  });

  it("reads fitness at the plan's edges and on race day", () => {
    const load = calcTrainingLoad(runs, TODAY);
    const recap = buildPlanRecap(plan(), runs, load, undefined, TODAY);
    expect(recap.fitness).not.toBeNull();
    expect(recap.fitness!.ctlRace).toBe(
      load.find((p) => p.date === "2026-09-13")!.ctl,
    );
    expect(recap.fitness!.tsbRace).toBe(
      load.find((p) => p.date === "2026-09-13")!.tsb,
    );
  });

  it("counts weeks and days since the race", () => {
    const recap = buildPlanRecap(plan(), runs, [], undefined, TODAY);
    expect(recap.weeks).toBe(14);
    expect(recap.daysSinceRace).toBe(8);
  });

  it("groups skip reasons, most common first", () => {
    const recap = buildPlanRecap(plan(), runs, [], {
      i1: { sessionId: "i1", originalDate: "2026-06-09", newDate: "2026-06-09", movedAt: "2026-06-09T00:00:00Z", skipped: true, skipReason: "Calf niggle" },
      i2: { sessionId: "i2", originalDate: "2026-06-16", newDate: "2026-06-16", movedAt: "2026-06-09T00:00:00Z", skipped: true, skipReason: "Calf niggle" },
      e2: { sessionId: "e2", originalDate: "2026-06-10", newDate: "2026-06-10", movedAt: "2026-06-09T00:00:00Z", skipped: true, skipReason: "Work travel" },
    }, TODAY);
    expect(recap.skips).toEqual([
      { reason: "Calf niggle", count: 2 },
      { reason: "Work travel", count: 1 },
    ]);
  });
});

describe("readPlan", () => {
  const runs = [
    activity("2026-06-13", "Run", 15, 80),
    activity("2026-06-20", "Run", 16, 85),
    activity("2026-06-27", "Run", 18, 95),
    activity("2026-09-13", "Run", 21.1, 100),
  ];

  it("names the session type that slipped", () => {
    const recap = buildPlanRecap(plan(), runs, [], undefined, TODAY);
    const split = readPlan(recap, 6).find((i) => i.id === "type-split");
    expect(split?.headline).toContain("Interval");
  });

  it("reads race-day form as the verdict on the taper", () => {
    const fresh = buildPlanRecap(plan(), runs, [{ date: "2026-09-13", ctl: 50, atl: 35, tsb: 15, dailyTSS: 0 }], undefined, TODAY);
    expect(readPlan(fresh, 6).find((i) => i.id.startsWith("taper"))?.id).toBe("taper-good");

    const tired = buildPlanRecap(plan(), runs, [{ date: "2026-09-13", ctl: 50, atl: 70, tsb: -20, dailyTSS: 0 }], undefined, TODAY);
    expect(readPlan(tired, 6).find((i) => i.id.startsWith("taper"))?.id).toBe("taper-tired");
  });

  it("calls out a skip reason that keeps recurring", () => {
    const overrides = Object.fromEntries(
      ["i1", "i2", "i3"].map((id) => [
        id,
        { sessionId: id, originalDate: "2026-06-09", newDate: "2026-06-09", movedAt: "2026-06-09T00:00:00Z", skipped: true, skipReason: "Calf niggle" },
      ]),
    );
    const recap = buildPlanRecap(plan(), runs, [], overrides, TODAY);
    expect(readPlan(recap, 6).map((i) => i.id)).toContain("skip-pattern");
  });
});

describe("adherencePct", () => {
  it("counts partials as done and ignores sessions not yet due", () => {
    expect(
      adherencePct({
        completed: 6, partial: 2, missed: 2, skipped: 0,
        remaining: 10, total: 20, plannedKm: 0, actualKm: 0,
      }),
    ).toBe(80);
  });

  it("is zero rather than NaN before anything has been graded", () => {
    expect(
      adherencePct({
        completed: 0, partial: 0, missed: 0, skipped: 0,
        remaining: 5, total: 5, plannedKm: 0, actualKm: 0,
      }),
    ).toBe(0);
  });
});
