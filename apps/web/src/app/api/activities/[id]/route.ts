import { NextRequest, NextResponse } from "next/server";
import { createLogger, defaultLimiter } from "@trihards/core";
import { getActivityDetail, getActivityStreams } from "@/lib/strava";
import { ownsActivity } from "@/lib/activity-access";
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

  // Activity ids are global and guessable, so proving who the caller is does
  // not establish that this activity is theirs. 404 rather than 403 — a 403
  // would confirm the activity exists.
  if (!(await ownsActivity(auth, activityId))) {
    log.warn("rejected activity not owned by caller", { userId: auth.userId, activityId });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const [activity, streams, analysis] = await Promise.all([
      getActivityDetail(auth, activityId),
      getActivityStreams(auth, activityId),
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
