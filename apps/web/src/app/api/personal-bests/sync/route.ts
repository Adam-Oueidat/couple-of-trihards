import { NextResponse } from "next/server";
import { TRAINING_HISTORY_WEEKS, createLogger, defaultLimiter } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import { getActivityDetail, getRecentActivities } from "@/lib/strava";
import { syncYtdPersonalBests } from "@/lib/personal-bests";

const log = createLogger("api:personal-bests");

// Backfills year-to-date personal bests one bounded batch at a time. Strava
// returns `best_efforts` only on the per-activity detail endpoint, so a full
// year costs one call per run — more than the 100-reads/15-min budget allows in
// a single request. The client therefore POSTs repeatedly until `done`, and the
// cursor in pb_sync_state makes each call pick up where the last one stopped.
export async function POST() {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  try {
    // Reuses the dashboard's cached activity list, so listing costs no extra
    // Strava calls — only the per-run detail fetches inside the sync do.
    const activities = await getRecentActivities(auth, TRAINING_HISTORY_WEEKS);
    const result = await syncYtdPersonalBests(
      auth.userId,
      activities,
      (id) => getActivityDetail(auth, id),
    );
    return NextResponse.json(result);
  } catch (err) {
    log.error("pb sync failed", err);
    return NextResponse.json({ error: "Failed to sync personal bests" }, { status: 500 });
  }
}
