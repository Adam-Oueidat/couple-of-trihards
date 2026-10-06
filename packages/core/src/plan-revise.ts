import { SESSION_TYPES, type RawTrainingPlan } from "./plan";
import {
  mondayOf,
  WEEKDAYS,
  type DraftModelOutput,
  type DraftPhase,
  type DraftSession,
  type DraftWeek,
  type DraftWeekStats,
} from "./plan-agent";
import type { TrainingDiscipline } from "./recap";

/**
 * "Revise with coach": the athlete reads a draft and asks for a change in
 * their own words ("more running volume"). The coach first judges the request
 * against their data and the goal, then rewrites only the weeks that change;
 * every other week stays exactly as it was. This module is everything but the
 * model call.
 */

/** Revisions one draft can go through before the athlete has to start over. */
export const MAX_DRAFT_REVISIONS = 10;
export const MAX_FEEDBACK_LENGTH = 600;

/**
 * What the coach thinks of the request.
 * - agree: sound, done as asked.
 * - adjusted: the idea is right but as asked it would hurt, so the coach made
 *   its own version of it and says how that differs.
 * - advise_against: it would make the plan worse for the goal; nothing changed.
 */
export const REVISION_STANCES = ["agree", "adjusted", "advise_against"] as const;
export type RevisionStance = (typeof REVISION_STANCES)[number];

export interface RevisedWeek extends DraftWeek {
  /** 1-based week number in the draft. */
  week: number;
}

export interface ReviseModelOutput {
  stance: RevisionStance;
  /** The coach's take, addressed to the athlete. */
  message: string;
  why: string;
  assumptions: string[];
  /** Only the weeks that change, each in full. */
  weeks: RevisedWeek[];
}

const sessionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["day", "name", "discipline", "type", "km", "durationMin", "notes"],
  properties: {
    day: { type: "string", enum: [...WEEKDAYS] },
    name: { type: "string" },
    discipline: { type: "string", enum: ["swim", "ride", "run", "strength"] },
    type: { type: "string", enum: [...SESSION_TYPES] },
    km: { type: "number", description: "Planned km, or 0 when prescribed by time only." },
    durationMin: { type: "number" },
    notes: { type: "string", description: "How to do it, or an empty string." },
  },
};

export const PLAN_REVISE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["stance", "message", "why", "assumptions", "weeks"],
  properties: {
    stance: {
      type: "string",
      enum: [...REVISION_STANCES],
      description:
        "agree: the request is sound and you did it as asked. adjusted: right idea, but you changed how much or where, and say why. advise_against: it would hurt the plan, so weeks is empty.",
    },
    message: {
      type: "string",
      description:
        "Two to four plain sentences to the athlete: your honest view of the request using their numbers, and what you changed (or would do instead).",
    },
    why: { type: "string", description: "Why the plan is shaped this way, for the whole plan after your change." },
    assumptions: { type: "array", items: { type: "string" }, description: "The whole plan's assumptions after your change." },
    weeks: {
      type: "array",
      description: "Only the weeks that change, each rewritten in full with every session it holds. Leave every other week out.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["week", "phase", "focus", "sessions"],
        properties: {
          week: { type: "integer", description: "The week's number, 1 being the first week of the plan." },
          phase: { type: "string" },
          focus: { type: "string" },
          sessions: { type: "array", items: sessionSchema },
        },
      },
    },
  },
};

/** The parts of a draft a revision starts from. */
export interface DraftShape {
  plan: RawTrainingPlan;
  phases: DraftPhase[];
  weekFocus: string[];
  why: string;
  assumptions: string[];
}

/**
 * A dated draft back in the weeks-and-weekdays shape the model writes, so a
 * revision can be merged and expanded exactly as the first draft was.
 */
export function draftToModelOutput(draft: DraftShape): DraftModelOutput {
  const firstMonday = mondayOf(draft.plan.startDate);
  const phaseOf: string[] = [];
  for (const p of draft.phases) for (let i = 0; i < p.weeks; i++) phaseOf.push(p.name);
  const weeks: DraftWeek[] = draft.weekFocus.map((focus, w) => ({
    phase: phaseOf[w] ?? phaseOf[phaseOf.length - 1] ?? "Training",
    focus,
    sessions: [],
  }));
  for (const s of draft.plan.sessions) {
    const days = Math.round(
      (new Date(`${s.date}T00:00:00Z`).getTime() - new Date(`${firstMonday}T00:00:00Z`).getTime()) / 86_400_000,
    );
    const week = weeks[Math.floor(days / 7)];
    if (!week) continue;
    week.sessions.push({
      day: WEEKDAYS[days % 7],
      name: s.name,
      // Coach drafts always name the sport; the fallback mirrors buildTrainingPlan's.
      discipline: s.discipline ?? (draft.plan.discipline === "ride" || draft.plan.discipline === "swim" ? draft.plan.discipline : "run"),
      type: s.type,
      km: s.km,
      durationMin: s.durationMin ?? 0,
      notes: s.notes ?? "",
    } satisfies DraftSession);
  }
  return { name: draft.plan.name, why: draft.why, assumptions: draft.assumptions, weeks };
}

/**
 * Lay the coach's rewritten weeks over the current draft. Week numbers outside
 * the plan are ignored (a revision can't change its length), and a week given
 * twice keeps the last. Returns the 1-based numbers of the weeks that changed.
 */
export function mergeRevision(
  current: DraftModelOutput,
  revision: Pick<ReviseModelOutput, "weeks" | "why" | "assumptions">,
): { merged: DraftModelOutput; changedWeeks: number[] } {
  const weeks = current.weeks.map((w) => ({ ...w, sessions: [...w.sessions] }));
  const changed = new Set<number>();
  for (const r of revision.weeks ?? []) {
    const n = Math.round(Number(r.week));
    if (!(n >= 1 && n <= weeks.length)) continue;
    const next: DraftWeek = {
      phase: (r.phase ?? "").trim() || weeks[n - 1].phase,
      focus: (r.focus ?? "").trim() || weeks[n - 1].focus,
      sessions: r.sessions ?? [],
    };
    if (JSON.stringify(next) !== JSON.stringify(weeks[n - 1])) changed.add(n);
    weeks[n - 1] = next;
  }
  return {
    merged: {
      name: current.name,
      why: revision.why?.trim() || current.why,
      assumptions: revision.assumptions?.length ? revision.assumptions : current.assumptions,
      weeks,
    },
    changedWeeks: [...changed].sort((a, b) => a - b),
  };
}

const SPORTS: TrainingDiscipline[] = ["swim", "ride", "run", "strength"];

/** What a revision did, as the preview shows it. */
export interface RevisionSummary {
  feedback: string;
  insisted: boolean;
  stance: RevisionStance;
  message: string;
  changedWeeks: number[];
  /** Planned minutes over the whole plan by sport, before and after. */
  minutes: { before: Record<TrainingDiscipline, number>; after: Record<TrainingDiscipline, number> };
  /** Each week's total minutes before the change, for the chart's outline. */
  previousWeekMin: number[];
}

function totals(weeks: DraftWeekStats[]): Record<TrainingDiscipline, number> {
  const out: Record<TrainingDiscipline, number> = { swim: 0, ride: 0, run: 0, strength: 0 };
  for (const w of weeks) for (const s of SPORTS) out[s] += w.minutes[s];
  return out;
}

export function summarizeRevision(
  input: { feedback: string; insisted: boolean; stance: RevisionStance; message: string; changedWeeks: number[] },
  before: DraftWeekStats[],
  after: DraftWeekStats[],
): RevisionSummary {
  return {
    ...input,
    minutes: { before: totals(before), after: totals(after) },
    previousWeekMin: before.map((w) => w.totalMin),
  };
}

/** Each week's planned hours by sport, one line per week, for the coach to judge a request against. */
export function describeDraftWeeks(weeks: DraftWeekStats[], focus: string[]): string {
  const h = (min: number) => Math.round((min / 60) * 10) / 10;
  return weeks
    .map((w, i) => {
      const parts = SPORTS.filter((s) => w.minutes[s] > 0).map((s) => `${s} ${h(w.minutes[s])}h`);
      return `- Week ${i + 1} (from ${w.weekStart}, ${w.phase}${w.recovery ? ", recovery" : ""}): ${parts.join(", ") || "rest"}; total ${h(w.totalMin)}h${focus[i] ? ` — ${focus[i]}` : ""}`;
    })
    .join("\n");
}

/** Validate the athlete's revision request; messages are safe to show. */
export function parseRevisionRequest(input: unknown): { feedback: string } {
  const o = (input ?? {}) as Record<string, unknown>;
  const feedback = typeof o.feedback === "string" ? o.feedback.trim() : "";
  if (!feedback) throw new Error("Say what you'd like changed.");
  if (feedback.length > MAX_FEEDBACK_LENGTH) throw new Error(`Keep it under ${MAX_FEEDBACK_LENGTH} characters.`);
  return { feedback };
}
