import { StravaActivity, TRAINING_HISTORY_WEEKS } from "@trihards/core";
import { getRecentActivities, type StravaIdentity } from "./strava";

/**
 * Authorization for per-activity endpoints.
 *
 * requireAuth() proves *who* the caller is; it says nothing about *what* they
 * may read. Strava activity ids are global and guessable, so a route that
 * accepts an id straight from the request must also confirm the activity
 * belongs to the caller before fetching it.
 *
 * The athlete's own activity list is the authority. It is already cached per
 * athlete in the database (see getRecentActivities), so the check costs no
 * extra Strava call on the normal path.
 */
export function ownsActivityIn(
  activities: StravaActivity[],
  activityId: number,
): boolean {
  return activities.some((a) => a.id === activityId);
}

export async function ownsActivity(
  identity: StravaIdentity,
  activityId: number,
): Promise<boolean> {
  const activities = await getRecentActivities(identity, TRAINING_HISTORY_WEEKS);
  return ownsActivityIn(activities, activityId);
}
