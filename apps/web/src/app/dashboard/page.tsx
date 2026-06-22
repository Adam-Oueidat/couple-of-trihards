import { redirect } from "next/navigation";
import { isAdminAthlete, resolveSession } from "@/lib/auth";
import { getSession } from "@/lib/session";
import { getRecentActivities } from "@/lib/strava";
import {
  groupByWeek,
  calcTrainingLoad,
  getWeekStart,
  TRAINING_HISTORY_WEEKS,
  type WeeklyVolume,
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

  // "This week" is the current calendar week (resets every Monday), NOT the most
  // recent week that happens to contain an activity. Until the athlete trains
  // this week it shows zeros rather than rolling back to last week's totals.
  const currentWeekStart = getWeekStart(new Date());
  const currentWeek: WeeklyVolume = weeklyVolume.find(
    (w) => w.weekStart === currentWeekStart,
  ) ?? {
    weekStart: currentWeekStart,
    run: 0,
    ride: 0,
    swim: 0,
    runTime: 0,
    rideTime: 0,
    swimTime: 0,
  };

  return (
    <DashboardClient
      currentWeek={currentWeek}
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
