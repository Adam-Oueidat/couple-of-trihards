import { NextRequest, NextResponse } from "next/server";
import { createLogger, defaultLimiter, suggestWorkouts } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import { loadSuggestInput } from "@/lib/suggestions";

const log = createLogger("api:suggestions");

/**
 * What to train next, ranked.
 *
 * Everything the ranking needs is already cached or stored, so this costs no
 * Strava budget on a normal request. `date` lets the athlete look at tomorrow
 * rather than today, which changes the plan lookup, whether a hard session is
 * still being absorbed, and the Form they will be carrying by then.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  try {
    const input = await loadSuggestInput(auth, request.nextUrl.searchParams.get("date"));
    return NextResponse.json({
      date: input.date,
      today: input.today,
      suggestions: suggestWorkouts(input),
    });
  } catch (err) {
    log.error("suggestions failed", err);
    return NextResponse.json({ error: "Failed to build suggestions" }, { status: 500 });
  }
}
