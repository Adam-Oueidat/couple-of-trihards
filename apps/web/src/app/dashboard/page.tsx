import { redirect } from "next/navigation";
import { isAdminAthlete, resolveSession } from "@/lib/auth";
import { getSession } from "@/lib/session";
import { getCacheFetchedAt, getRecentActivities } from "@/lib/strava";
import {
  groupByWeek,
  calcTrainingLoad,
  getWeekStart,
  TRAINING_HISTORY_WEEKS,
  type WeeklyVolume,
} from "@trihards/core";
import { DashboardClient } from "@/components/DashboardClient";
import { athleteOffsetMs, resolveToday } from "@/lib/coach-dates";

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

  // This is a server component, so a bare `new Date()` is the server's UTC clock
  // — which has already rolled to tomorrow during the athlete's evening in any
  // negative-offset timezone. Anchor "now"/"today" to the athlete's local date,
  // derived from their most recent activity's UTC offset (falling back to server
  // UTC only when there's no activity to read an offset from). Without this the
  // "This week" panel resets a day early and shows zeros right after a session.
  const today = resolveToday(undefined, history);
  const athleteNow = new Date(new Date().getTime() + (athleteOffsetMs(history) ?? 0));
  const trainingLoad = calcTrainingLoad(history, today);

  // Real last-sync time for the "Synced …" label: the timestamp on the cached
  // activities row, which only changes on an actual Strava fetch (login / Sync
  // button), not on a plain refresh. Stored in Unix seconds; null on first load
  // before any row exists. Converted to millis for the client clock.
  const fetchedAt = await getCacheFetchedAt(
    session.tokens.athlete_id,
    `activities:${TRAINING_HISTORY_WEEKS}`,
  );
  const syncedAt = fetchedAt != null ? fetchedAt * 1000 : null;

  // Athlete-local "now" so the display window and current-week cutoff agree,
  // and so render stays free of repeated impure clock reads.
  const displayCutoff =
    athleteNow.getTime() - DISPLAY_WEEKS * 7 * 24 * 3600 * 1000;
  const activities = history.filter(
    (a) => new Date(a.start_date_local).getTime() >= displayCutoff,
  );
  const weeklyVolume = groupByWeek(activities);

  // "This week" is the current calendar week (resets every Monday), NOT the most
  // recent week that happens to contain an activity. Until the athlete trains
  // this week it shows zeros rather than rolling back to last week's totals.
  // Keyed off the athlete-local date (noon-anchored to stay on the right day
  // whatever the server's timezone) so the week doesn't reset a day early.
  const currentWeekStart = getWeekStart(new Date(today + "T12:00:00"));
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
      syncedAt={syncedAt}
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
