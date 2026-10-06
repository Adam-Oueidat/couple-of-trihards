import { NextRequest, NextResponse } from "next/server";
import { analyzeLimiter, defaultLimiter, parseRevisionRequest } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import { discardDraft, insistDraft, reviseDraft, revertDraft, saveDraft } from "@/lib/plan-drafts";
import { getActiveTrainingPlan, listTrainingPlans } from "@/lib/training-plans";

/**
 * POST /api/plan/drafts/:id with { action: "save" | "discard" | "revise" | "insist" | "back" }.
 * Saving makes the draft the athlete's plan and returns it the way the upload
 * route does, so the Plan page swaps it in without a reload. Revise
 * ({ feedback, insist? }) asks the coach to change the draft and returns the
 * new pending version (202); insist redoes a revision the coach pushed back
 * on, as the athlete asked it; back drops a revision and returns the version
 * before it.
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
  if (body?.action === "revise" || body?.action === "insist") {
    // One of the expensive calls: shares the analysis budget.
    const expensive = await withLimit(analyzeLimiter(), auth.userId);
    if (expensive) return expensive;
    try {
      if (body.action === "insist") return NextResponse.json(await insistDraft(auth, id), { status: 202 });
      const { feedback } = parseRevisionRequest(body);
      return NextResponse.json(await reviseDraft(auth, id, feedback, false), { status: 202 });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Could not revise" }, { status: 409 });
    }
  }
  if (body?.action === "back") {
    try {
      return NextResponse.json(await revertDraft(auth.userId, id));
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Could not go back" }, { status: 409 });
    }
  }
  if (body?.action !== "save") {
    return NextResponse.json({ error: "action must be save, discard, revise, insist or back" }, { status: 400 });
  }
  try {
    await saveDraft(auth.userId, id);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not save" }, { status: 409 });
  }
  const [active, plans] = await Promise.all([getActiveTrainingPlan(auth.userId), listTrainingPlans(auth.userId)]);
  return NextResponse.json({ plan: active?.plan ?? null, summary: active?.summary ?? null, plans });
}
