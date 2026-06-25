import { and, eq, isNull } from "drizzle-orm";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { createLogger } from "@trihards/core";
import { getDb, licenses, users, type License } from "@trihards/db";
import { getSession } from "./session";
import { resolveBearerToken } from "./mobile-tokens";

const log = createLogger("auth");

export interface ResolvedSession {
  userId: string;
  stravaAthleteId: number;
  license: License | null;
}

async function resolveBearer(): Promise<{ userId: string; stravaAthleteId: number } | null> {
  const h = await headers();
  const authHeader = h.get("authorization");
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!m) return null;
  const user = await resolveBearerToken(m[1].trim());
  if (!user) return null;
  return { userId: user.id, stravaAthleteId: user.stravaAthleteId };
}

async function resolveCookie(): Promise<
  { userId: string; stravaAthleteId: number } | null
> {
  const session = await getSession();
  const athleteId = session.tokens?.athlete_id;
  if (!athleteId) return null;

  const db = getDb();
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.stravaAthleteId, athleteId));

  if (existing) return { userId: existing.id, stravaAthleteId: athleteId };

  const displayName =
    [session.tokens?.athlete_firstname, session.tokens?.athlete_lastname]
      .filter(Boolean)
      .join(" ") || null;
  const [created] = await db
    .insert(users)
    .values({ stravaAthleteId: athleteId, displayName })
    .returning({ id: users.id });
  log.info("created user on first request", {
    userId: created.id,
    athleteId,
    displayName,
  });
  return { userId: created.id, stravaAthleteId: athleteId };
}

export async function resolveSession(): Promise<ResolvedSession | null> {
  const base = (await resolveBearer()) ?? (await resolveCookie());
  if (!base) return null;

  const db = getDb();
  const [license] = await db
    .select()
    .from(licenses)
    .where(and(eq(licenses.boundUserId, base.userId), isNull(licenses.revokedAt)));

  return {
    userId: base.userId,
    stravaAthleteId: base.stravaAthleteId,
    license: license ?? null,
  };
}

function adminAthleteIds(): Set<number> {
  const raw = process.env.ADMIN_ATHLETE_IDS ?? "";
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return new Set(ids);
}

export function isAdminAthlete(athleteId: number): boolean {
  return adminAthleteIds().has(athleteId);
}

export type AuthResult =
  | { userId: string; stravaAthleteId: number; license: License }
  | NextResponse;

function failure(reason: "needs_login" | "needs_license", status: number) {
  log.debug("auth failure", { reason, status });
  return NextResponse.json({ error: reason, reason }, { status });
}

export async function requireAuth(): Promise<AuthResult> {
  const resolved = await resolveSession();
  if (!resolved) return failure("needs_login", 401);
  if (!resolved.license) return failure("needs_license", 401);
  return {
    userId: resolved.userId,
    stravaAthleteId: resolved.stravaAthleteId,
    license: resolved.license,
  };
}

export type LooseAuthResult = { userId: string; stravaAthleteId: number } | NextResponse;

export async function requireUserId(): Promise<LooseAuthResult> {
  const resolved = await resolveSession();
  if (!resolved) return failure("needs_login", 401);
  return { userId: resolved.userId, stravaAthleteId: resolved.stravaAthleteId };
}

export function isAuthFailure(
  result: { userId: string } | NextResponse,
): result is NextResponse {
  return result instanceof NextResponse;
}
