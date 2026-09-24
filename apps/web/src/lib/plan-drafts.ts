import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, inArray } from "drizzle-orm";
import { after } from "next/server";
import { getDb, planDrafts, type PlanDraftRow } from "@trihards/db";
import {
  createLogger,
  draftStats,
  estimateRunThreshold,
  expandDraft,
  expectedLoadByDay,
  matchSessions,
  mondayOf,
  observedMaxHr,
  PLAN_BUILD_FALLBACK_MODEL,
  PLAN_BUILD_MODEL,
  PLAN_DRAFT_JSON_SCHEMA,
  resolveZoneModel,
  startingPoint,
  TRAINING_HISTORY_WEEKS,
  weeksBetween,
  type DraftModelOutput,
  type DraftPhase,
  type DraftStats,
  type PlanRequest,
  type RawTrainingPlan,
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
}

export interface DraftView {
  id: string;
  status: PlanDraftRow["status"];
  error: string | null;
  createdAt: number;
  request: PlanRequest;
  result: DraftResult | null;
}

function toView(row: PlanDraftRow): DraftView {
  return {
    id: row.id,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt,
    request: row.input as unknown as PlanRequest,
    result: (row.result as unknown as DraftResult | null) ?? null,
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

  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  let output: DraftModelOutput;
  try {
    output = JSON.parse(text) as DraftModelOutput;
  } catch {
    throw new Error("The coach's plan couldn't be read. Try again.");
  }

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

async function setStatus(id: string, patch: Partial<Pick<PlanDraftRow, "status" | "result" | "error">>) {
  await getDb()
    .update(planDrafts)
    .set({ ...patch, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(planDrafts.id, id));
}

async function run(row: PlanDraftRow, identity: StravaIdentity) {
  try {
    const result = await generate(row, identity);
    await setStatus(row.id, { status: "ready", result: result as unknown as Record<string, unknown> });
  } catch (err) {
    log.error("plan draft failed", { draftId: row.id, error: err instanceof Error ? err.message : String(err) });
    const message =
      err instanceof Anthropic.APIError
        ? "The coach is unavailable right now. Try again in a minute."
        : err instanceof Error
          ? err.message
          : "Something went wrong building the plan.";
    await setStatus(row.id, { status: "failed", error: message });
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
  try {
    after(() => run(row, identity));
  } catch {
    void run(row, identity);
  }
  return toView(row);
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
  if (row.status === "pending" && Date.now() / 1000 - row.updatedAt > STALE_PENDING_SECONDS) {
    const error = "Building the plan was interrupted. Try again.";
    await setStatus(row.id, { status: "failed", error });
    return { ...toView(row), status: "failed", error };
  }
  return toView(row);
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
  log.info("plan draft saved", { draftId: id, planId: summary.id });
  return summary;
}

export async function discardDraft(userId: string, id: string): Promise<boolean> {
  const row = await ownedDraft(userId, id);
  if (!row || row.status === "saved") return false;
  await setStatus(id, { status: "discarded" });
  return true;
}
