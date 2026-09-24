import {
  buildTrainingPlan,
  SESSION_TYPES,
  type PlanOverrideMap,
  type RawPlannedSession,
  type RawTrainingPlan,
  type SessionType,
} from "./plan";
import { parseRawTrainingPlan } from "./plan-schema";
import type { TrainingDiscipline } from "./recap";

/**
 * "Adjust with coach": the athlete asks for a change in their own words, the
 * model proposes changes to upcoming sessions, and nothing is applied until
 * they approve. This module is everything but the model call.
 *
 * Coach changes rewrite the plan's own sessions; the athlete's edits live in
 * overrides layered on top. A session the athlete has touched (moved,
 * renamed, re-timed, skipped or removed) is theirs: the coach may not change
 * it, and a proposal that tries is shown as "kept". Past sessions are fixed.
 */

export type AdjustAction = "update" | "remove" | "add";

/** One change as the model writes it. */
export interface ProposedChange {
  action: AdjustAction;
  /** The session to update or remove; empty for an add. */
  sessionId: string;
  date: string;
  name: string;
  discipline: TrainingDiscipline;
  type: SessionType;
  km: number;
  durationMin: number;
  notes: string;
  /** A few words on why, shown beside the change. */
  why: string;
}

export interface AdjustModelOutput {
  /** The coach's reply to the athlete, two or three sentences. */
  message: string;
  changes: ProposedChange[];
}

export const PLAN_ADJUST_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["message", "changes"],
  properties: {
    message: {
      type: "string",
      description: "Your reply to the athlete in two or three plain sentences: what you'd change and why.",
    },
    changes: {
      type: "array",
      description: "Only the sessions that change. Leave everything else out.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "sessionId", "date", "name", "discipline", "type", "km", "durationMin", "notes", "why"],
        properties: {
          action: {
            type: "string",
            enum: ["update", "remove", "add"],
            description: "update rewrites a session (any field, including its date or sport); remove deletes it; add creates a new one.",
          },
          sessionId: { type: "string", description: "The [id] of the session to update or remove; empty string for add." },
          date: { type: "string", format: "date", description: "The session's date after the change (for remove: its current date)." },
          name: { type: "string" },
          discipline: { type: "string", enum: ["swim", "ride", "run", "strength"] },
          type: { type: "string", enum: [...SESSION_TYPES] },
          km: { type: "number", description: "Planned km, or 0 when prescribed by time only." },
          durationMin: { type: "number" },
          notes: { type: "string", description: "How to do it, or an empty string." },
          why: { type: "string", description: "A few words on why this session changes." },
        },
      },
    },
  },
};

/** A session as it stands, for the before side of a change. */
export interface SessionSnapshot {
  id: string;
  date: string;
  name: string;
  discipline: TrainingDiscipline;
  type: SessionType;
  km: number;
  durationMin?: number;
  notes?: string;
}

export interface CheckedChange {
  action: AdjustAction;
  before: SessionSnapshot | null;
  after: RawPlannedSession | null;
  why: string;
}

export interface CheckedAdjustment {
  /** Changes that will be applied. */
  changes: CheckedChange[];
  /** Changes the coach proposed to sessions the athlete owns; left alone. */
  kept: { before: SessionSnapshot; why: string }[];
  /** Proposals that could not be applied as written (unknown id, past date…). */
  rejected: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function snapshot(s: RawPlannedSession & { id: string }): SessionSnapshot {
  return {
    id: s.id,
    date: s.date,
    name: s.name,
    discipline: s.discipline!,
    type: s.type,
    km: s.km,
    ...(s.durationMin ? { durationMin: s.durationMin } : {}),
    ...(s.notes ? { notes: s.notes } : {}),
  };
}

function toRaw(c: ProposedChange): RawPlannedSession {
  return {
    date: c.date,
    name: (c.name ?? "").trim().slice(0, 110) || "Session",
    discipline: c.discipline,
    type: c.type,
    km: Math.max(0, Math.round((Number(c.km) || 0) * 10) / 10),
    ...(c.durationMin > 0 ? { durationMin: Math.round(c.durationMin) } : {}),
    ...(c.notes?.trim() ? { notes: c.notes.trim() } : {}),
  };
}

/**
 * Check the model's proposal against the plan as stored: only upcoming
 * sessions the athlete hasn't touched may change, and nothing may move into
 * the past or outside the plan.
 */
export function checkAdjustment(
  plan: RawTrainingPlan,
  overrides: PlanOverrideMap,
  output: AdjustModelOutput,
  today: string,
): CheckedAdjustment {
  const built = buildTrainingPlan(plan).sessions;
  const byId = new Map(built.map((s) => [s.id, s]));
  const end = plan.raceDate;
  const inWindow = (date: string) => DATE_RE.test(date) && date >= today && date >= plan.startDate && date <= end;

  const changes: CheckedChange[] = [];
  const kept: CheckedAdjustment["kept"] = [];
  const touched = new Set<string>();
  let rejected = 0;

  for (const c of output.changes ?? []) {
    const why = (c.why ?? "").trim().slice(0, 200);
    if (c.action === "add") {
      if (!inWindow(c.date)) { rejected++; continue; }
      changes.push({ action: "add", before: null, after: toRaw(c), why });
      continue;
    }
    const current = byId.get(c.sessionId);
    if (!current || touched.has(c.sessionId)) { rejected++; continue; }
    if (overrides[c.sessionId]) {
      kept.push({ before: snapshot(current), why });
      continue;
    }
    if (current.date < today) { rejected++; continue; }
    if (c.action === "remove") {
      touched.add(c.sessionId);
      changes.push({ action: "remove", before: snapshot(current), after: null, why });
      continue;
    }
    if (!inWindow(c.date)) { rejected++; continue; }
    touched.add(c.sessionId);
    changes.push({ action: "update", before: snapshot(current), after: toRaw(c), why });
  }
  return { changes, kept, rejected };
}

/**
 * The plan with the checked changes applied, re-validated. Untouched sessions
 * keep their date and name, so their ids and the athlete's edits carry over.
 */
export function applyAdjustment(plan: RawTrainingPlan, checked: CheckedAdjustment): RawTrainingPlan {
  const built = buildTrainingPlan(plan).sessions;
  const drop = new Set(checked.changes.flatMap((c) => (c.before ? [c.before.id] : [])));
  const sessions: RawPlannedSession[] = plan.sessions.filter((_, i) => !drop.has(built[i].id));
  const taken = new Set(sessions.map((s) => `${s.date}|${s.name}`));
  for (const c of checked.changes) {
    if (!c.after) continue;
    const s = { ...c.after };
    // Keep ids unique: a new session named like one already on that day
    // would share its id, and with it the athlete's edits.
    if (taken.has(`${s.date}|${s.name}`)) s.name = `${s.name} (coach)`;
    taken.add(`${s.date}|${s.name}`);
    sessions.push(s);
  }
  // Sessions of a single-sport plan inherit its sport; once the coach mixes in
  // another, every session has to name its own.
  const inherited = (plan.discipline === "ride" || plan.discipline === "swim" ? plan.discipline : "run") as TrainingDiscipline;
  const withSport = sessions.map((s) => ({ ...s, discipline: s.discipline ?? inherited }));
  const multi = new Set(withSport.map((s) => s.discipline)).size > 1;
  return parseRawTrainingPlan({
    ...plan,
    discipline: multi ? "multi" : plan.discipline,
    sessions: multi ? withSport : sessions,
  });
}

/**
 * The schedule the athlete sees when a newer plan takes over from one still
 * running: the older plan's sessions before the new start, then the new plan.
 * The coach adjusts this as one plan; splitAdjustment routes each change back
 * to the plan that owns it.
 */
export function joinForAdjust(carried: RawTrainingPlan | null, latest: RawTrainingPlan): RawTrainingPlan {
  if (!carried) return latest;
  const inherit = (p: RawTrainingPlan) =>
    (p.discipline === "ride" || p.discipline === "swim" ? p.discipline : "run") as TrainingDiscipline;
  const before = carried.sessions
    .filter((s) => s.date < latest.startDate)
    .map((s) => ({ ...s, discipline: s.discipline ?? inherit(carried) }));
  const after = latest.sessions.map((s) => ({ ...s, discipline: s.discipline ?? inherit(latest) }));
  return { ...latest, discipline: "multi", startDate: carried.startDate, sessions: [...before, ...after] };
}

/**
 * Splits changes checked against joinForAdjust's schedule between the two
 * plans: a session is changed in the plan it came from, and lands in the one
 * whose dates it falls in. A session moved across the boundary is removed
 * from one and added to the other.
 */
export function splitAdjustment(
  checked: CheckedAdjustment,
  carried: RawTrainingPlan,
  latest: RawTrainingPlan,
): { carried: CheckedAdjustment; latest: CheckedAdjustment } {
  const carriedIds = new Set(
    buildTrainingPlan(carried).sessions.filter((s) => s.date < latest.startDate).map((s) => s.id),
  );
  const out = {
    carried: { changes: [] as CheckedChange[], kept: [], rejected: 0 },
    latest: { changes: [] as CheckedChange[], kept: [], rejected: 0 },
  };
  const side = (isCarried: boolean) => (isCarried ? out.carried : out.latest);
  for (const c of checked.changes) {
    const from = c.before ? side(carriedIds.has(c.before.id)) : null;
    const to = c.after ? side(c.after.date < latest.startDate) : null;
    if (from && to && from !== to) {
      from.changes.push({ action: "remove", before: c.before, after: null, why: c.why });
      to.changes.push({ action: "add", before: null, after: c.after, why: c.why });
    } else {
      (from ?? to)!.changes.push(c);
    }
  }
  return out;
}
