import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { after } from "next/server";
import { getDb, planDrafts, type PlanDraftRow } from "@trihards/db";
import {
  createLogger,
  describeDraftWeeks,
  draftStats,
  draftToModelOutput,
  estimateRunThreshold,
  expandDraft,
  expectedLoadByDay,
  MAX_DRAFT_REVISIONS,
  matchSessions,
  mergeRevision,
  mondayOf,
  observedMaxHr,
  PLAN_BUILD_FALLBACK_MODEL,
  PLAN_BUILD_MODEL,
  PLAN_DRAFT_JSON_SCHEMA,
  PLAN_REVISE_JSON_SCHEMA,
  resolveZoneModel,
  startingPoint,
  summarizeRevision,
  TRAINING_HISTORY_WEEKS,
  weeksBetween,
  type DraftModelOutput,
  type DraftPhase,
  type DraftStats,
  type PlanRequest,
  type RawTrainingPlan,
  type ReviseModelOutput,
  type RevisionSummary,
  type StartingPoint,
} from "@trihards/core";
import { getAthleteDetail, getAthleteZones, getRecentActivities, type StravaIdentity } from "./strava";
import { getActiveTrainingPlan, saveTrainingPlan, type PlanSummary } from "./training-plans";
import { getOverrides } from "./plan-overrides";
import { getWorkouts } from "./workouts";
import { resolveToday } from "./coach-dates";
import { buildTrainingContext, COACH_SYSTEM_PROMPT } from "./coach";

const log = createLogger("plan-drafts");
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Plans the coach writes on request. Writing months of sessions can outlast
 * the 120 s App Runner gives a request, so a draft is a row: created
 * `pending`, filled in the background, then `ready` (or `failed`) for the Plan
 * page to pick up by polling. Nothing reaches the athlete's calendar until
 * they save it, and a saved draft becomes an ordinary training plan.
 */

/** A pending draft older than this was lost (a restart mid-generation). */
const STALE_PENDING_SECONDS = 15 * 60;

export interface StartingPointView extends StartingPoint {
  runThresholdSecPerKm: number | null;
  ftp: number | null;
  weightKg: number | null;
  /** The athlete's current plan, when it would still be running on the start date. */
  overlap: { name: string; endDate: string } | null;
}

export interface DraftResult {
  plan: RawTrainingPlan;
  why: string;
  assumptions: string[];
  phases: DraftPhase[];
  weekFocus: string[];
  dropped: number;
  stats: DraftStats;
  startingPoint: StartingPointView;
  /** On a revision: what the athlete asked, what the coach made of it, and what changed. */
  revision?: RevisionSummary;
}

export interface DraftView {
  id: string;
  status: PlanDraftRow["status"];
  error: string | null;
  createdAt: number;
  request: PlanRequest;
  result: DraftResult | null;
  /** The version this one revises, which "Back" returns to. */
  parentId: string | null;
  feedback: string | null;
  /** The athlete asked for this revision to be done as asked, over the coach's concerns. */
  insist: boolean;
  /** How many revisions deep this version is, 0 for the coach's first draft. */
  revision: number;
  revisionsLeft: number;
  /** While a revision is being written or has failed: the version it started from, still shown. */
  base: DraftResult | null;
}

function toView(row: PlanDraftRow, base: DraftResult | null = null): DraftView {
  return {
    id: row.id,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt,
    request: row.input as unknown as PlanRequest,
    result: (row.result as unknown as DraftResult | null) ?? null,
    parentId: row.parentId,
    feedback: row.feedback,
    insist: row.insist,
    revision: row.revision,
    revisionsLeft: Math.max(0, MAX_DRAFT_REVISIONS - row.revision),
    base,
  };
}

function planEnd(plan: { raceDate: string; sessions: { date: string }[] }): string {
  const last = plan.sessions[plan.sessions.length - 1]?.date ?? plan.raceDate;
  return last > plan.raceDate ? last : plan.raceDate;
}

/**
 * The facts the coach starts from, as of the plan's first day. Everything is
 * computed from the athlete's data; the model is handed numbers, not asked to
 * estimate them.
 */
export async function buildStartingPoint(identity: StravaIdentity, startDate: string) {
  const activities = await getRecentActivities(identity, TRAINING_HISTORY_WEEKS);
  const today = resolveToday(undefined, activities);
  const [active, overrides, workouts, athlete, zones] = await Promise.all([
    getActiveTrainingPlan(identity.userId),
    getOverrides(identity.userId),
    getWorkouts(identity.userId),
    getAthleteDetail(identity).catch(() => null),
    getAthleteZones(identity).catch(() => null),
  ]);

  // What is still on the calendar before day one counts toward the fitness
  // the new plan starts from — including the rest of a plan it replaces.
  const sessions = matchSessions(active?.plan ?? null, activities, overrides, today, workouts);
  const expected = expectedLoadByDay(sessions, workouts, today, startDate);
  const point = startingPoint(activities, today, startDate, expected);

  const threshold = estimateRunThreshold({
    plan: active?.plan ?? null,
    activities,
    overrides,
    customWorkouts: workouts,
    today,
    zones: resolveZoneModel(zones, observedMaxHr(activities)),
  });

  const end = active ? planEnd(active.plan) : null;
  const view: StartingPointView = {
    ...point,
    runThresholdSecPerKm: threshold?.secPerKm ?? null,
    ftp: athlete?.ftp ?? null,
    weightKg: athlete?.weight ?? null,
    overlap: active && end && end >= startDate ? { name: active.plan.name, endDate: end } : null,
  };
  return { view, activities, today };
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekdayName = (date: string) => WEEKDAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()];

function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  return h ? `${h}h ${Math.round(min % 60)}m` : `${Math.round(min)}m`;
}

/** The request as the coach reads it: the athlete's words, then the hard constraints and facts. */
function buildRequestMessage(request: PlanRequest, sp: StartingPointView): string {
  const firstMonday = mondayOf(request.startDate);
  const lines = [
    `# The athlete asked for a training plan`,
    `"${request.prompt}"`,
    ``,
    `## Dates`,
    `- The plan starts ${weekdayName(request.startDate)} ${request.startDate}. Week 1 is the week of Monday ${firstMonday}; days of week 1 before the start are dropped.`,
  ];
  if (request.raceDate) {
    lines.push(
      `- Race: ${request.raceName ?? "the goal race"} on ${weekdayName(request.raceDate)} ${request.raceDate}. The plan has exactly ${weeksBetween(request.startDate, request.raceDate)} weeks; the last week contains the race itself as a session of type "race" on that weekday, after a taper.`,
    );
  } else {
    lines.push(
      `- No race date. Choose the number of weeks the goal needs (at most 52), say how many in the assumptions, and end the plan with a lighter week. If the goal implies a race, put it on the final weekend as a session of type "race".`,
    );
  }
  lines.push(``, `## Constraints`);
  lines.push(
    request.maxHoursPerWeek
      ? `- At most ${request.maxHoursPerWeek} hours in any week, reached only at the peak.`
      : `- No weekly cap given: build from the current ${sp.hoursPerWeek} h/week at a rate this athlete can absorb.`,
  );
  if (request.unavailableDays?.length) {
    lines.push(`- Never schedule anything on: ${request.unavailableDays.join(", ")}.`);
  }
  lines.push(
    ``,
    `## Starting point (computed from their data as of ${sp.asOf})`,
    `- Fitness (CTL) today ${sp.ctlToday}; projected on the start date ${sp.ctlAtStart}.`,
    `- Last 8 weeks: ${sp.hoursPerWeek} h/week; time split swim ${sp.split.swim}% / ride ${sp.split.ride}% / run ${sp.split.run}% / strength ${sp.split.strength}%.`,
    `- Sessions per week: swim ${sp.sessionsPerWeek.swim}, ride ${sp.sessionsPerWeek.ride}, run ${sp.sessionsPerWeek.run}, strength ${sp.sessionsPerWeek.strength}.`,
    `- Longest in 12 weeks: ride ${fmtMin(sp.longestRideMin)}, run ${fmtMin(sp.longestRunMin)}, swim ${sp.longestSwimM} m.`,
  );
  if (sp.overlap) {
    lines.push(
      `- Their current plan "${sp.overlap.name}" runs until ${sp.overlap.endDate}; it ends when this one starts, and its sessions before then are already counted in the projected fitness.`,
    );
  }
  lines.push(
    ``,
    `## How to build it`,
    `- Periodise for the goal: base, build, race-specific, peak and taper as the timeline allows. Progress load gradually and put a recovery week (roughly 60–70% of the week before) every third or fourth week.`,
    `- Weight the sports toward what the goal and this athlete's gaps need, not their current habits.`,
    `- Include 1–2 strength sessions a week through base and build, shorter maintenance work later, and none in the final 10 days.`,
    `- A brick is two sessions on the same day: the ride, then the run.`,
    `- Keep long sessions on the weekend unless those days are blocked, and leave at least one rest day a week.`,
    `- Give every session a duration. Give swims and runs a distance where it is the natural target; rides can be time only (km 0).`,
    `- Notes say how to do the session (structure, zones, targets) using their thresholds where known.`,
    `- The rationale speaks to the athlete in plain words; the assumptions are things they should check.`,
  );
  return lines.join("\n");
}

async function generate(row: PlanDraftRow, identity: StravaIdentity): Promise<DraftResult> {
  const request = row.input as unknown as PlanRequest;
  const { view: sp, activities, today } = await buildStartingPoint(identity, request.startDate);
  const { identity: coachIdentity, context } = await buildTrainingContext(identity, activities, today);

  // Streamed: a full plan is tens of thousands of output tokens. Structured
  // output keeps it in the weeks-and-weekdays shape expandDraft dates.
  const stream = anthropic.beta.messages.stream({
    model: PLAN_BUILD_MODEL,
    betas: ["server-side-fallback-2026-06-01"],
    fallbacks: [{ model: PLAN_BUILD_FALLBACK_MODEL }],
    max_tokens: 64000,
    system: [
      { type: "text", text: COACH_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      { type: "text", text: coachIdentity, cache_control: { type: "ephemeral" } },
      { type: "text", text: context },
    ],
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: PLAN_DRAFT_JSON_SCHEMA },
    },
    messages: [{ role: "user", content: buildRequestMessage(request, sp) }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") throw new Error("The coach couldn't write this plan. Try rewording the request.");
  if (message.stop_reason === "max_tokens") throw new Error("That plan came out too long to finish. Try a shorter timeline.");
  const output = readJson<DraftModelOutput>(message);

  const draft = expandDraft(output, request);
  const stats = draftStats(draft, activities);
  log.info("plan draft generated", {
    draftId: row.id,
    weeks: stats.weeks.length,
    sessions: draft.plan.sessions.length,
    dropped: draft.dropped,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  });
  return { ...draft, stats, startingPoint: sp };
}

function readJson<T>(message: Anthropic.Beta.BetaMessage): T {
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("The coach's plan couldn't be read. Try again.");
  }
}

/** The feedback behind every earlier revision of this draft, oldest first. */
async function earlierFeedback(row: PlanDraftRow): Promise<string[]> {
  const out: string[] = [];
  let parentId = row.parentId;
  for (let i = 0; parentId && i <= MAX_DRAFT_REVISIONS; i++) {
    const [parent] = await getDb().select().from(planDrafts).where(eq(planDrafts.id, parentId));
    if (!parent) break;
    if (parent.feedback) out.unshift(parent.feedback);
    parentId = parent.parentId;
  }
  return out;
}

/** The athlete's change request as the coach reads it, after the draft it changes. */
function buildRevisionMessage(
  feedback: string,
  insist: boolean,
  earlier: string[],
  base: DraftResult,
  request: PlanRequest,
): string {
  const weeks = base.stats.weeks.length;
  const lines = [`# The athlete wants to change this draft`, `"${feedback}"`];
  if (insist) {
    lines.push(
      ``,
      `They have read your concerns about this and want it done as they asked. Make the change as asked, within the hard constraints below; in your message, say plainly what to watch for. Use stance "agree".`,
    );
  }
  if (earlier.length) {
    lines.push(``, `## Changes they asked for earlier in this draft (already in it; keep them)`, ...earlier.map((f) => `- "${f}"`));
  }
  lines.push(
    ``,
    `## The draft as it stands: planned hours by week`,
    describeDraftWeeks(base.stats.weeks, base.weekFocus),
    ``,
    `## First, judge the request`,
    `You are their coach, not a form: weigh what they asked against their starting point, their recent training (in the context above) and the goal. Check how fast it ramps volume in that sport compared with what they have done lately (sessions a week, longest session, the ~10% a week guide), injury risk, whether it eats into recovery weeks or the taper, the balance the goal needs, and the weekly cap.`,
    `- stance "agree": the request is sound. Do it as asked.`,
    `- stance "adjusted": the idea is right but, as asked, it would hurt (too steep, too late, too close to the race). Make your better version of it and say exactly how it differs from what they asked and why.`,
    `- stance "advise_against": it would make the plan worse for their goal. Change nothing (weeks: []), say why, and what you would do instead.`,
    `The message speaks to the athlete in two to four plain sentences and uses their numbers.`,
    ``,
    `## Then, change only what needs changing`,
    `- Return only the weeks that change, each rewritten in full: every session in that week, unchanged ones included, and its week number (1–${weeks}). Weeks you leave out stay exactly as they are.`,
    `- The plan keeps its ${weeks} weeks and its dates; a revision cannot move the start or the race.`,
  );
  if (request.maxHoursPerWeek) lines.push(`- Still at most ${request.maxHoursPerWeek} hours in any week.`);
  if (request.unavailableDays?.length) lines.push(`- Still nothing on: ${request.unavailableDays.join(", ")}.`);
  lines.push(`- Return why and assumptions for the whole plan as it will be after your change.`);
  return lines.join("\n");
}

async function generateRevision(row: PlanDraftRow, parent: PlanDraftRow, identity: StravaIdentity): Promise<DraftResult> {
  const request = row.input as unknown as PlanRequest;
  const base = parent.result as unknown as DraftResult;
  const [{ view: sp, activities, today }, earlier] = await Promise.all([
    buildStartingPoint(identity, request.startDate),
    earlierFeedback(row),
  ]);
  const { identity: coachIdentity, context } = await buildTrainingContext(identity, activities, today);
  const current = draftToModelOutput(base);
  const numbered = { ...current, weeks: current.weeks.map((w, i) => ({ week: i + 1, ...w })) };

  // The coach sees its own draft as its earlier answer, then the athlete's
  // reply, and writes back only the weeks it changes.
  const stream = anthropic.beta.messages.stream({
    model: PLAN_BUILD_MODEL,
    betas: ["server-side-fallback-2026-06-01"],
    fallbacks: [{ model: PLAN_BUILD_FALLBACK_MODEL }],
    max_tokens: 64000,
    system: [
      { type: "text", text: COACH_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      { type: "text", text: coachIdentity, cache_control: { type: "ephemeral" } },
      { type: "text", text: context },
    ],
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: PLAN_REVISE_JSON_SCHEMA },
    },
    messages: [
      { role: "user", content: buildRequestMessage(request, sp) },
      { role: "assistant", content: JSON.stringify(numbered) },
      { role: "user", content: buildRevisionMessage(row.feedback ?? "", row.insist, earlier, base, request) },
    ],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") throw new Error("The coach couldn't make that change. Try rewording it.");
  if (message.stop_reason === "max_tokens") throw new Error("That change came out too long to finish. Try asking for less at once.");
  const output = readJson<ReviseModelOutput>(message);

  const { merged, changedWeeks } = mergeRevision(current, output);
  const draft = expandDraft(merged, request);
  const stats = draftStats(draft, activities);
  log.info("plan draft revised", {
    draftId: row.id,
    parentId: parent.id,
    stance: output.stance,
    changedWeeks: changedWeeks.length,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  });
  return {
    ...draft,
    stats,
    startingPoint: sp,
    revision: summarizeRevision(
      {
        feedback: row.feedback ?? "",
        insisted: row.insist,
        stance: output.stance,
        message: (output.message ?? "").trim(),
        changedWeeks,
      },
      base.stats.weeks,
      stats.weeks,
    ),
  };
}

async function setStatus(
  id: string,
  patch: Partial<Pick<PlanDraftRow, "status" | "result" | "error">>,
  onlyIfPending = false,
) {
  await getDb()
    .update(planDrafts)
    .set({ ...patch, updatedAt: Math.floor(Date.now() / 1000) })
    .where(onlyIfPending ? and(eq(planDrafts.id, id), eq(planDrafts.status, "pending")) : eq(planDrafts.id, id));
}

async function run(row: PlanDraftRow, identity: StravaIdentity, parent?: PlanDraftRow) {
  try {
    const result = parent ? await generateRevision(row, parent, identity) : await generate(row, identity);
    // Only if still pending: a draft discarded or superseded meanwhile stays gone.
    await setStatus(row.id, { status: "ready", result: result as unknown as Record<string, unknown> }, true);
  } catch (err) {
    log.error("plan draft failed", { draftId: row.id, error: err instanceof Error ? err.message : String(err) });
    const message =
      err instanceof Anthropic.APIError
        ? "The coach is unavailable right now. Try again in a minute."
        : err instanceof Error
          ? err.message
          : "Something went wrong building the plan.";
    await setStatus(row.id, { status: "failed", error: message }, true);
  }
}

/** Starts a draft and returns at once; the plan is written in the background. */
export async function startDraft(identity: StravaIdentity, request: PlanRequest): Promise<DraftView> {
  const current = await getOpenDraft(identity.userId);
  if (current?.status === "pending") return current;

  const [row] = await getDb()
    .insert(planDrafts)
    .values({
      id: crypto.randomUUID(),
      userId: identity.userId,
      status: "pending",
      input: request as unknown as Record<string, unknown>,
    })
    .returning();
  runInBackground(row, identity);
  return toView(row);
}

function runInBackground(row: PlanDraftRow, identity: StravaIdentity, parent?: PlanDraftRow) {
  try {
    after(() => run(row, identity, parent));
  } catch {
    void run(row, identity, parent);
  }
}

/**
 * Ask the coach to change a ready draft. The revision is a new version that
 * starts pending; the one it changes stays as it is, for "Back".
 */
export async function reviseDraft(
  identity: StravaIdentity,
  id: string,
  feedback: string,
  insist: boolean,
): Promise<DraftView> {
  const parent = await ownedDraft(identity.userId, id);
  if (!parent || parent.status !== "ready" || !parent.result) throw new Error("That draft isn't ready to change.");
  if (parent.revision >= MAX_DRAFT_REVISIONS) {
    throw new Error(`This draft has been revised ${MAX_DRAFT_REVISIONS} times. Save it and adjust from there, or start over.`);
  }
  const [row] = await getDb()
    .insert(planDrafts)
    .values({
      id: crypto.randomUUID(),
      userId: identity.userId,
      status: "pending",
      input: parent.input,
      parentId: parent.id,
      feedback,
      insist,
      revision: parent.revision + 1,
    })
    .returning();
  runInBackground(row, identity, parent);
  return toView(row, parent.result as unknown as DraftResult);
}

/** The athlete's latest draft that is neither saved nor discarded, if any. */
export async function getOpenDraft(userId: string): Promise<DraftView | null> {
  const [row] = await getDb()
    .select()
    .from(planDrafts)
    .where(and(eq(planDrafts.userId, userId), inArray(planDrafts.status, ["pending", "ready", "failed"])))
    .orderBy(desc(planDrafts.createdAt))
    .limit(1);
  if (!row) return null;
  const base = row.status !== "ready" && row.parentId ? await parentResult(row.parentId) : null;
  if (row.status === "pending" && Date.now() / 1000 - row.updatedAt > STALE_PENDING_SECONDS) {
    const error = "Building the plan was interrupted. Try again.";
    await setStatus(row.id, { status: "failed", error });
    return { ...toView(row, base), status: "failed", error };
  }
  return toView(row, base);
}

async function parentResult(id: string): Promise<DraftResult | null> {
  const [row] = await getDb().select({ result: planDrafts.result }).from(planDrafts).where(eq(planDrafts.id, id));
  return (row?.result as unknown as DraftResult | null) ?? null;
}

async function ownedDraft(userId: string, id: string): Promise<PlanDraftRow | null> {
  const [row] = await getDb()
    .select()
    .from(planDrafts)
    .where(and(eq(planDrafts.id, id), eq(planDrafts.userId, userId)));
  return row ?? null;
}

/** Makes a ready draft the athlete's plan. Throws a message safe to show. */
export async function saveDraft(userId: string, id: string): Promise<PlanSummary> {
  const row = await ownedDraft(userId, id);
  if (!row) throw new Error("That draft no longer exists.");
  if (row.status !== "ready" || !row.result) throw new Error("That draft isn't ready to save.");
  const summary = await saveTrainingPlan(userId, (row.result as unknown as DraftResult).plan);
  await setStatus(id, { status: "saved" });
  // Earlier versions of it are done with too, or one would resurface as the open draft.
  await discardOpen(userId, id);
  log.info("plan draft saved", { draftId: id, planId: summary.id, revision: row.revision });
  return summary;
}

/** Start over: the draft goes, with every earlier version of it. */
export async function discardDraft(userId: string, id: string): Promise<boolean> {
  const row = await ownedDraft(userId, id);
  if (!row || row.status === "saved") return false;
  await discardOpen(userId);
  return true;
}

/**
 * "Do it as I asked": the coach adjusted or advised against a revision, and
 * the athlete wants it as they asked. Replaces that revision with one made
 * from the same version and the same words, marked as insisted.
 */
export async function insistDraft(identity: StravaIdentity, id: string): Promise<DraftView> {
  const row = await ownedDraft(identity.userId, id);
  if (!row || row.status !== "ready" || !row.parentId || !row.feedback || row.insist) {
    throw new Error("There's nothing to redo here.");
  }
  await setStatus(id, { status: "discarded" });
  return reviseDraft(identity, row.parentId, row.feedback, true);
}

/** Back: drop this revision, so the version it changed is the open draft again. */
export async function revertDraft(userId: string, id: string): Promise<DraftView> {
  const row = await ownedDraft(userId, id);
  if (!row || row.status === "saved" || row.status === "discarded" || !row.parentId) {
    throw new Error("There's no earlier version to go back to.");
  }
  const parent = await ownedDraft(userId, row.parentId);
  if (!parent || parent.status !== "ready") throw new Error("There's no earlier version to go back to.");
  await setStatus(id, { status: "discarded" });
  return toView(parent);
}

async function discardOpen(userId: string, except?: string) {
  await getDb()
    .update(planDrafts)
    .set({ status: "discarded", updatedAt: Math.floor(Date.now() / 1000) })
    .where(
      and(
        eq(planDrafts.userId, userId),
        inArray(planDrafts.status, ["pending", "ready", "failed"]),
        ...(except ? [ne(planDrafts.id, except)] : []),
      ),
    );
}
