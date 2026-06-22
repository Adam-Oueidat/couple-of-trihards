"use server";

import { revalidatePath } from "next/cache";
import { createLogger } from "@trihards/core";
import { resolveSession } from "@/lib/auth";
import { invalidateAthleteCache } from "@/lib/strava";

const log = createLogger("dashboard:actions");

// Forces the dashboard to refetch live Strava data. Server Actions are public
// POST endpoints, so we authorize here and derive the athlete id from the
// session rather than trusting anything from the client. Busting our durable
// (DB-backed) Strava cache before revalidatePath is required — revalidatePath
// only clears Next's own caches, not the strava_cache rows.
export async function refreshDashboard(): Promise<void> {
  const resolved = await resolveSession();
  if (!resolved) throw new Error("unauthorized");

  await invalidateAthleteCache(resolved.stravaAthleteId);
  log.info("dashboard refresh", { athleteId: resolved.stravaAthleteId });
  revalidatePath("/dashboard");
}
