import { eq } from "drizzle-orm";
import { createLogger } from "@trihards/core";
import { getDb, stravaTokens } from "@trihards/db";
import { refreshStravaTokens, tokensNeedRefresh } from "./strava-auth";
import { getSession } from "./session";

const log = createLogger("strava-tokens");

export interface AccessTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/**
 * Strava credentials, keyed by our own user id.
 *
 * These used to live only in the iron-session cookie, which meant every Strava
 * call implicitly required a browser session: a mobile client authenticating
 * with a bearer token had no cookie, so `getValidAccessToken` threw, and a
 * client with a *stale* cookie authenticated as one user while fetching another
 * user's Strava data. Keying the tokens by `userId` makes the caller's proven
 * identity — bearer or cookie — the only thing that selects credentials.
 */
export async function loadStravaTokens(
  userId: string,
): Promise<AccessTokenSet | null> {
  const db = getDb();
  const [row] = await db
    .select({
      accessToken: stravaTokens.accessToken,
      refreshToken: stravaTokens.refreshToken,
      expiresAt: stravaTokens.expiresAt,
    })
    .from(stravaTokens)
    .where(eq(stravaTokens.userId, userId));
  return row ?? null;
}

export async function saveStravaTokens(
  userId: string,
  tokens: AccessTokenSet,
): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db
    .insert(stravaTokens)
    .values({
      userId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: stravaTokens.userId,
      set: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        updatedAt: now,
      },
    });
}

/**
 * Seeds the token row for a session that predates this table.
 *
 * Everyone already logged in when this shipped has credentials in their cookie
 * and no database row. Rather than force them to re-authenticate, the first
 * Strava call on their behalf copies the cookie's tokens into the row. After
 * that the cookie is never consulted for credentials again — it stays only as
 * the web login gate and profile source.
 *
 * Returns null for a bearer-only caller with no cookie, which is exactly the
 * case that used to throw "Not authenticated".
 */
async function bootstrapFromCookie(userId: string): Promise<AccessTokenSet | null> {
  const session = await getSession();
  if (!session.tokens) return null;

  const tokens: AccessTokenSet = {
    accessToken: session.tokens.access_token,
    refreshToken: session.tokens.refresh_token,
    expiresAt: session.tokens.expires_at,
  };
  await saveStravaTokens(userId, tokens);
  log.info("migrated cookie tokens into strava_tokens", { userId });
  return tokens;
}

/**
 * A usable Strava access token for one user, refreshing and persisting when it
 * is close to expiry.
 *
 * Refresh happens here rather than in the proxy because the database, unlike a
 * cookie, can be written from a Server Component. That also makes this the only
 * writer of a user's refresh token, so a rotated token can't be persisted to
 * one store and lost from the other.
 */
export async function getValidAccessToken(userId: string): Promise<string> {
  const current = (await loadStravaTokens(userId)) ?? (await bootstrapFromCookie(userId));
  if (!current) throw new Error("Not authenticated");

  if (!tokensNeedRefresh(current.expiresAt)) return current.accessToken;

  log.info("refreshing Strava token", { userId, expiresAt: current.expiresAt });
  const refreshed = await refreshStravaTokens(current.refreshToken);
  const next: AccessTokenSet = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token,
    expiresAt: refreshed.expires_at,
  };
  await saveStravaTokens(userId, next);
  return next.accessToken;
}
