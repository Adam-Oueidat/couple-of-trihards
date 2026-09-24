import { NextRequest, NextResponse } from "next/server";
import { defaultLimiter } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import { buildStartingPoint } from "@/lib/plan-drafts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/plan/starting-point?start=YYYY-MM-DD — what a new plan would build from. */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  const start = new URL(request.url).searchParams.get("start") ?? "";
  if (!DATE_RE.test(start)) {
    return NextResponse.json({ error: "start must be YYYY-MM-DD" }, { status: 400 });
  }
  const { view } = await buildStartingPoint(auth, start);
  return NextResponse.json(view);
}
