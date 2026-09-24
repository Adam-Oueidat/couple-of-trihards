import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@trihards/core";
import { getDb, licenses, users } from "@trihards/db";
import { getSession } from "@/lib/session";
import { saveStravaTokens } from "@/lib/strava-tokens";
import {
  devMockEnabled,
  MOCK_ACCESS_TOKEN,
  MOCK_ATHLETE,
  MOCK_ATHLETE_ID,
} from "@/lib/strava-mock";

const log = createLogger("dev:login");

/** Ten years: the mock token must never look due for a refresh. */
const MOCK_EXPIRES_AT = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;

/**
 * Signs in the dev-only test athlete, whose Strava is answered by
 * lib/strava-mock.ts. Gives them a licence so the dashboard opens straight
 * away. 404 outside `next dev`, so it cannot exist in production.
 */
export async function GET(request: NextRequest) {
  if (!devMockEnabled()) return new NextResponse(null, { status: 404 });

  const db = getDb();
  let [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.stravaAthleteId, MOCK_ATHLETE_ID));
  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        stravaAthleteId: MOCK_ATHLETE_ID,
        displayName: `${MOCK_ATHLETE.firstname} ${MOCK_ATHLETE.lastname}`,
      })
      .returning({ id: users.id });
  }

  await saveStravaTokens(user.id, {
    accessToken: MOCK_ACCESS_TOKEN,
    refreshToken: MOCK_ACCESS_TOKEN,
    expiresAt: MOCK_EXPIRES_AT,
  });

  const [license] = await db
    .select({ id: licenses.id })
    .from(licenses)
    .where(and(eq(licenses.boundUserId, user.id), isNull(licenses.revokedAt)));
  if (!license) {
    await db.insert(licenses).values({
      keyHash: createHash("sha256").update(`dev-mock:${user.id}`).digest("hex"),
      keyPrefix: "DEV-MOCK",
      boundUserId: user.id,
      createdByAdminAthleteId: MOCK_ATHLETE_ID,
    });
  }

  const session = await getSession();
  session.tokens = {
    access_token: MOCK_ACCESS_TOKEN,
    refresh_token: MOCK_ACCESS_TOKEN,
    expires_at: MOCK_EXPIRES_AT,
    athlete_id: MOCK_ATHLETE_ID,
    athlete_firstname: MOCK_ATHLETE.firstname,
    athlete_lastname: MOCK_ATHLETE.lastname,
    athlete_profile: "",
  };
  await session.save();

  log.info("signed in dev test athlete", { userId: user.id });
  return NextResponse.redirect(new URL("/dashboard", request.url));
}
