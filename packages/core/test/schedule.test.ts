import { describe, expect, it } from "vitest";
import {
  calcTrainingLoad,
  expectedLoadByDay,
  findScheduleConflicts,
  isHardSession,
  readAthleteState,
  resolveZoneModel,
  scheduledSessions,
  suggestWorkouts,
  type CustomWorkoutInput,
  type PlannedSession,
  type SessionWithStatus,
  type StravaActivity,
  type SuggestedSession,
  type SuggestInput,
  type TrainingLoadPoint,
  type TrainingPlan,
} from "../src";

const TODAY = "2026-09-22"; // a Tuesday

const ZONES = resolveZoneModel(
  {
    heart_rate: {
      custom_zones: false,
      zones: [
        { min: 0, max: 133 },
        { min: 133, max: 165 },
        { min: 165, max: 182 },
        { min: 182, max: 198 },
        { min: 198, max: -1 },
      ],
    },
  },
  200,
);

let nextId = 1;

function day(offset: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().split("T")[0];
}

function act(date: string, km: number, minutes: number): StravaActivity {
  return {
    id: nextId++,
    name: `Run ${date}`,
    sport_type: "Run",
    type: "Run",
    start_date: `${date}T08:00:00Z`,
    start_date_local: `${date}T08:00:00Z`,
    distance: km * 1000,
    moving_time: minutes * 60,
    average_heartrate: 150,
    manual: false,
  } as unknown as StravaActivity;
}

/** Easy runs every other day for three months; nothing recent is hard. */
function baseHistory(): StravaActivity[] {
  const out: StravaActivity[] = [];
  for (let i = 2; i < 80; i += 2) out.push(act(day(-i), 10, 60));
  return out;
}

function load(tsb: number): TrainingLoadPoint[] {
  return [{ date: TODAY, ctl: 60, atl: 60 - tsb, tsb, dailyTSS: 0 }];
}

function custom(date: string, name: string, over: Partial<CustomWorkoutInput> = {}): CustomWorkoutInput {
  return { id: `w-${nextId++}`, date, discipline: "run", name, distanceKm: 10, ...over };
}

function planWith(sessions: Omit<PlannedSession, "id" | "originalDate">[], raceDate = day(40)): TrainingPlan {
  return {
    name: "Block",
    source: "runna",
    discipline: "run",
    startDate: day(-30),
    raceDate,
    raceName: "Race",
    sessions: sessions.map((s, i) => ({ ...s, id: `p${i}`, originalDate: s.date })),
  };
}

function input(over: Partial<SuggestInput> = {}): SuggestInput {
  return {
    activities: baseHistory(),
    trainingLoad: load(0),
    plan: null,
    zones: ZONES,
    today: TODAY,
    ...over,
  };
}

const HARD_KINDS = ["intervals", "vo2", "tempo", "long"];

const INTERVALS: SuggestedSession = {
  name: "6 x 400 m",
  discipline: "run",
  kind: "intervals",
  durationMin: 55,
  steps: [],
  summary: "",
};

describe("a hard session on the calendar counts before it happens", () => {
  it("keeps tomorrow easy after a hard session is picked for today", () => {
    // The reported bug: pick intervals for today, look at tomorrow, and get
    // offered intervals again, because nothing had synced from Strava yet.
    const out = suggestWorkouts(
      input({ customWorkouts: [custom(TODAY, "6 x 400 m")], date: day(1) }),
      8,
    );
    expect(out[0].constraint).toBe("recent-hard");
    expect(out[0].headline).toContain("a hard session comes first");
    expect(out[0].why).toContain("on your calendar for today");
    const kinds = out.map((s) => s.session?.kind);
    for (const kind of HARD_KINDS) expect(kinds).not.toContain(kind);
  });

  it("leaves tomorrow alone when today's calendar session is easy", () => {
    const out = suggestWorkouts(
      input({ customWorkouts: [custom(TODAY, "8 km easy run", { distanceKm: 8 })], date: day(1) }),
      8,
    );
    expect(out.map((s) => s.constraint)).not.toContain("recent-hard");
    expect(out.map((s) => s.session?.kind)).toContain("intervals");
  });

  it("does not count a skipped plan session", () => {
    const plan = planWith([{ date: TODAY, name: "Tempo 8km", type: "tempo", km: 8 }]);
    const out = suggestWorkouts(
      input({
        plan,
        overrides: {
          p0: {
            sessionId: "p0",
            originalDate: TODAY,
            newDate: TODAY,
            movedAt: "",
            skipped: true,
          },
        },
        date: day(1),
      }),
      8,
    );
    expect(out.map((s) => s.constraint)).not.toContain("recent-hard");
  });

  it("recognises a completed short interval session by what it was", () => {
    // 45 minutes of intervals carries less load than an hour of easy running,
    // so load alone called it an easy day. The plan knows better.
    const activities = [...baseHistory(), act(day(-1), 7, 45)];
    const plan = planWith([{ date: day(-1), name: "Rolling 300s", type: "intervals", km: 7 }]);
    const out = suggestWorkouts(input({ activities, plan }), 8);
    expect(out[0].constraint).toBe("recent-hard");
    expect(out[0].why).toContain("was yesterday");
  });

  it("shows calendar workouts for the day even with no plan uploaded", () => {
    const out = suggestWorkouts(input({ customWorkouts: [custom(TODAY, "6 x 400 m")] }));
    expect(out[0].constraint).toBe("plan");
    expect(out[0].headline).toBe("On your calendar: 6 x 400 m");
  });
});

describe("the day being planned is the anchor, not today", () => {
  it("frees tomorrow once yesterday's hard session is two days back", () => {
    const hard = { ...act(day(-1), 20, 110), name: "Long run" };
    const state = readAthleteState(input({ activities: [...baseHistory(), hard], date: day(1) }));
    expect(state.daysSinceHard).toBe(2);
    const out = suggestWorkouts(input({ activities: [...baseHistory(), hard], date: day(1) }), 8);
    expect(out.map((s) => s.constraint)).not.toContain("recent-hard");
  });

  it("counts a scheduled ride toward days since riding", () => {
    const state = readAthleteState(
      input({
        customWorkouts: [custom(day(1), "60 min endurance ride", { discipline: "ride", distanceKm: null })],
        date: day(3),
      }),
    );
    expect(state.daysSince.ride).toBe(2);
  });
});

describe("projecting form forward", () => {
  it("lowers form on the day after scheduled load", () => {
    const activities = baseHistory();
    const customWorkouts = [custom(TODAY, "6 x 400 m", { durationMin: 60 })];
    const sessions = scheduledSessions({ plan: null, activities, customWorkouts, today: TODAY });
    const expected = expectedLoadByDay(sessions, customWorkouts, TODAY, day(1));

    expect(expected.get(TODAY)).toBe(78); // 60 hard minutes
    const plain = calcTrainingLoad(activities, day(1)).at(-1)!;
    const projected = calcTrainingLoad(activities, day(1), expected).at(-1)!;
    expect(projected.tsb).toBeLessThan(plain.tsb);
  });

  it("ignores sessions on or after the day being planned", () => {
    const customWorkouts = [custom(day(1), "6 x 400 m")];
    const sessions = scheduledSessions({ plan: null, activities: [], customWorkouts, today: TODAY });
    expect(expectedLoadByDay(sessions, customWorkouts, TODAY, day(1)).size).toBe(0);
  });
});

describe("reading intensity from a calendar workout's name", () => {
  function row(name: string, discipline: "run" | "ride" | "swim", km = 8): SessionWithStatus {
    return {
      id: name,
      date: TODAY,
      originalDate: TODAY,
      name,
      type: "easy",
      km,
      discipline,
      isCustom: true,
      status: "upcoming",
    };
  }

  it.each([
    ["6 x 400 m", "run"],
    ["5 x 3 min hard", "run"],
    ["4 km tempo", "run"],
    ["4 x 8 min threshold", "ride"],
    ["Rolling 300s", "run"],
    ["Progressive long run", "run"],
  ] as const)("treats %s as hard", (name, discipline) => {
    expect(isHardSession(row(name, discipline))).toBe(true);
  });

  it.each([
    ["8 km easy run", "run"],
    ["60 min endurance ride", "ride"],
    ["1200 m swim: 8 x 100", "swim"],
  ] as const)("treats %s as easy", (name, discipline) => {
    expect(isHardSession(row(name, discipline))).toBe(false);
  });

  it("treats any run of 16 km or more as a hard day", () => {
    expect(isHardSession(row("Sunday easy", "run", 18))).toBe(true);
  });
});

describe("proposing changes when a hard session clashes", () => {
  it("proposes nothing for an easy pick", () => {
    const plan = planWith([{ date: day(1), name: "Progressive Long Run", type: "long", km: 17 }]);
    const easy = { ...INTERVALS, name: "8 km easy run", kind: "easy" as const };
    expect(findScheduleConflicts(input({ plan }), easy)).toEqual([]);
  });

  it("offers to move tomorrow's hard session, then to ease it, then to keep both", () => {
    const plan = planWith([{ date: day(1), name: "Progressive Long Run", type: "long", km: 17 }]);
    const [c] = findScheduleConflicts(input({ plan }), INTERVALS);

    expect(c.relation).toBe("day-after");
    expect(c.source).toBe("plan");
    expect(c.message).toContain("Wednesday");
    expect(c.options.map((o) => o.action)).toEqual(["move", "ease", "keep"]);
    // Wednesday is left empty and Thursday has nothing hard either side.
    expect(c.options[0].newDate).toBe(day(2));
    expect(c.options[1].replacement?.kind).toBe("easy");
  });

  it("skips days that are occupied or would sit next to another hard day", () => {
    const plan = planWith([
      { date: day(1), name: "Progressive Long Run", type: "long", km: 17 },
      { date: day(2), name: "Easy 8km", type: "easy", km: 8 },
      { date: day(4), name: "Intervals", type: "intervals", km: 10 },
    ]);
    const [c] = findScheduleConflicts(input({ plan }), INTERVALS);
    // Thu is taken, Fri sits before Sat's intervals, Sat is taken.
    expect(c.options.map((o) => o.action)).toEqual(["ease", "keep"]);
  });

  it("never moves a session onto or past race day", () => {
    const plan = planWith(
      [{ date: day(1), name: "Tempo 8km", type: "tempo", km: 8 }],
      day(2),
    );
    const [c] = findScheduleConflicts(input({ plan }), INTERVALS);
    expect(c.options.map((o) => o.action)).not.toContain("move");
  });

  it("offers no changes to a race, only a warning", () => {
    const plan = planWith([{ date: day(1), name: "Stockholm 10K", type: "race", km: 10 }], day(1));
    const [c] = findScheduleConflicts(input({ plan }), INTERVALS);
    expect(c.message).toContain("costs you on race day");
    expect(c.options.map((o) => o.action)).toEqual(["keep"]);
  });

  it("offers to replace a hard session already on the same day", () => {
    const plan = planWith([{ date: TODAY, name: "Threshold 5 x 1km", type: "intervals", km: 12 }]);
    const [c] = findScheduleConflicts(input({ plan }), INTERVALS);
    expect(c.relation).toBe("same-day");
    expect(c.options.map((o) => o.action)).toEqual(["replace", "keep"]);
  });

  it("covers the athlete's own calendar workouts too", () => {
    const w = custom(day(1), "4 x 8 min threshold", { discipline: "ride", distanceKm: null });
    const [c] = findScheduleConflicts(input({ customWorkouts: [w] }), INTERVALS);
    expect(c.source).toBe("calendar");
    expect(c.sessionId).toBe(w.id);
  });

  it("ignores easy sessions and swims next to the pick", () => {
    const plan = planWith([{ date: day(1), name: "Easy 8km", type: "easy", km: 8 }]);
    const swim = custom(day(-1), "1500 m: 10 x 100", { discipline: "swim", distanceKm: 1.5 });
    expect(findScheduleConflicts(input({ plan, customWorkouts: [swim] }), INTERVALS)).toEqual([]);
  });
});
