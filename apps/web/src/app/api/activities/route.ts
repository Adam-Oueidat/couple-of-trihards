import { NextRequest, NextResponse } from "next/server";
import { createLogger, defaultLimiter } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import { getRecentActivities } from "@/lib/strava";

const log = createLogger("api:activities");

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  const weeks = parseInt(new URL(request.url).searchParams.get("weeks") ?? "12", 10);

  try {
    const activities = await getRecentActivities(auth, weeks);
    return NextResponse.json(activities);
  } catch (err) {
    log.error("failed to fetch activities", err);
    return NextResponse.json({ error: "Failed to fetch activities" }, { status: 500 });
  }
}
