import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb, planAdjustments, planDrafts, type PlanAdjustmentRow, type PlanDraftRow } from "@trihards/db";
import { MAX_DRAFT_REVISIONS, type PlanRequest, type StravaActivity } from "@trihards/core";
import { getRecentAnalyses } from "./analyses";
import { formatNotes, getNotes } from "./brain-notes";
import { clip, getCoachingMemory } from "./coach-memory";
import { daysBetween, localDateOf } from "./coach-dates";

// The coach's brain: the one memory every AI surface reads.
//
// The chat, the activity analysis, the plan writer and "adjust with coach" are
// the same coach to the athlete, but each used to know only what it had been
// handed. A sore knee given as the reason for a plan change never reached the
// chat; a rest day agreed in chat never reached the plan writer. recall() is
// the single place that memory is put together, and buildTrainingContext calls
// it for every prompt, so a surface cannot be built without it.
//
// It holds four things, longest-lived first:
//   - standing notes: what the athlete has said that stays true (brain-notes.ts)
//   - earlier chats: recaps of the last two weeks (coach-memory.ts)
//   - plan work: the plan the coach wrote and the changes it proposed
//   - the coach's latest activity analyses
//
// To give a new AI surface the memory, build its prompt with
// buildTrainingContext. To let it add to the memory, pass what the athlete
// typed to learnFromAthlete.

// How far back plan changes are remembered, and how many at most.
const ADJUSTMENT_DAYS = 28;
const MAX_ADJUSTMENTS = 5;
const QUOTE_CHARS = 400;
const RECENT_ANALYSES = 3;

export interface RecallOpts {
  // The chat being answered right now: its turns are replayed verbatim as
  // messages, so it is left out of the memory.
  excludeConversationId?: string;
}

function ago(date: string, today: string): string {
  const days = daysBetween(date, today);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

const quote = (text: string) => `"${clip(text.replace(/\s+/g, " ").trim(), QUOTE_CHARS)}"`;

export interface AdjustmentMemory {
  date: string;
  request: string;
  message: string;
  outcome: "applied" | "undone" | "waiting" | "not applied";
}

const OUTCOME_TEXT: Record<AdjustmentMemory["outcome"], string> = {
  applied: "they approved it, and the plan sessions below already include it",
  undone: "they approved it and then undid it, so the plan is as it was before",
  waiting: "waiting for them to approve it; it is not in the plan yet",
  "not applied": "they did not apply it, so the plan is unchanged",
};

function toAdjustmentMemory(row: PlanAdjustmentRow, activities: StravaActivity[]): AdjustmentMemory | null {
  const result = row.result as { message?: string; undone?: boolean } | null;
  if (!result) return null;
  return {
    date: localDateOf(row.createdAt, activities),
    request: row.request,
    message: result.message ?? "",
    outcome:
      row.status === "applied"
        ? result.undone
          ? "undone"
          : "applied"
        : row.status === "ready"
          ? "waiting"
          : "not applied",
  };
}

export interface WrittenPlanMemory {
  name: string;
  savedOn: string;
  request: PlanRequest;
  // What the athlete asked to change while the plan was still a draft, oldest first.
  feedback: string[];
  why: string;
}

// The body of the "Plan work" section, or null when the coach has done none.
export function formatPlanWork(
  written: WrittenPlanMemory | null,
  adjustments: AdjustmentMemory[],
  today: string,
): string | null {
  const lines: string[] = [];
  if (written) {
    const { request } = written;
    const parts = [
      `- You wrote the plan "${written.name}" for them, saved ${written.savedOn} (${ago(written.savedOn, today)}). It is their current plan only if the "Training plan" section below carries the same name.`,
      `  They asked for: ${quote(request.prompt)}`,
    ];
    const limits = [
      request.maxHoursPerWeek ? `at most ${request.maxHoursPerWeek} hours a week` : null,
      request.unavailableDays?.length ? `nothing on ${request.unavailableDays.join(", ")}` : null,
    ].filter(Boolean);
    if (limits.length) parts.push(`  Limits they set: ${limits.join("; ")}.`);
    if (written.feedback.length)
      parts.push(`  Changes they asked for while it was a draft: ${written.feedback.map(quote).join("; ")}`);
    if (written.why) parts.push(`  Your reasoning then: ${quote(written.why)}`);
    lines.push(parts.join("\n"));
  }
  for (const a of [...adjustments].sort((x, y) => x.date.localeCompare(y.date))) {
    lines.push(
      `- ${a.date} (${ago(a.date, today)}) they asked you to adjust the plan: ${quote(a.request)}\n` +
        (a.message ? `  You answered: ${quote(a.message)}\n` : "") +
        `  Outcome: ${OUTCOME_TEXT[a.outcome]}.`,
    );
  }
  return lines.length ? lines.join("\n") : null;
}

async function getWrittenPlan(userId: string, activities: StravaActivity[]): Promise<WrittenPlanMemory | null> {
  const db = getDb();
  const [saved] = await db
    .select()
    .from(planDrafts)
    .where(and(eq(planDrafts.userId, userId), eq(planDrafts.status, "saved")))
    .orderBy(desc(planDrafts.updatedAt))
    .limit(1);
  if (!saved) return null;
  const result = saved.result as { plan?: { name?: string }; why?: string } | null;
  if (!result?.plan?.name) return null;

  // A revision is a row pointing at the version it changed; walk back to the
  // first draft to collect everything the athlete asked for along the way.
  const feedback: string[] = [];
  let row: PlanDraftRow | undefined = saved;
  for (let i = 0; row && i <= MAX_DRAFT_REVISIONS; i++) {
    if (row.feedback) feedback.unshift(row.feedback);
    if (!row.parentId) break;
    [row] = await db
      .select()
      .from(planDrafts)
      .where(and(eq(planDrafts.userId, userId), eq(planDrafts.id, row.parentId)));
  }
  return {
    name: result.plan.name,
    savedOn: localDateOf(saved.updatedAt, activities),
    request: saved.input as unknown as PlanRequest,
    feedback,
    why: result.why ?? "",
  };
}

async function getAdjustments(userId: string, activities: StravaActivity[]): Promise<AdjustmentMemory[]> {
  const since = Math.floor(Date.now() / 1000) - ADJUSTMENT_DAYS * 86400;
  const rows = await getDb()
    .select()
    .from(planAdjustments)
    .where(
      and(
        eq(planAdjustments.userId, userId),
        inArray(planAdjustments.status, ["ready", "applied", "discarded"]),
        gte(planAdjustments.createdAt, since),
      ),
    )
    .orderBy(desc(planAdjustments.createdAt))
    .limit(MAX_ADJUSTMENTS);
  return rows.flatMap((r) => toAdjustmentMemory(r, activities) ?? []);
}

async function recallAnalyses(userId: string, activities: StravaActivity[]): Promise<string | null> {
  const recent = await getRecentAnalyses(userId, RECENT_ANALYSES);
  if (recent.length === 0) return null;
  return recent
    .map((a) => {
      const act = activities.find((x) => x.id === a.activityId);
      const label = act
        ? `"${act.name}" (${act.start_date_local.split("T")[0]})`
        : `activity ${a.activityId}`;
      return `### Analysis of ${label}\n${a.text}`;
    })
    .join("\n\n");
}

// Everything the coach remembers about this athlete, as one prompt section.
// Always returns a section: an empty memory says so, rather than leaving the
// model to wonder whether the memory was simply not included.
export async function recall(
  userId: string,
  activities: StravaActivity[],
  today: string,
  opts: RecallOpts = {},
): Promise<string> {
  const [notes, chats, written, adjustments, analyses] = await Promise.all([
    getNotes(userId),
    getCoachingMemory(userId, activities, today, opts),
    getWrittenPlan(userId, activities),
    getAdjustments(userId, activities),
    recallAnalyses(userId, activities),
  ]);

  const sections = [
    [
      "Standing notes (what the athlete has told you that holds until they say otherwise)",
      formatNotes(notes, today),
    ],
    [
      'Earlier coaching context (your own earlier chats with this athlete — history, not "now"; what was settled in them still stands)',
      chats,
    ],
    ["Plan work (the plan you wrote and the changes you proposed outside the chat)", formatPlanWork(written, adjustments, today)],
    ["Your recent activity analyses (your own prior coaching feedback — stay consistent with it)", analyses],
  ].flatMap(([title, body]) => (body ? [`## ${title}\n${body}`] : []));

  return `# Coach memory (the same memory whether you are chatting, analysing an activity or working on the plan)
${sections.join("\n\n") || "Empty: you have not spoken with this athlete, analysed an activity or worked on a plan for them yet."}`;
}
