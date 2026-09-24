"use server";

import { revalidatePath } from "next/cache";
import { createLogger, TRAINING_HISTORY_WEEKS } from "@trihards/core";
import { resolveSession } from "@/lib/auth";
import { refreshActivitiesCache } from "@/lib/strava";

const log = createLogger("dashboard:actions");

/**
 * Forces the dashboard to refetch live Strava data.
 *
 * Server Actions are public POST endpoints, so we authorize here and derive the
 * athlete id from the session rather than trusting anything from the client.
 *
 * This used to drop the athlete's cached rows and let the next render refetch.
 * That handed Strava the power to empty our only copy of the athlete's history:
 * on 2026-09-11 a Sync pressed during a Strava 503 deleted the cache, the
 * re-render threw, and every reload after it repeated the same failing fetch —
 * the dashboard stayed broken for the length of Strava's outage. refreshActivitiesCache
 * fetches before it replaces, so a failed sync now leaves the athlete exactly
 * where they were: looking at their previous data.
 */
export async function refreshDashboard(): Promise<void> {
  const resolved = await resolveSession();
  if (!resolved) throw new Error("unauthorized");

  try {
    await refreshActivitiesCache(resolved, TRAINING_HISTORY_WEEKS);
    log.info("dashboard refresh", { athleteId: resolved.stravaAthleteId });
  } catch (err) {
    // The cache is intact — the page will re-render the data it already had.
    // Rethrown so the client's catch keeps the current view rather than
    // flashing an empty one.
    log.warn("dashboard refresh failed, cache left intact", {
      athleteId: resolved.stravaAthleteId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // Every dashboard address (/dashboard, /dashboard/plan, …) is one page file.
  revalidatePath("/dashboard/[[...tab]]", "page");
}
