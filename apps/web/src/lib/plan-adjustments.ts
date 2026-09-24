import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, inArray } from "drizzle-orm";
import { after } from "next/server";
import { getDb, planAdjustments, type PlanAdjustmentRow } from "@trihards/db";
import {
  applyAdjustment,
  buildTrainingPlan,
  checkAdjustment,
  joinForAdjust,
  splitAdjustment,
  createLogger,
  matchSessions,
  PLAN_ADJUST_JSON_SCHEMA,
  PLAN_BUILD_FALLBACK_MODEL,
  PLAN_BUILD_MODEL,
  TRAINING_HISTORY_WEEKS,
  type AdjustModelOutput,
  type CheckedAdjustment,
  type RawPlannedSession,
  type RawTrainingPlan,
} from "@trihards/core";
import { getRecentActivities, type StravaIdentity } from "./strava";
import { getAdjustablePlans, replacePlanSessions, type StoredPlan } from "./training-plans";
import { getOverrides } from "./plan-overrides";
import { getWorkouts } from "./workouts";
import { resolveToday } from "./coach-dates";
import { buildTrainingContext, COACH_SYSTEM_PROMPT } from "./coach";

const log = createLogger("plan-adjustments");
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * "Adjust with coach". The athlete says what's changed; the coach proposes
 * changes to upcoming sessions; nothing is applied until they approve. Written
 * in the background (like plan drafts) because a considered answer can take
 * longer than a request may. On apply, the proposal is checked again against
 * the plan as it is then, so an edit the athlete made meanwhile is kept, and
 * the sessions it replaced are stored for undo.
 */

const STALE_PENDING_SECONDS = 10 * 60;
/** How long the "applied — undo" note stays on the Plan page. */
const UNDO_WINDOW_SECONDS = 24 * 3600;
const MAX_REQUEST_LENGTH = 600;

export interface AdjustmentResult {
  message: string;
  /** The model's proposal as written, re-checked on apply. */
  proposal: AdjustModelOutput;
  checked: CheckedAdjustment;
  /** Set once applied: each changed plan's sessions before, and after, by plan id, for undo. */
  previous?: Record<string, RawPlannedSession[]>;
  appliedSessions?: Record<string, RawPlannedSession[]>;
  /** The athlete closed the "applied" note; the change itself stands. */
  dismissed?: boolean;
  /** The applied change was undone. */
  undone?: boolean;
}

export interface AdjustmentView {
  id: string;
  status: PlanAdjustmentRow["status"];
  request: string;
  error: string | null;
  createdAt: number;
  result: AdjustmentResult | null;
}

function toView(row: PlanAdjustmentRow): AdjustmentView {
  return {
    id: row.id,
    status: row.status,
    request: row.request,
    error: row.error,
    createdAt: row.createdAt,
    result: (row.result as unknown as AdjustmentResult | null) ?? null,
  };
}

async function setRow(id: string, patch: Partial<Pick<PlanAdjustmentRow, "status" | "result" | "error">>) {
  await getDb()
    .update(planAdjustments)
    .set({ ...patch, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(planAdjustments.id, id));
}

/**
 * The schedule the coach adjusts: the latest plan, with the older plan's
 * sessions in front when they carry on until it starts. Null when the plan the
 * adjustment was asked of is no longer the latest.
 */
async function adjustable(userId: string, planId?: string) {
  const plans = await getAdjustablePlans(userId);
  if (!plans || (planId && plans.latest.id !== planId)) return null;
  return { ...plans, joined: joinForAdjust(plans.carried?.raw ?? null, plans.latest.raw) };
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dow = (date: string) => WEEKDAY[new Date(`${date}T12:00:00Z`).getUTCDay()];

async function propose(row: PlanAdjustmentRow, identity: StravaIdentity): Promise<AdjustmentResult> {
  const [plans, overrides, workouts, activities] = await Promise.all([
    adjustable(identity.userId, row.planId),
    getOverrides(identity.userId),
    getWorkouts(identity.userId),
    getRecentActivities(identity, TRAINING_HISTORY_WEEKS),
  ]);
  if (!plans) throw new Error("Your plan changed while the coach was working. Ask again.");
  const { joined } = plans;
  const today = resolveToday(undefined, activities);
  const { identity: coachIdentity, context } = await buildTrainingContext(identity, activities, today);

  // Every upcoming session, with the ones the athlete owns marked, plus the
  // last two weeks graded so the coach can see how things have been going.
  const graded = matchSessions(buildTrainingPlan(joined), activities, overrides, today, workouts);
  const since = new Date(`${today}T12:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 14);
  const recentFrom = since.toISOString().slice(0, 10);
  const line = (s: (typeof graded)[number]) => {
    const what = [s.discipline, s.type, s.km > 0 ? `${s.km}km` : null, s.durationMin ? `${s.durationMin}min` : null]
      .filter(Boolean)
      .join(", ");
    const owned = overrides[s.id] ? " — THE ATHLETE EDITED THIS ONE: do not change it" : "";
    return `- [id: ${s.id}] ${dow(s.date)} ${s.date} "${s.name}" (${what})${s.notes ? ` — ${s.notes}` : ""}${owned}`;
  };
  const recent = graded.filter((s) => !s.isCustom && s.date >= recentFrom && s.date < today);
  const upcoming = graded.filter((s) => !s.isCustom && s.date >= today);

  const request = [
    `# The athlete asks you to adjust their plan "${plans.latest.raw.name}"`,
    `"${row.request}"`,
    ``,
    `Today is ${dow(today)} ${today}. The plan runs to ${joined.raceDate}${joined.raceName ? ` (${joined.raceName})` : ""}.`,
    ``,
    `## The last two weeks, graded`,
    recent.map((s) => `${line(s)} [${s.status}]`).join("\n") || "None",
    ``,
    `## Upcoming sessions (change only these)`,
    upcoming.map(line).join("\n") || "None",
    ``,
    `## How to answer`,
    `- Change as little as does the job, and only sessions on or after today. Keep the plan's overall direction unless the athlete asks otherwise.`,
    `- Never change a session marked as edited by the athlete. If it matters, say so in your message instead.`,
    `- To swap a session's sport, update it with the new sport; to drop one, remove it; add only when something new is needed.`,
    `- For update and add, give the full session as it should be. For remove, repeat its id and date.`,
    `- Your message speaks to the athlete: what you'd change and why, in two or three sentences.`,
  ].join("\n");

  const stream = anthropic.beta.messages.stream({
    model: PLAN_BUILD_MODEL,
    betas: ["server-side-fallback-2026-06-01"],
    fallbacks: [{ model: PLAN_BUILD_FALLBACK_MODEL }],
    max_tokens: 32000,
    system: [
      { type: "text", text: COACH_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      { type: "text", text: coachIdentity, cache_control: { type: "ephemeral" } },
      { type: "text", text: context },
    ],
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: PLAN_ADJUST_JSON_SCHEMA },
    },
    messages: [{ role: "user", content: request }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error("The coach couldn't answer that. Try rewording it.");
  if (message.stop_reason === "max_tokens") throw new Error("That change is too big to propose at once. Try a narrower request.");

  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  let proposal: AdjustModelOutput;
  try {
    proposal = JSON.parse(text) as AdjustModelOutput;
  } catch {
    throw new Error("The coach's answer couldn't be read. Try again.");
  }
  const checked = checkAdjustment(joined, overrides, proposal, today);
  log.info("plan adjustment proposed", {
    adjustmentId: row.id,
    changes: checked.changes.length,
    kept: checked.kept.length,
    rejected: checked.rejected,
    outputTokens: message.usage.output_tokens,
  });
  return { message: (proposal.message ?? "").trim(), proposal, checked };
}

async function run(row: PlanAdjustmentRow, identity: StravaIdentity) {
  try {
    const result = await propose(row, identity);
    await setRow(row.id, { status: "ready", result: result as unknown as Record<string, unknown> });
  } catch (err) {
    log.error("plan adjustment failed", { adjustmentId: row.id, error: err instanceof Error ? err.message : String(err) });
    const error =
      err instanceof Anthropic.APIError
        ? "The coach is unavailable right now. Try again in a minute."
        : err instanceof Error
          ? err.message
          : "Something went wrong.";
    await setRow(row.id, { status: "failed", error });
  }
}

/** Asks the coach for a change; returns the pending request at once. */
export async function startAdjustment(identity: StravaIdentity, text: unknown): Promise<AdjustmentView> {
  const requestText = typeof text === "string" ? text.trim() : "";
  if (!requestText) throw new Error("Say what should change.");
  if (requestText.length > MAX_REQUEST_LENGTH) throw new Error(`Keep it under ${MAX_REQUEST_LENGTH} characters.`);
  const plans = await getAdjustablePlans(identity.userId);
  if (!plans) throw new Error("There's no plan to adjust yet.");

  // One conversation at a time: a new request replaces an unapplied one.
  await getDb()
    .update(planAdjustments)
    .set({ status: "discarded", updatedAt: Math.floor(Date.now() / 1000) })
    .where(and(eq(planAdjustments.userId, identity.userId), inArray(planAdjustments.status, ["pending", "ready", "failed"])));

  const [row] = await getDb()
    .insert(planAdjustments)
    .values({ id: crypto.randomUUID(), userId: identity.userId, planId: plans.latest.id, status: "pending", request: requestText })
    .returning();
  try {
    after(() => run(row, identity));
  } catch {
    void run(row, identity);
  }
  return toView(row);
}

/** The latest adjustment still waiting on the athlete, or just applied (for undo). */
export async function getOpenAdjustment(userId: string): Promise<AdjustmentView | null> {
  const [row] = await getDb()
    .select()
    .from(planAdjustments)
    .where(and(eq(planAdjustments.userId, userId), inArray(planAdjustments.status, ["pending", "ready", "failed", "applied"])))
    .orderBy(desc(planAdjustments.createdAt))
    .limit(1);
  if (!row) return null;
  if (row.status === "applied") {
    const result = row.result as unknown as AdjustmentResult | null;
    if (result?.dismissed || Date.now() / 1000 - row.updatedAt > UNDO_WINDOW_SECONDS) return null;
  }
  if (row.status === "pending" && Date.now() / 1000 - row.updatedAt > STALE_PENDING_SECONDS) {
    const error = "The coach was interrupted. Ask again.";
    await setRow(row.id, { status: "failed", error });
    return { ...toView(row), status: "failed", error };
  }
  return toView(row);
}

async function owned(userId: string, id: string): Promise<PlanAdjustmentRow | null> {
  const [row] = await getDb()
    .select()
    .from(planAdjustments)
    .where(and(eq(planAdjustments.id, id), eq(planAdjustments.userId, userId)));
  return row ?? null;
}

/**
 * Applies a ready proposal, re-checked against the plan and the athlete's
 * edits as they are now. Returns how many changes went in.
 */
export async function applyAdjustmentById(identity: StravaIdentity, id: string): Promise<number> {
  const row = await owned(identity.userId, id);
  if (!row || row.status !== "ready" || !row.result) throw new Error("That proposal isn't ready to apply.");
  const result = row.result as unknown as AdjustmentResult;
  const [plans, overrides, activities] = await Promise.all([
    adjustable(identity.userId, row.planId),
    getOverrides(identity.userId),
    getRecentActivities(identity, TRAINING_HISTORY_WEEKS),
  ]);
  if (!plans) throw new Error("Your plan has changed since. Ask the coach again.");
  const checked = checkAdjustment(plans.joined, overrides, result.proposal, resolveToday(undefined, activities));
  // Each change goes to the plan that owns the session.
  const parts: [StoredPlan, CheckedAdjustment][] = plans.carried
    ? (() => {
        const split = splitAdjustment(checked, plans.carried.raw, plans.latest.raw);
        return [
          [plans.carried, split.carried],
          [plans.latest, split.latest],
        ];
      })()
    : [[plans.latest, checked]];
  const previous: Record<string, RawPlannedSession[]> = {};
  const appliedSessions: Record<string, RawPlannedSession[]> = {};
  for (const [plan, part] of parts) {
    if (!part.changes.length) continue;
    const next: RawTrainingPlan = applyAdjustment(plan.raw, part);
    await replacePlanSessions(identity.userId, plan.id, next);
    previous[plan.id] = plan.raw.sessions;
    appliedSessions[plan.id] = next.sessions;
  }
  await setRow(id, {
    status: "applied",
    result: { ...result, checked, previous, appliedSessions } as unknown as Record<string, unknown>,
  });
  log.info("plan adjustment applied", { adjustmentId: id, changes: checked.changes.length });
  return checked.changes.length;
}

/** Puts back the sessions an applied adjustment replaced, if nothing has changed the plan since. */
export async function undoAdjustment(userId: string, id: string): Promise<void> {
  const row = await owned(userId, id);
  const result = row?.result as unknown as AdjustmentResult | undefined;
  if (!row || row.status !== "applied" || !result?.previous) throw new Error("There's nothing to undo.");
  const plans = await getAdjustablePlans(userId);
  const byId = new Map([plans?.latest, plans?.carried].flatMap((p) => (p ? [[p.id, p] as const] : [])));
  const ids = Object.keys(result.previous);
  const unchanged =
    plans?.latest.id === row.planId &&
    ids.every((pid) => JSON.stringify(byId.get(pid)?.raw.sessions) === JSON.stringify(result.appliedSessions?.[pid]));
  if (!unchanged) throw new Error("The plan has changed since, so this can't be undone automatically.");
  for (const pid of ids) {
    const plan = byId.get(pid)!;
    await replacePlanSessions(userId, pid, { ...plan.raw, sessions: result.previous[pid] });
  }
  await setRow(id, { status: "discarded", result: { ...result, undone: true } as unknown as Record<string, unknown> });
}

export async function discardAdjustment(userId: string, id: string): Promise<boolean> {
  const row = await owned(userId, id);
  if (!row || row.status === "applied") return false;
  await setRow(id, { status: "discarded" });
  return true;
}

/** Hides an applied adjustment's undo banner. */
export async function dismissAdjustment(userId: string, id: string): Promise<void> {
  const row = await owned(userId, id);
  if (row?.status === "applied" && row.result) {
    await setRow(id, { result: { ...row.result, dismissed: true } });
  }
}
