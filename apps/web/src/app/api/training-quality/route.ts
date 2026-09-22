import { NextResponse } from "next/server";
import {
  TRAINING_HISTORY_WEEKS,
  buildQualityRecap,
  createLogger,
  defaultLimiter,
} from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import { getAthleteZones, getRecentActivities } from "@/lib/strava";
import { getQualityProfiles } from "@/lib/quality-scan";
import { resolveToday } from "@/lib/coach-dates";

const log = createLogger("api:training-quality");

/**
 * The quality recap, rebuilt from whatever has been scanned so far.
 *
 * The dashboard server-renders this once for the first paint; the client
 * revalidates the same shape here after each scan batch, so progress appears
 * without a page reload and there is only one code path building it.
 */
export async function GET() {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  try {
    const [activities, zones, profiles] = await Promise.all([
      getRecentActivities(auth, TRAINING_HISTORY_WEEKS),
      getAthleteZones(auth).catch(() => null),
      getQualityProfiles(auth.userId),
    ]);

    return NextResponse.json(
      buildQualityRecap({
        activities,
        profiles,
        zones,
        today: resolveToday(undefined, activities),
      }),
    );
  } catch (err) {
    log.error("quality recap failed", err);
    return NextResponse.json({ error: "Failed to load training quality" }, { status: 500 });
  }
}
