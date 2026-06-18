import { NextResponse } from "next/server";
import { defaultLimiter } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import {
  getAthleteDetail,
  getAthleteStats,
  getAthleteZones,
} from "@/lib/strava";
import { getPersonalBests } from "@/lib/personal-bests";

export async function GET() {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  const [athlete, zones, stats, personalBests] = await Promise.all([
    getAthleteDetail().catch(() => null),
    getAthleteZones().catch(() => null),
    getAthleteStats().catch(() => null),
    getPersonalBests(auth.userId),
  ]);

  return NextResponse.json({ athlete, zones, stats, personalBests });
}
