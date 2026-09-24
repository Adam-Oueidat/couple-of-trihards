import { NextRequest, NextResponse } from "next/server";
import { defaultLimiter } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import {
  applyAdjustmentById,
  discardAdjustment,
  dismissAdjustment,
  undoAdjustment,
} from "@/lib/plan-adjustments";
import { getActiveTrainingPlan } from "@/lib/training-plans";

/**
 * POST /api/plan/adjustments/:id { action: "apply" | "discard" | "undo" | "dismiss" }.
 * apply and undo return the plan as the calendar should now render it.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  const { id } = await params;
  const { action } = await request.json().catch(() => ({}));
  try {
    if (action === "apply") await applyAdjustmentById(auth, id);
    else if (action === "undo") await undoAdjustment(auth.userId, id);
    else if (action === "discard") await discardAdjustment(auth.userId, id);
    else if (action === "dismiss") await dismissAdjustment(auth.userId, id);
    else return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Something went wrong" }, { status: 409 });
  }
  if (action === "apply" || action === "undo") {
    const active = await getActiveTrainingPlan(auth.userId);
    return NextResponse.json({ plan: active?.plan ?? null, summary: active?.summary ?? null });
  }
  return NextResponse.json({ ok: true });
}
