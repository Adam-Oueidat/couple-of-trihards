import { NextRequest, NextResponse } from "next/server";
import { analyzeLimiter, defaultLimiter, parsePlanRequest, TRAINING_HISTORY_WEEKS } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import { getOpenDraft, startDraft } from "@/lib/plan-drafts";
import { getRecentActivities } from "@/lib/strava";
import { resolveToday } from "@/lib/coach-dates";

export const runtime = "nodejs";

/** GET /api/plan/drafts — the athlete's open draft (pending, ready or failed), or null. */
export async function GET() {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;
  return NextResponse.json(await getOpenDraft(auth.userId));
}

/**
 * POST /api/plan/drafts — ask the coach for a plan. Returns 202 with the
 * pending draft at once; the plan is written in the background.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  // One of the expensive calls: shares the analysis budget.
  const limited = await withLimit(analyzeLimiter(), auth.userId);
  if (limited) return limited;

  const activities = await getRecentActivities(auth, TRAINING_HISTORY_WEEKS);
  let planRequest;
  try {
    planRequest = parsePlanRequest(await request.json(), resolveToday(undefined, activities));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request" },
      { status: 400 },
    );
  }
  return NextResponse.json(await startDraft(auth, planRequest), { status: 202 });
}
