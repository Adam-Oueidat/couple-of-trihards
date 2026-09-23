import { NextRequest, NextResponse } from "next/server";
import { createLogger, defaultLimiter, findScheduleConflicts } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import { loadSuggestInput, validateSuggestedSession } from "@/lib/suggestions";

const log = createLogger("api:suggestions:conflicts");

/**
 * What adding this session would clash with, and the proposed fixes.
 *
 * Read-only: POST only because the session travels in the body. Nothing is
 * written until the athlete confirms through /api/suggestions/accept.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  let body: { date?: unknown; session?: unknown };
  let session;
  try {
    body = await request.json();
    session = validateSuggestedSession(body.session);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request" },
      { status: 400 },
    );
  }

  try {
    const input = await loadSuggestInput(auth, typeof body.date === "string" ? body.date : null);
    return NextResponse.json({
      date: input.date,
      conflicts: findScheduleConflicts(input, session),
    });
  } catch (err) {
    log.error("conflict check failed", err);
    return NextResponse.json({ error: "Could not check your calendar" }, { status: 500 });
  }
}
