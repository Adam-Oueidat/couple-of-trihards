import { NextRequest, NextResponse } from "next/server";
import { createLogger, defaultLimiter } from "@trihards/core";
import { getActivityDetail, getActivityStreams } from "@/lib/strava";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import { getAnalysis } from "@/lib/analyses";
import { updatePersonalBests } from "@/lib/personal-bests";

const log = createLogger("api:activities");

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  const { id } = await params;
  const activityId = Number(id);
  if (!Number.isInteger(activityId) || activityId <= 0) {
    return NextResponse.json({ error: "Invalid activity id" }, { status: 400 });
  }

  try {
    const [activity, streams, analysis] = await Promise.all([
      getActivityDetail(activityId),
      getActivityStreams(activityId),
      getAnalysis(auth.userId, activityId),
    ]);
    await updatePersonalBests(auth.userId, activity);
    return NextResponse.json({ activity, streams, analysis });
  } catch (err) {
    log.error("failed to fetch activity detail", err);
    return NextResponse.json(
      { error: "Failed to fetch activity detail" },
      { status: 500 },
    );
  }
}
