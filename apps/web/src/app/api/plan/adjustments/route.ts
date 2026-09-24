import { NextRequest, NextResponse } from "next/server";
import { analyzeLimiter, defaultLimiter } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import { getOpenAdjustment, startAdjustment } from "@/lib/plan-adjustments";

export const runtime = "nodejs";

/** GET /api/plan/adjustments — the adjustment waiting on the athlete (or just applied), or null. */
export async function GET() {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;
  return NextResponse.json(await getOpenAdjustment(auth.userId));
}

/** POST /api/plan/adjustments { request } — ask the coach to change the plan. 202, written in the background. */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(analyzeLimiter(), auth.userId);
  if (limited) return limited;
  const body = await request.json().catch(() => ({}));
  try {
    return NextResponse.json(await startAdjustment(auth, body?.request), { status: 202 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid request" }, { status: 400 });
  }
}
