import { NextRequest, NextResponse } from "next/server";
import { createLogger, defaultLimiter } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import {
  StaleConflictError,
  acceptSuggestion,
  loadSuggestInput,
  validateResolutions,
  validateSuggestedSession,
} from "@/lib/suggestions";

const log = createLogger("api:suggestions:accept");

/**
 * Put a suggested session on the calendar, along with the changes around it
 * the athlete chose. `resolutions` maps each clashing session's id to the
 * option picked for it; every clash needs one.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  let body: { date?: unknown; session?: unknown; resolutions?: unknown };
  let session;
  let resolutions;
  try {
    body = await request.json();
    session = validateSuggestedSession(body.session);
    resolutions = validateResolutions(body.resolutions);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid request" },
      { status: 400 },
    );
  }

  try {
    const input = await loadSuggestInput(auth, typeof body.date === "string" ? body.date : null);
    const result = await acceptSuggestion(auth.userId, input, session, resolutions);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof StaleConflictError) {
      return NextResponse.json({ error: err.message, stale: true }, { status: 409 });
    }
    log.error("accept failed", err);
    return NextResponse.json({ error: "Could not update your calendar" }, { status: 500 });
  }
}
