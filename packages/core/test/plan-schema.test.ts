import { describe, expect, it } from "vitest";
import {
  buildTrainingPlan,
  matchSessions,
  daysUntilRace,
  getCurrentWeekSessions,
  parseRawTrainingPlan,
  plannedVsActualByWeek,
  SEED_PLAN,
  TRAINING_PLAN_JSON_SCHEMA,
  type CustomWorkoutInput,
  type RawTrainingPlan,
} from "../src";

// Plans now arrive from an athlete's upload, parsed out of a PDF by a model, so
// nothing about them can be assumed. These tests pin the validator that stands
// between that output and the database, and the plumbing that lets each athlete
// see their own plan instead of a shared one.

function rawPlan(over: Partial<RawTrainingPlan> = {}): RawTrainingPlan {
  return {
    name: "Berlin Marathon Block",
    source: "Coach",
    discipline: "run",
    startDate: "2027-01-04",
    raceDate: "2027-04-11",
    raceName: "Berlin Marathon",
    sessions: [
      { date: "2027-01-04", name: "10km Easy", type: "easy", km: 10 },
      { date: "2027-01-06", name: "5x1km", type: "intervals", km: 12 },
    ],
    ...over,
  };
}

describe("parseRawTrainingPlan", () => {
  it("accepts a well-formed plan and normalises it", () => {
    const parsed = parseRawTrainingPlan(
      rawPlan({
        name: "  Berlin Marathon Block  ",
        discipline: "RUN",
        sessions: [
          { date: "2027-01-06", name: "5x1km", type: "intervals", km: 12.345 },
          { date: "2027-01-04", name: "10km Easy", type: "easy", km: 10 },
        ],
      }),
    );

    expect(parsed.name).toBe("Berlin Marathon Block");
    expect(parsed.discipline).toBe("run");
    // Sorted by date, so the calendar and plan list read in order whatever
    // order the source document produced.
    expect(parsed.sessions.map((s) => s.date)).toEqual(["2027-01-04", "2027-01-06"]);
    expect(parsed.sessions[1].km).toBe(12.35);
  });

  it("rejects a plan with no sessions", () => {
    expect(() => parseRawTrainingPlan(rawPlan({ sessions: [] }))).toThrow(
      /No sessions/i,
    );
  });

  it("rejects an impossible calendar date that matches the date shape", () => {
    expect(() =>
      parseRawTrainingPlan(
        rawPlan({
          sessions: [{ date: "2027-02-31", name: "Long", type: "long", km: 20 }],
        }),
      ),
    ).toThrow(/not a real date/i);
  });

  it("rejects an unknown session type", () => {
    expect(() =>
      parseRawTrainingPlan(
        rawPlan({
          sessions: [
            // Deliberately outside SessionType — the model could emit anything.
            { date: "2027-01-04", name: "Yoga", type: "recovery", km: 0 },
          ] as never,
        }),
      ),
    ).toThrow(/must be one of/i);
  });

  it("rejects a race date before the plan starts", () => {
    expect(() =>
      parseRawTrainingPlan(rawPlan({ raceDate: "2026-01-01" })),
    ).toThrow(/on or after/i);
  });

  it("rejects a non-numeric or out-of-range distance", () => {
    expect(() =>
      parseRawTrainingPlan(
        rawPlan({
          sessions: [
            { date: "2027-01-04", name: "Long", type: "long", km: "20" },
          ] as never,
        }),
      ),
    ).toThrow(/must be a number/i);

    expect(() =>
      parseRawTrainingPlan(
        rawPlan({
          sessions: [{ date: "2027-01-04", name: "Long", type: "long", km: 9000 }],
        }),
      ),
    ).toThrow(/between 0 and/i);
  });

  it("rejects anything that is not an object", () => {
    expect(() => parseRawTrainingPlan(null)).toThrow();
    expect(() => parseRawTrainingPlan([])).toThrow();
    expect(() => parseRawTrainingPlan("a plan")).toThrow();
  });

  it("accepts the bundled seed plan, so the backfill writes a valid row", () => {
    expect(() =>
      parseRawTrainingPlan({
        name: SEED_PLAN.name,
        source: SEED_PLAN.source,
        discipline: SEED_PLAN.discipline,
        startDate: SEED_PLAN.startDate,
        raceDate: SEED_PLAN.raceDate,
        raceName: SEED_PLAN.raceName,
        sessions: SEED_PLAN.sessions.map((s) => ({
          date: s.date,
          name: s.name,
          type: s.type,
          km: s.km,
        })),
      }),
    ).not.toThrow();
  });
});

describe("TRAINING_PLAN_JSON_SCHEMA", () => {
  it("is a strict object schema, as structured outputs requires", () => {
    const schema = TRAINING_PLAN_JSON_SCHEMA as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    const items = (schema.properties as Record<string, { items?: Record<string, unknown> }>)
      .sessions.items!;
    expect(items.additionalProperties).toBe(false);
    expect(items.required).toEqual(["date", "name", "type", "km"]);
  });
});

describe("per-athlete plans", () => {
  const uploaded = buildTrainingPlan(rawPlan());

  it("matchSessions reads the plan it is handed, not the bundled one", () => {
    const result = matchSessions(uploaded, [], undefined, "2027-01-04");
    expect(result.map((s) => s.name)).toEqual(["10km Easy", "5x1km"]);
    expect(result[0].status).toBe("today");
  });

  it("weekly planned volume comes from the passed-in plan", () => {
    const weeks = plannedVsActualByWeek(uploaded, [], undefined, "2027-01-04");
    const total = weeks.reduce((sum, w) => sum + w.plannedKm, 0);
    expect(total).toBeCloseTo(22, 1);
  });

  it("daysUntilRace counts to the passed-in plan's race", () => {
    expect(daysUntilRace(uploaded, "2027-04-01")).toBe(10);
    expect(daysUntilRace(uploaded, "2099-01-01")).toBe(0);
  });

  it("gives every session a stable id derived from its date and name", () => {
    const again = buildTrainingPlan(rawPlan());
    expect(again.sessions.map((s) => s.id)).toEqual(uploaded.sessions.map((s) => s.id));
    expect(uploaded.sessions[0].id).toBe("2027-01-04-10km-easy");
    expect(uploaded.sessions[0].originalDate).toBe("2027-01-04");
  });
});

// The bug this guards: a second athlete was told they were doing "Drop Set"
// intervals — a session that exists only in the bundled Runna plan, i.e. the
// first athlete's plan. Nothing may fill an empty plan with a default.
describe("an athlete with no plan has no plan", () => {
  const seedNames = new Set(SEED_PLAN.sessions.map((s) => s.name));
  const seedIds = new Set(SEED_PLAN.sessions.map((s) => s.id));

  it("matchSessions returns nothing at all for an athlete with no plan", () => {
    const result = matchSessions(null, [], undefined, SEED_PLAN.sessions[0].date);
    expect(result).toEqual([]);
  });

  it("never leaks a bundled-plan session into a no-plan athlete's view", () => {
    // Ask on a date the seed plan is full of sessions for, with a seed session
    // name deliberately present in the assertion set.
    expect(seedNames.has("Drop Set")).toBe(true);

    for (const today of SEED_PLAN.sessions.slice(0, 12).map((s) => s.date)) {
      const sessions = matchSessions(null, [], undefined, today);
      expect(sessions.some((s) => seedIds.has(s.id))).toBe(false);
      expect(sessions.some((s) => seedNames.has(s.name))).toBe(false);
    }

    const currentWeek = getCurrentWeekSessions(
      null,
      [],
      undefined,
      SEED_PLAN.sessions[0].date,
    );
    expect(currentWeek).toEqual([]);
  });

  it("has no planned weeks and no planned km without a plan", () => {
    expect(plannedVsActualByWeek(null, [], undefined, SEED_PLAN.startDate)).toEqual([]);
  });

  it("still shows the athlete's own custom workouts, and only those", () => {
    const swim: CustomWorkoutInput = {
      id: "custom-1",
      date: SEED_PLAN.sessions[0].date,
      discipline: "swim",
      name: "Endurance swim",
      distanceKm: 2,
    };

    const sessions = matchSessions(
      null,
      [],
      undefined,
      SEED_PLAN.sessions[0].date,
      [swim],
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("custom-1");

    const weeks = plannedVsActualByWeek(
      null,
      [],
      undefined,
      SEED_PLAN.sessions[0].date,
      [swim],
    );
    expect(weeks).toHaveLength(1);
    expect(weeks[0].plannedKm).toBeCloseTo(2, 1);
  });

  it("cannot even ask for a race date without a plan", () => {
    // daysUntilRace takes a non-null plan, so there is no call shape that
    // yields the bundled plan's race date for a planless athlete. The type
    // system enforces it; this pins the intent.
    // @ts-expect-error — null is not an acceptable plan
    expect(() => daysUntilRace(null, "2026-06-08")).toThrow();
  });
});
