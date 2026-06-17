import { and, eq } from "drizzle-orm";
import { getDb, planOverrides } from "@trihards/db";
import type { PlanOverride, PlanOverrideMap } from "@trihards/core";

export type { PlanOverride, PlanOverrideMap };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface OverrideInput {
  sessionId: string;
  originalDate: string;
  newDate: string;
  reason?: string;
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
  return {
    sessionId: o.sessionId,
    originalDate: o.originalDate,
    newDate: o.newDate,
    reason: typeof o.reason === "string" ? o.reason.slice(0, 300) : undefined,
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
    };
  }
  return map;
}

export async function setOverride(
  userId: string,
  input: OverrideInput,
): Promise<PlanOverride | null> {
  const db = getDb();

  if (input.newDate === input.originalDate) {
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
    })
    .onConflictDoUpdate({
      target: [planOverrides.userId, planOverrides.sessionId],
      set: {
        originalDate: input.originalDate,
        newDate: input.newDate,
        movedAt,
        reason: input.reason,
      },
    });

  return {
    sessionId: input.sessionId,
    originalDate: input.originalDate,
    newDate: input.newDate,
    movedAt: new Date(movedAt * 1000).toISOString(),
    reason: input.reason,
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
