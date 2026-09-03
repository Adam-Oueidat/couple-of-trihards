import { and, eq } from "drizzle-orm";
import { getDb, planOverrides } from "@trihards/db";
import { SESSION_TYPES, type SessionType } from "@trihards/core";
import type { PlanOverride, PlanOverrideMap } from "@trihards/core";

export type { PlanOverride, PlanOverrideMap };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface OverrideInput {
  sessionId: string;
  originalDate: string;
  newDate: string;
  reason?: string;
  hidden?: boolean;
  skipped?: boolean;
  skipReason?: string;
  name?: string;
  type?: SessionType;
  km?: number;
}

const MAX_NAME_LENGTH = 200;
// Both free-text reasons go to the coach verbatim, so they are capped the same
// way: long enough for a sentence of context, short enough not to be a prompt.
const MAX_REASON_LENGTH = 300;

function isSessionType(value: unknown): value is SessionType {
  return (
    typeof value === "string" && (SESSION_TYPES as readonly string[]).includes(value)
  );
}

export function validateOverrideInput(input: unknown): OverrideInput {
  const o = input as Record<string, unknown>;
  if (!o || typeof o !== "object") throw new Error("Invalid input");
  if (typeof o.sessionId !== "string" || o.sessionId.length === 0)
    throw new Error("sessionId required");
  if (typeof o.originalDate !== "string" || !DATE_RE.test(o.originalDate))
    throw new Error("originalDate must be YYYY-MM-DD");
  if (typeof o.newDate !== "string" || !DATE_RE.test(o.newDate))
    throw new Error("newDate must be YYYY-MM-DD");
  if (o.hidden !== undefined && typeof o.hidden !== "boolean")
    throw new Error("hidden must be a boolean");
  if (o.skipped !== undefined && typeof o.skipped !== "boolean")
    throw new Error("skipped must be a boolean");

  // Base-field edits are all optional. Undefined means "leave the plan's value
  // alone"; a supplied value must be well-formed, since it is rendered to the
  // athlete and fed to the coach.
  if (o.name !== undefined && (typeof o.name !== "string" || o.name.trim().length === 0))
    throw new Error("name must be a non-empty string");
  if (o.type !== undefined && !isSessionType(o.type))
    throw new Error(`type must be one of: ${SESSION_TYPES.join(", ")}`);
  if (
    o.km !== undefined &&
    (typeof o.km !== "number" || !Number.isFinite(o.km) || o.km < 0)
  )
    throw new Error("km must be a non-negative number");

  return {
    sessionId: o.sessionId,
    originalDate: o.originalDate,
    newDate: o.newDate,
    reason:
      typeof o.reason === "string" ? o.reason.slice(0, MAX_REASON_LENGTH) : undefined,
    hidden: typeof o.hidden === "boolean" ? o.hidden : undefined,
    skipped: typeof o.skipped === "boolean" ? o.skipped : undefined,
    // A whitespace-only reason collapses to "none given" rather than being
    // stored, so the coach's prompt never renders a dangling "because".
    skipReason:
      typeof o.skipReason === "string" && o.skipReason.trim().length > 0
        ? o.skipReason.trim().slice(0, MAX_REASON_LENGTH)
        : undefined,
    name: typeof o.name === "string" ? o.name.trim().slice(0, MAX_NAME_LENGTH) : undefined,
    type: isSessionType(o.type) ? o.type : undefined,
    km: typeof o.km === "number" ? o.km : undefined,
  };
}

export async function getOverrides(userId: string): Promise<PlanOverrideMap> {
  const db = getDb();
  const rows = await db
    .select()
    .from(planOverrides)
    .where(eq(planOverrides.userId, userId));
  const map: PlanOverrideMap = {};
  for (const row of rows) {
    map[row.sessionId] = {
      sessionId: row.sessionId,
      originalDate: row.originalDate,
      newDate: row.newDate,
      movedAt: new Date(row.movedAt * 1000).toISOString(),
      reason: row.reason ?? undefined,
      hidden: row.hidden,
      skipped: row.skipped,
      skipReason: row.skipReason ?? undefined,
      name: row.name ?? undefined,
      type: (row.type as SessionType | null) ?? undefined,
      km: row.km ?? undefined,
    };
  }
  return map;
}

export async function setOverride(
  userId: string,
  input: OverrideInput,
): Promise<PlanOverride | null> {
  const db = getDb();
  const hidden = input.hidden ?? false;
  const skipped = input.skipped ?? false;

  // A row that records nothing is dropped entirely. "Nothing" means the date is
  // back where the plan put it, the session isn't hidden or skipped, AND no
  // base field is edited — without that last clause, renaming a session without
  // also moving it would delete the row that holds the rename. Un-skipping is
  // therefore the same call with `skipped: false`, which falls through here and
  // clears the row when nothing else is recorded on it.
  const editsBaseFields =
    input.name !== undefined || input.type !== undefined || input.km !== undefined;
  if (input.newDate === input.originalDate && !hidden && !skipped && !editsBaseFields) {
    await db
      .delete(planOverrides)
      .where(
        and(eq(planOverrides.userId, userId), eq(planOverrides.sessionId, input.sessionId)),
      );
    return null;
  }

  const movedAt = Math.floor(Date.now() / 1000);
  await db
    .insert(planOverrides)
    .values({
      userId,
      sessionId: input.sessionId,
      originalDate: input.originalDate,
      newDate: input.newDate,
      movedAt,
      reason: input.reason,
      hidden,
      skipped,
      // Dropped along with the skip, so an un-skip cannot leave a stale reason
      // behind for the next skip to inherit.
      skipReason: skipped ? (input.skipReason ?? null) : null,
      name: input.name ?? null,
      type: input.type ?? null,
      km: input.km ?? null,
    })
    .onConflictDoUpdate({
      target: [planOverrides.userId, planOverrides.sessionId],
      set: {
        originalDate: input.originalDate,
        newDate: input.newDate,
        movedAt,
        reason: input.reason,
        hidden,
        skipped,
        skipReason: skipped ? (input.skipReason ?? null) : null,
        name: input.name ?? null,
        type: input.type ?? null,
        km: input.km ?? null,
      },
    });

  return {
    sessionId: input.sessionId,
    originalDate: input.originalDate,
    newDate: input.newDate,
    movedAt: new Date(movedAt * 1000).toISOString(),
    reason: input.reason,
    hidden,
    skipped,
    skipReason: skipped ? input.skipReason : undefined,
    name: input.name,
    type: input.type,
    km: input.km,
  };
}

export async function clearOverride(userId: string, sessionId: string): Promise<boolean> {
  const db = getDb();
  const deleted = await db
    .delete(planOverrides)
    .where(and(eq(planOverrides.userId, userId), eq(planOverrides.sessionId, sessionId)))
    .returning({ sessionId: planOverrides.sessionId });
  return deleted.length > 0;
}
