import { buildTrainingPlan, type RawPlannedSession, type RawTrainingPlan, type SessionType, SESSION_TYPES } from "./plan";
import { parseRawTrainingPlan } from "./plan-schema";
import type { TrainingDiscipline } from "./recap";
import { expectedSessionTss } from "./schedule";
import { calcTrainingLoad, getDiscipline } from "./training";
import type { StravaActivity } from "./types/strava";

/**
 * The coach's plan builder, minus the model call: what the athlete asks for,
 * the facts the coach starts from, the shape the model writes, and turning
 * that shape into a dated, validated plan with the numbers the preview shows.
 *
 * The model writes weeks and weekdays, never dates. Counting 38 weeks of dates
 * is exactly the arithmetic a model gets subtly wrong, and one day's drift
 * puts every long ride on a Friday; the dates are computed here instead.
 */

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** What the athlete asked for in the Create dialog. */
export interface PlanRequest {
  prompt: string;
  /** First day of the plan (YYYY-MM-DD). */
  startDate: string;
  /** Race day, when there is one; the plan builds and tapers to it. */
  raceDate?: string;
  raceName?: string;
  /** The most hours a week the athlete can train, at peak. */
  maxHoursPerWeek?: number;
  /** Days that must stay free of sessions. */
  unavailableDays?: Weekday[];
}

const MAX_PROMPT_LENGTH = 1000;
const MAX_PLAN_WEEKS = 52;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Validate the Create dialog's input; messages are safe to show the athlete. */
export function parsePlanRequest(input: unknown, today: string): PlanRequest {
  const o = (input ?? {}) as Record<string, unknown>;
  const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
  if (!prompt) throw new Error("Say what you want to train for.");
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`Keep the request under ${MAX_PROMPT_LENGTH} characters.`);
  if (!isRealDate(o.startDate)) throw new Error("Pick the day the plan starts.");
  if (o.startDate < today) throw new Error("The plan can't start in the past.");

  const request: PlanRequest = { prompt, startDate: o.startDate };
  if (o.raceDate !== undefined && o.raceDate !== null && o.raceDate !== "") {
    if (!isRealDate(o.raceDate)) throw new Error("Race day isn't a real date.");
    if (o.raceDate <= o.startDate) throw new Error("Race day must be after the plan starts.");
    if (weeksBetween(o.startDate, o.raceDate) > MAX_PLAN_WEEKS) {
      throw new Error(`Plans can run at most ${MAX_PLAN_WEEKS} weeks.`);
    }
    request.raceDate = o.raceDate;
  }
  if (typeof o.raceName === "string" && o.raceName.trim()) request.raceName = o.raceName.trim().slice(0, 120);
  if (o.maxHoursPerWeek !== undefined && o.maxHoursPerWeek !== null && o.maxHoursPerWeek !== "") {
    const h = Number(o.maxHoursPerWeek);
    if (!Number.isFinite(h) || h < 2 || h > 40) throw new Error("Hours per week must be between 2 and 40.");
    request.maxHoursPerWeek = Math.round(h * 2) / 2;
  }
  if (Array.isArray(o.unavailableDays)) {
    const days = [...new Set(o.unavailableDays)].filter((d): d is Weekday => WEEKDAYS.includes(d as Weekday));
    if (days.length >= 6) throw new Error("Leave at least two days a week to train.");
    if (days.length) request.unavailableDays = days;
  }
  return request;
}

// ---------------------------------------------------------------------------
// Dates

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing `date`. */
export function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;
  return addDays(date, 1 - dow);
}

/** Plan weeks from the start's Monday through the end date, inclusive. */
export function weeksBetween(start: string, end: string): number {
  const ms = new Date(`${mondayOf(end)}T00:00:00Z`).getTime() - new Date(`${mondayOf(start)}T00:00:00Z`).getTime();
  return Math.round(ms / (7 * 86_400_000)) + 1;
}

// ---------------------------------------------------------------------------
// What the model writes

export interface DraftSession {
  day: Weekday;
  name: string;
  discipline: TrainingDiscipline;
  type: SessionType;
  km: number;
  durationMin: number;
  notes: string;
}

export interface DraftWeek {
  /** "Base", "Build", "Specific", "Peak", "Taper", "Race"… */
  phase: string;
  /** One line on what the week is for. */
  focus: string;
  sessions: DraftSession[];
}

export interface DraftModelOutput {
  name: string;
  /** Two to four sentences on why the plan is shaped the way it is. */
  why: string;
  /** Things the coach assumed and the athlete should check. */
  assumptions: string[];
  weeks: DraftWeek[];
}

/**
 * JSON Schema for the model's structured output. Free of numeric bounds
 * (structured outputs does not support them); expandDraft enforces them.
 */
export const PLAN_DRAFT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name", "why", "assumptions", "weeks"],
  properties: {
    name: { type: "string", description: "Short plan title, e.g. 'Ironman Frankfurt plan'." },
    why: {
      type: "string",
      description:
        "Two to four plain sentences, addressed to the athlete, on why the plan is shaped this way given their starting point.",
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
      description: "Short statements the plan relies on that the athlete should confirm, e.g. 'Pool access twice a week'.",
    },
    weeks: {
      type: "array",
      description: "Every week of the plan in order, week 1 first. Week 1 is the week containing the start date.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["phase", "focus", "sessions"],
        properties: {
          phase: { type: "string", description: "Phase name: Base, Build, Specific, Peak, Taper, Race, or Recovery." },
          focus: { type: "string", description: "One short line on what this week is for." },
          sessions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["day", "name", "discipline", "type", "km", "durationMin", "notes"],
              properties: {
                day: { type: "string", enum: [...WEEKDAYS] },
                name: { type: "string", description: "Short session title, e.g. 'Threshold ride'." },
                discipline: { type: "string", enum: ["swim", "ride", "run", "strength"] },
                type: {
                  type: "string",
                  enum: [...SESSION_TYPES],
                  description:
                    "easy = recovery/aerobic; intervals = repeats; tempo = sustained threshold or race pace; long = the week's long session in that sport; time_trial = a test; race = the goal race.",
                },
                km: { type: "number", description: "Planned distance in km, or 0 when the session is prescribed by time only." },
                durationMin: { type: "number", description: "Planned minutes." },
                notes: {
                  type: "string",
                  description: "How to do it in one or two short sentences: structure, zones or targets. Empty string if nothing to add.",
                },
              },
            },
          },
        },
      },
    },
  },
};

/** A phase as the preview shows it: a run of consecutive weeks with one name. */
export interface DraftPhase {
  name: string;
  weeks: number;
  startDate: string;
}

export interface ExpandedDraft {
  plan: RawTrainingPlan;
  why: string;
  assumptions: string[];
  phases: DraftPhase[];
  /** The model's one-liner per week, in order. */
  weekFocus: string[];
  /** Sessions the model put on a day the athlete can't train, or outside the plan. */
  dropped: number;
}

/**
 * Turn the model's weeks into a dated, validated plan. Week 1 is the week of
 * the start date; days before the start or after the end are dropped, as is
 * anything on a day the athlete said they can't train.
 */
export function expandDraft(output: DraftModelOutput, request: PlanRequest): ExpandedDraft {
  if (!Array.isArray(output?.weeks) || output.weeks.length === 0) throw new Error("The coach returned no weeks.");
  const firstMonday = mondayOf(request.startDate);
  const lastDay = request.raceDate ?? addDays(firstMonday, output.weeks.length * 7 - 1);
  const blocked = new Set(request.unavailableDays ?? []);

  const sessions: RawPlannedSession[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  output.weeks.slice(0, MAX_PLAN_WEEKS).forEach((week, w) => {
    for (const s of week.sessions ?? []) {
      const offset = WEEKDAYS.indexOf(s.day);
      if (offset < 0) { dropped++; continue; }
      const date = addDays(firstMonday, w * 7 + offset);
      if (date < request.startDate || date > lastDay || blocked.has(s.day)) { dropped++; continue; }
      // Two sessions with the same name on one day would share an id and so
      // share their edits; the second gets told apart.
      let name = (s.name ?? "").trim().slice(0, 110) || "Session";
      if (seen.has(`${date}|${name}`)) name = `${name} (2)`;
      seen.add(`${date}|${name}`);
      sessions.push({
        date,
        name,
        discipline: s.discipline,
        type: s.type,
        km: Math.max(0, Math.round((Number(s.km) || 0) * 10) / 10),
        ...(s.durationMin > 0 ? { durationMin: Math.round(s.durationMin) } : {}),
        ...(s.notes?.trim() ? { notes: s.notes.trim() } : {}),
      });
    }
  });
  if (sessions.length === 0) throw new Error("The coach returned no sessions inside the plan's dates.");

  const sports = new Set(sessions.map((s) => s.discipline));
  const single = sports.size === 1 ? [...sports][0] : null;
  const plan = parseRawTrainingPlan({
    name: (output.name ?? "").trim() || "Coach plan",
    source: "Coach",
    discipline: single && single !== "strength" ? single : "multi",
    startDate: request.startDate,
    raceDate: request.raceDate ?? sessions[sessions.length - 1].date,
    raceName: request.raceName ?? "",
    sessions,
  });

  const phases: DraftPhase[] = [];
  output.weeks.forEach((week, w) => {
    const name = (week.phase ?? "").trim() || "Training";
    const last = phases[phases.length - 1];
    // A recovery week inside a block belongs to that block; naming it as its
    // own phase chops Base and Build into a strip of one-week slivers.
    const isRecovery = /recover/i.test(name);
    if (last && (last.name.toLowerCase() === name.toLowerCase() || isRecovery)) last.weeks++;
    else phases.push({ name, weeks: 1, startDate: w === 0 ? request.startDate : addDays(firstMonday, w * 7) });
  });

  return {
    plan,
    why: (output.why ?? "").trim(),
    assumptions: (output.assumptions ?? []).map((a) => a.trim()).filter(Boolean).slice(0, 8),
    phases,
    weekFocus: output.weeks.map((w) => (w.focus ?? "").trim()),
    dropped,
  };
}

// ---------------------------------------------------------------------------
// The numbers the preview shows

export interface DraftWeekStats {
  weekStart: string;
  phase: string;
  /** Planned minutes by sport; a session with only km is converted at an easy pace. */
  minutes: Record<TrainingDiscipline, number>;
  totalMin: number;
  recovery: boolean;
}

export interface DraftStats {
  weeks: DraftWeekStats[];
  /** Projected fitness (CTL), one point per day, if the athlete trains the plan as written. */
  ctl: { date: string; ctl: number }[];
  ctlStart: number;
  ctlPeak: number;
  /** Form (TSB) on race morning, or on the plan's last day when there is no race. */
  formEnd: number;
  hoursMin: number;
  hoursMax: number;
  recoveryWeeks: number;
}

function sessionMinutes(s: { discipline: TrainingDiscipline; km: number; durationMin?: number }): number {
  if (s.durationMin) return s.durationMin;
  if (s.km <= 0) return s.discipline === "strength" ? 30 : 45;
  return s.discipline === "swim" ? s.km * 25 : s.discipline === "ride" ? s.km * 2.4 : s.km * 6;
}

export function draftStats(draft: ExpandedDraft, history: StravaActivity[]): DraftStats {
  const plan = buildTrainingPlan(draft.plan);
  const firstMonday = mondayOf(plan.startDate);

  const byWeek = new Map<string, DraftWeekStats>();
  const phaseAt = (weekStart: string) => {
    let name = draft.phases[0]?.name ?? "";
    let cursor = firstMonday;
    for (const p of draft.phases) {
      if (weekStart >= cursor) name = p.name;
      cursor = addDays(cursor, p.weeks * 7);
    }
    return name;
  };
  for (let w = 0; w < weeksBetween(plan.startDate, plan.raceDate); w++) {
    const weekStart = addDays(firstMonday, w * 7);
    byWeek.set(weekStart, {
      weekStart,
      phase: phaseAt(weekStart),
      minutes: { swim: 0, ride: 0, run: 0, strength: 0 },
      totalMin: 0,
      recovery: false,
    });
  }
  for (const s of plan.sessions) {
    const week = byWeek.get(mondayOf(s.date));
    if (!week) continue;
    const min = Math.round(sessionMinutes(s));
    week.minutes[s.discipline] += min;
    week.totalMin += min;
  }
  const weeks = [...byWeek.values()];
  // A recovery week is a real step down from the week before, outside the
  // taper (where every week steps down on purpose).
  weeks.forEach((w, i) => {
    const prev = weeks[i - 1];
    w.recovery =
      !!prev && w.totalMin > 0 && w.totalMin < prev.totalMin * 0.8 && !/taper|race/i.test(w.phase);
  });

  // Project fitness by treating every plan session as done as written.
  const expected = new Map<string, number>();
  for (const s of plan.sessions) {
    const tss = expectedSessionTss({ ...s, status: "upcoming" }, sessionMinutes(s));
    expected.set(s.date, (expected.get(s.date) ?? 0) + tss);
  }
  const load = calcTrainingLoad(history, plan.raceDate, expected);
  // A day's point includes that day's load, so race morning is the end of the
  // day before: reading race day itself would count the race against the
  // athlete's freshness for it. The curve stops there too.
  const hasRace = draft.plan.raceName !== "" || plan.sessions.some((s) => s.type === "race" && s.date === plan.raceDate);
  const upTo = hasRace ? load.filter((p) => p.date < plan.raceDate) : load;
  const ctl = upTo.filter((p) => p.date >= plan.startDate).map((p) => ({ date: p.date, ctl: p.ctl }));
  const atStart = load.find((p) => p.date >= plan.startDate) ?? load[load.length - 1];
  const end = upTo[upTo.length - 1] ?? load[load.length - 1];
  const hours = weeks.filter((w) => w.totalMin > 0).map((w) => w.totalMin / 60);

  return {
    weeks,
    ctl,
    ctlStart: Math.round(atStart?.ctl ?? 0),
    ctlPeak: Math.round(Math.max(0, ...ctl.map((p) => p.ctl))),
    formEnd: Math.round(end?.tsb ?? 0),
    hoursMin: hours.length ? Math.round(Math.min(...hours) * 10) / 10 : 0,
    hoursMax: hours.length ? Math.round(Math.max(...hours) * 10) / 10 : 0,
    recoveryWeeks: weeks.filter((w) => w.recovery).length,
  };
}

// ---------------------------------------------------------------------------
// Where the athlete starts from

export interface StartingPoint {
  asOf: string;
  startDate: string;
  ctlToday: number;
  /** Fitness projected to the start date, counting what is still on the calendar before it. */
  ctlAtStart: number;
  /** Average hours a week over the last eight weeks. */
  hoursPerWeek: number;
  /** Share of those hours by sport, in whole percent. */
  split: Record<TrainingDiscipline, number>;
  longestRideMin: number;
  longestRunMin: number;
  longestSwimM: number;
  /** Sessions a week, by sport, over the last eight weeks. */
  sessionsPerWeek: Record<TrainingDiscipline, number>;
}

/**
 * The facts the coach builds from, computed here so the model is handed
 * numbers instead of estimating them. `expectedBeforeStart` is the load still
 * on the calendar between today and the start date (an existing plan's
 * remaining sessions), so fitness is projected to day one, not quoted as of now.
 */
export function startingPoint(
  history: StravaActivity[],
  today: string,
  startDate: string,
  expectedBeforeStart?: Map<string, number>,
): StartingPoint {
  const now = calcTrainingLoad(history, today);
  const projected = calcTrainingLoad(history, startDate, expectedBeforeStart);
  const since8 = addDays(today, -56);
  const since12 = addDays(today, -84);
  const minutes: Record<TrainingDiscipline, number> = { swim: 0, ride: 0, run: 0, strength: 0 };
  const sessions: Record<TrainingDiscipline, number> = { swim: 0, ride: 0, run: 0, strength: 0 };
  let longestRideMin = 0;
  let longestRunMin = 0;
  let longestSwimM = 0;
  for (const a of history) {
    const day = a.start_date_local.slice(0, 10);
    if (day > today) continue;
    const d = getDiscipline(a);
    if (d === "other") continue;
    if (day >= since8) {
      minutes[d] += a.moving_time / 60;
      sessions[d]++;
    }
    if (day >= since12) {
      if (d === "ride") longestRideMin = Math.max(longestRideMin, a.moving_time / 60);
      if (d === "run") longestRunMin = Math.max(longestRunMin, a.moving_time / 60);
      if (d === "swim") longestSwimM = Math.max(longestSwimM, a.distance);
    }
  }
  const total = Object.values(minutes).reduce((s, m) => s + m, 0);
  const pct = (m: number) => (total > 0 ? Math.round((m / total) * 100) : 0);
  const perWeek = (n: number) => Math.round((n / 8) * 10) / 10;
  return {
    asOf: today,
    startDate,
    ctlToday: Math.round(now[now.length - 1]?.ctl ?? 0),
    ctlAtStart: Math.round(projected[projected.length - 1]?.ctl ?? 0),
    hoursPerWeek: Math.round((total / 60 / 8) * 10) / 10,
    split: { swim: pct(minutes.swim), ride: pct(minutes.ride), run: pct(minutes.run), strength: pct(minutes.strength) },
    longestRideMin: Math.round(longestRideMin),
    longestRunMin: Math.round(longestRunMin),
    longestSwimM: Math.round(longestSwimM),
    sessionsPerWeek: {
      swim: perWeek(sessions.swim),
      ride: perWeek(sessions.ride),
      run: perWeek(sessions.run),
      strength: perWeek(sessions.strength),
    },
  };
}

