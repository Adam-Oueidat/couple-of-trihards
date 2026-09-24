import { Suspense } from "react";
import { redirect } from "next/navigation";
import { isAdminAthlete, resolveSession, type ResolvedSession } from "@/lib/auth";
import { getSession } from "@/lib/session";
import { DashboardSkeleton } from "@/components/DashboardSkeleton";
import { getActivitiesWithDailySync, getAthleteZones } from "@/lib/strava";
import {
  groupByWeek,
  calcTrainingLoad,
  getWeekStart,
  buildBlockRecap,
  buildPlanRecap,
  buildQualityRecap,
  estimateRunThreshold,
  observedMaxHr,
  resolveZoneModel,
  TRAINING_HISTORY_WEEKS,
  type PlanRecap,
  type WeeklyVolume,
} from "@trihards/core";
import { DashboardClient } from "@/components/DashboardClient";
import { athleteOffsetMs, resolveToday } from "@/lib/coach-dates";
import { getActiveTrainingPlan, getLatestFinishedPlan } from "@/lib/training-plans";
import { getOverrides } from "@/lib/plan-overrides";
import { getQualityProfiles } from "@/lib/quality-scan";
import { getWorkouts } from "@/lib/workouts";
import { getRecentAnalyses } from "@/lib/analyses";

// What the activity lists, calendar, and plan tabs render. The full year of
// history backs the training-load calculation only — we slice down to this
// window for display so the UI stays lean.
const DISPLAY_WEEKS = 12;

/**
 * Auth only — deliberately nothing slow.
 *
 * The three redirects below decide whether this athlete may see the dashboard
 * at all, and they have to resolve before any HTML is committed or a logged-out
 * visitor would get a flash of skeleton before being bounced. Reading the
 * session cookie costs no I/O and resolveSession is one query, so this is a few
 * milliseconds; everything expensive lives in DashboardData, behind the
 * Suspense boundary, and streams in after the shell has already painted.
 */
export default async function DashboardPage() {
  const session = await getSession();
  if (!session.tokens) redirect("/");

  const resolved = await resolveSession();
  if (!resolved) redirect("/");
  if (!resolved.license) redirect("/activate");

  const athlete = {
    firstname: session.tokens.athlete_firstname,
    lastname: session.tokens.athlete_lastname,
    profile: session.tokens.athlete_profile,
  };

  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardData resolved={resolved} athlete={athlete} />
    </Suspense>
  );
}

interface DashboardDataProps {
  resolved: ResolvedSession;
  athlete: { firstname: string; lastname: string; profile: string };
}

async function DashboardData({ resolved, athlete }: DashboardDataProps) {
  // One fetch of the full year (cached). The training-load curve uses all of it
  // so CTL/ATL are warmed up and Form decays through today; the UI gets only the
  // recent slice to avoid rendering a year of activities. This also auto-syncs
  // once per athlete-local day: if the cached data is from an earlier day it
  // refetches live from Strava (mirroring the coach's new-day reset), otherwise
  // it serves the cache untouched to stay off Strava's rate limit.
  // The plan is per-athlete: their most recent upload, or null when they have
  // not uploaded one — there is no shared plan to fall back to. Fetched
  // alongside the activity history so the plan and calendar tabs render from
  // this athlete's plan and nobody else's.
  // The athlete's edits on that plan — moved/hidden sessions and their own
  // added workouts — come down with it. The calendar and plan tabs need them to
  // place anything at all, so fetching them here rather than from the client on
  // mount is what lets those tabs paint their final layout on the first frame
  // instead of showing the un-moved plan and snapping a moment later.
  // The feed puts the coach's saved read under each recent activity, so the
  // latest analyses come down with the rest rather than one request per card.
  const [
    { activities: history, fetchedAt, syncState },
    activePlan,
    planOverrides,
    customWorkouts,
    recentAnalyses,
  ] = await Promise.all([
    getActivitiesWithDailySync(resolved, TRAINING_HISTORY_WEEKS),
    getActiveTrainingPlan(resolved.userId),
    getOverrides(resolved.userId),
    getWorkouts(resolved.userId),
    getRecentAnalyses(resolved.userId, 30).catch(() => []),
  ]);

  // This is a server component, so a bare `new Date()` is the server's UTC clock
  // — which has already rolled to tomorrow during the athlete's evening in any
  // negative-offset timezone. Anchor "now"/"today" to the athlete's local date,
  // derived from their most recent activity's UTC offset (falling back to server
  // UTC only when there's no activity to read an offset from). Without this the
  // "This week" panel resets a day early and shows zeros right after a session.
  const today = resolveToday(undefined, history);
  const athleteNow = new Date(new Date().getTime() + (athleteOffsetMs(history) ?? 0));
  const trainingLoad = calcTrainingLoad(history, today);

  // The six-week recap and the plan retrospective are computed here rather than
  // in the client for two reasons. The block needs TWELVE weeks of activities —
  // six to summarise and six to compare against — which is more than the
  // display window the client receives, and the plan recap needs a plan the
  // client is never sent (the athlete's last FINISHED one, which is usually not
  // their active one). Both are pure passes over arrays already in memory here,
  // so the cost is arithmetic, not I/O.
  const blockRecap = buildBlockRecap(history, trainingLoad, today);

  // Heart-rate zones are frequently unavailable — they need the profile:read_all
  // scope and are gated behind a Strava subscription in practice — so this
  // degrades to a max-HR estimate rather than failing the render, exactly as
  // the fitness card and the coach already do.
  const [athleteZones, qualityProfiles] = await Promise.all([
    getAthleteZones(resolved).catch(() => null),
    getQualityProfiles(resolved.userId),
  ]);
  const qualityRecap = buildQualityRecap({
    activities: history,
    profiles: qualityProfiles,
    zones: athleteZones,
    today,
  });

  // The same estimate the coach quotes and the workout charts draw at 100%,
  // so the feed's thresholds card can never disagree with either.
  const runThreshold = estimateRunThreshold({
    plan: activePlan?.plan ?? null,
    activities: history,
    overrides: planOverrides,
    customWorkouts,
    today,
    zones: resolveZoneModel(athleteZones, observedMaxHr(history)),
    profiles: qualityProfiles,
  });
  const analyses: Record<number, string> = {};
  for (const a of recentAnalyses) analyses[a.activityId] ??= a.text;

  const finishedPlan = await getLatestFinishedPlan(resolved.userId, today);
  const planRecap: PlanRecap | null = finishedPlan
    ? buildPlanRecap(
        finishedPlan.plan,
        history,
        trainingLoad,
        planOverrides,
        today,
        customWorkouts,
      )
    : null;

  // Real last-sync time for the "Synced …" label: the timestamp on the cached
  // activities row, which only changes on an actual Strava fetch (login / Sync
  // button / daily auto-sync above), not on a plain refresh. Stored in Unix
  // seconds, converted to millis for the client clock.
  const syncedAt = fetchedAt * 1000;

  // Athlete-local "now" so the display window and current-week cutoff agree,
  // and so render stays free of repeated impure clock reads.
  const displayCutoff =
    athleteNow.getTime() - DISPLAY_WEEKS * 7 * 24 * 3600 * 1000;
  const activities = history.filter(
    (a) => new Date(a.start_date_local).getTime() >= displayCutoff,
  );
  const weeklyVolume = groupByWeek(activities);

  // The plan and calendar tabs grade sessions against same-day activities, so
  // they need activities covering the WHOLE plan — not the display window.
  // A plan longer than DISPLAY_WEEKS (a 15-week half-marathon block, say) had
  // its earliest weeks graded against activities that had been sliced away, so
  // sessions the athlete genuinely ran showed as "missed" forever. Widening to
  // the plan's own start date fixes the grade without shipping the entire
  // year: the extra rows are bounded by the plan's length.
  const planStart = activePlan?.plan?.startDate;
  const planCutoff = planStart
    ? Math.min(displayCutoff, new Date(planStart + "T00:00:00").getTime())
    : displayCutoff;
  const planActivities =
    planCutoff === displayCutoff
      ? activities
      : history.filter(
          (a) => new Date(a.start_date_local).getTime() >= planCutoff,
        );

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
      syncState={syncState}
      athlete={athlete}
      activities={activities}
      planActivities={planActivities}
      weeklyVolume={weeklyVolume}
      trainingLoad={trainingLoad}
      blockRecap={blockRecap}
      planRecap={planRecap}
      qualityRecap={qualityRecap}
      trainingPlan={activePlan?.plan ?? null}
      planSummary={activePlan?.summary ?? null}
      planOverrides={planOverrides}
      customWorkouts={customWorkouts}
      isAdmin={isAdminAthlete(resolved.stravaAthleteId)}
      today={today}
      runThreshold={runThreshold}
      analyses={analyses}
    />
  );
}
