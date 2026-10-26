import { buildTrainingPlan, type RawPlannedSession, type RawTrainingPlan } from "./plan";
import { WEEKDAYS, type PlanRequest } from "./plan-agent";

/**
 * Hand edits to a coach draft before it is saved: move a session to another
 * day, delete it, or change how long it is. Small changes like these should not
 * need a model call, so they are applied here and the preview's numbers are
 * recomputed with draftStats. Sessions are named by the id buildTrainingPlan
 * gives them, which is what the preview renders from.
 */

export const MIN_EDIT_MINUTES = 5;
export const MAX_EDIT_MINUTES = 600;

export type DraftEdit =
  | { sessionId: string; action: "move"; date: string }
  | { sessionId: string; action: "delete" }
  | { sessionId: string; action: "retime"; durationMin: number };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a request body into a DraftEdit. Throws a message safe to show. */
export function parseDraftEdit(input: unknown): DraftEdit {
  const body = (input ?? {}) as Record<string, unknown>;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) throw new Error("sessionId required");
  switch (body.edit) {
    case "move":
      if (typeof body.date !== "string" || !DATE_RE.test(body.date)) throw new Error("date must be YYYY-MM-DD");
      return { sessionId, action: "move", date: body.date };
    case "delete":
      return { sessionId, action: "delete" };
    case "retime": {
      const min = Math.round(Number(body.durationMin));
      if (!(min >= MIN_EDIT_MINUTES && min <= MAX_EDIT_MINUTES)) {
        throw new Error(`A session must be ${MIN_EDIT_MINUTES}–${MAX_EDIT_MINUTES} minutes.`);
      }
      return { sessionId, action: "retime", durationMin: min };
    }
    default:
      throw new Error("edit must be move, delete or retime");
  }
}

function weekdayOf(date: string) {
  return WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7];
}

/**
 * The plan with one edit applied. The draft keeps its dates and the days the
 * athlete said they can't train, the same limits a coach revision keeps, so a
 * later revision never has to undo a hand edit. Throws a message safe to show.
 */
export function applyDraftEdit(plan: RawTrainingPlan, edit: DraftEdit, request: PlanRequest): RawTrainingPlan {
  const index = buildTrainingPlan(plan).sessions.findIndex((s) => s.id === edit.sessionId);
  if (index < 0) throw new Error("That session is no longer in the draft.");
  const sessions = [...plan.sessions];
  const session = sessions[index];

  if (edit.action === "delete") {
    if (sessions.length === 1) throw new Error("A plan needs at least one session. Start over instead.");
    sessions.splice(index, 1);
  } else if (edit.action === "retime") {
    sessions[index] = { ...session, durationMin: edit.durationMin };
  } else {
    if (edit.date < plan.startDate || edit.date > plan.raceDate) {
      throw new Error("Sessions can only move to a day inside the plan.");
    }
    const day = weekdayOf(edit.date);
    if (request.unavailableDays?.includes(day)) throw new Error("You said you can't train that day.");
    // Same rule as expandDraft: two sessions with one name on one day would
    // share an id, and so share their edits once saved.
    const taken = new Set(sessions.filter((_, i) => i !== index && sessions[i].date === edit.date).map((s) => s.name));
    let name = session.name;
    for (let n = 2; taken.has(name); n++) name = `${session.name} (${n})`;
    sessions.splice(index, 1);
    const moved: RawPlannedSession = { ...session, date: edit.date, name };
    // Stored plans are in date order; a moved session goes after the others on its new day.
    const at = sessions.findIndex((s) => s.date > edit.date);
    sessions.splice(at < 0 ? sessions.length : at, 0, moved);
  }
  return { ...plan, sessions };
}
