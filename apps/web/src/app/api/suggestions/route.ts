import { NextRequest, NextResponse } from "next/server";
import {
  TRAINING_HISTORY_WEEKS,
  bucketHistogram,
  calcTrainingLoad,
  createLogger,
  defaultLimiter,
  observedMaxHr,
  resolveZoneModel,
  suggestWorkouts,
  sumHistograms,
  shiftDays,
  BLOCK_DAYS,
} from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import { getActivitiesWithDailySync, getAthleteDetail, getAthleteZones } from "@/lib/strava";
import { getActiveTrainingPlan } from "@/lib/training-plans";
import { getOverrides } from "@/lib/plan-overrides";
import { getWorkouts } from "@/lib/workouts";
import { getQualityProfiles } from "@/lib/quality-scan";
import { resolveToday } from "@/lib/coach-dates";

const log = createLogger("api:suggestions");

/**
 * What to train next, ranked.
 *
 * Everything the ranking needs is already cached or stored, so this costs no
 * Strava budget on a normal request. `date` lets the athlete look at tomorrow
 * rather than today, which changes both the plan lookup and whether a hard
 * session is still being absorbed.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  try {
    const [{ activities }, plan, overrides, workouts, profiles, zones, athlete] =
      await Promise.all([
        getActivitiesWithDailySync(auth, TRAINING_HISTORY_WEEKS),
        getActiveTrainingPlan(auth.userId),
        getOverrides(auth.userId),
        getWorkouts(auth.userId),
        getQualityProfiles(auth.userId),
        getAthleteZones(auth).catch(() => null),
        getAthleteDetail(auth).catch(() => null),
      ]);

    const today = resolveToday(undefined, activities);
    const requested = request.nextUrl.searchParams.get("date");
    // Only ever plan today or later: suggesting a session for a day that has
    // already gone is noise, and the athlete cannot act on it.
    const date = requested && requested >= today ? requested : today;

    const zoneModel = resolveZoneModel(zones, observedMaxHr(activities));

    // Measured time in zone over the recent block, when a scan has produced it.
    // Only trustworthy traces vote — a session whose strap dropped for half the
    // run would understate a zone and could talk the ranking out of a real gap.
    const mixFrom = shiftDays(today, -(BLOCK_DAYS - 1));
    const usable = profiles.filter(
      (p) => p.hrSeconds && p.date >= mixFrom && (p.hrCoverage ?? 0) >= 0.8,
    );
    const zoneSeconds =
      usable.length > 0
        ? bucketHistogram(sumHistograms(usable.map((p) => p.hrSeconds!)), zoneModel).seconds
        : null;

    const suggestions = suggestWorkouts({
      activities,
      trainingLoad: calcTrainingLoad(activities, today),
      plan: plan?.plan ?? null,
      overrides,
      customWorkouts: workouts,
      profiles,
      zones: zoneModel,
      zoneSeconds,
      athlete: { ftp: athlete?.ftp ?? null, weight: athlete?.weight ?? null },
      today,
      date,
    });

    return NextResponse.json({ date, today, suggestions });
  } catch (err) {
    log.error("suggestions failed", err);
    return NextResponse.json({ error: "Failed to build suggestions" }, { status: 500 });
  }
}
