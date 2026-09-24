import { NextRequest, NextResponse } from "next/server";
import { defaultLimiter } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import { discardDraft, saveDraft } from "@/lib/plan-drafts";
import { getActiveTrainingPlan, listTrainingPlans } from "@/lib/training-plans";

/**
 * POST /api/plan/drafts/:id with { action: "save" | "discard" }.
 * Saving makes the draft the athlete's plan and returns it the way the upload
 * route does, so the Plan page swaps it in without a reload.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (body?.action === "discard") {
    return (await discardDraft(auth.userId, id))
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (body?.action !== "save") {
    return NextResponse.json({ error: "action must be save or discard" }, { status: 400 });
  }
  try {
    await saveDraft(auth.userId, id);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not save" }, { status: 409 });
  }
  const [active, plans] = await Promise.all([getActiveTrainingPlan(auth.userId), listTrainingPlans(auth.userId)]);
  return NextResponse.json({ plan: active?.plan ?? null, summary: active?.summary ?? null, plans });
}
