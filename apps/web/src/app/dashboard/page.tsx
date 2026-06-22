import { redirect } from "next/navigation";
import { isAdminAthlete, resolveSession } from "@/lib/auth";
import { getSession } from "@/lib/session";
import { getRecentActivities } from "@/lib/strava";
import {
  groupByWeek,
  calcTrainingLoad,
  TRAINING_HISTORY_WEEKS,
} from "@trihards/core";
import { DashboardClient } from "@/components/DashboardClient";

// What the activity lists, calendar, and plan tabs render. The full year of
// history backs the training-load calculation only — we slice down to this
// window for display so the UI stays lean.
const DISPLAY_WEEKS = 12;

export default async function DashboardPage() {
  const session = await getSession();
  if (!session.tokens) redirect("/");

  const resolved = await resolveSession();
  if (!resolved) redirect("/");
  if (!resolved.license) redirect("/activate");

  // One fetch of the full year (cached). The training-load curve uses all of it
  // so CTL/ATL are warmed up and Form decays through today; the UI gets only the
  // recent slice to avoid rendering a year of activities.
  const history = await getRecentActivities(TRAINING_HISTORY_WEEKS);
  const trainingLoad = calcTrainingLoad(history);

  const displayCutoff = Date.now() - DISPLAY_WEEKS * 7 * 24 * 3600 * 1000;
  const activities = history.filter(
    (a) => new Date(a.start_date_local).getTime() >= displayCutoff,
  );
  const weeklyVolume = groupByWeek(activities);

  return (
    <DashboardClient
      athlete={{
        firstname: session.tokens.athlete_firstname,
        lastname: session.tokens.athlete_lastname,
        profile: session.tokens.athlete_profile,
      }}
      activities={activities}
      weeklyVolume={weeklyVolume}
      trainingLoad={trainingLoad}
      isAdmin={isAdminAthlete(resolved.stravaAthleteId)}
    />
  );
}
