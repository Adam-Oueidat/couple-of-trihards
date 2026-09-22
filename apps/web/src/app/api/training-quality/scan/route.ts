import { NextResponse } from "next/server";
import { TRAINING_HISTORY_WEEKS, createLogger, defaultLimiter } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import {
  getActivityDetail,
  getActivityStreamsStrict,
  getAthleteZones,
  getRecentActivities,
} from "@/lib/strava";
import { scanTrainingQuality } from "@/lib/quality-scan";

const log = createLogger("api:training-quality");

/**
 * Derives one bounded batch of activity quality profiles.
 *
 * Heart-rate streams and lap files exist only on per-activity endpoints, so a
 * season costs far more than the 100-reads-per-15-minutes budget allows in one
 * request. The client POSTs repeatedly until `done`; the stored rows themselves
 * record progress, so a batch stopped by a rate limit resumes exactly where it
 * left off with nothing re-read.
 *
 * Streams are fetched through the STRICT variant on purpose: the forgiving one
 * returns null for every failure including 429, and this route writes what it
 * is told down permanently — a rate limit recorded as "no streams" would never
 * be retried.
 */
export async function POST() {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  try {
    // Listing reuses the dashboard's cached row, so it costs no Strava budget;
    // only the per-activity fetches inside the scan do.
    const [activities, zones] = await Promise.all([
      getRecentActivities(auth, TRAINING_HISTORY_WEEKS),
      getAthleteZones(auth).catch(() => null),
    ]);

    const result = await scanTrainingQuality(auth.userId, activities, {
      fetchStreams: (id) => getActivityStreamsStrict(auth, id),
      fetchDetail: (id) => getActivityDetail(auth, id),
      zones,
    });

    return NextResponse.json(result);
  } catch (err) {
    log.error("quality scan failed", err);
    return NextResponse.json({ error: "Failed to scan sessions" }, { status: 500 });
  }
}
