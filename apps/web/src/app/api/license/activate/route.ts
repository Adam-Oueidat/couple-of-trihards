import { and, eq, gt, isNull, or } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { anonLimiter, createLogger } from "@trihards/core";
import { getDb, licenses, users } from "@trihards/db";
import { isAuthFailure, requireUserId } from "@/lib/auth";
import { clientIp, withLimit } from "@/lib/api";
import { KEY_RE, hashLicenseKey } from "@/lib/license-key";

const log = createLogger("license");

export async function POST(request: NextRequest) {
  const limited = await withLimit(anonLimiter(), clientIp(request));
  if (limited) return limited;

  const auth = await requireUserId();
  if (isAuthFailure(auth)) return auth;

  const body = await request.json().catch(() => null);
  const key = typeof body?.key === "string" ? body.key.trim().toUpperCase() : "";
  if (!KEY_RE.test(key)) {
    return NextResponse.json({ error: "invalid key format" }, { status: 400 });
  }

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  // Clear expires_at on claim — bound keys are permanent.
  const [claimed] = await db
    .update(licenses)
    .set({ boundUserId: auth.userId, expiresAt: null })
    .where(
      and(
        eq(licenses.keyHash, hashLicenseKey(key)),
        isNull(licenses.boundUserId),
        isNull(licenses.revokedAt),
        or(isNull(licenses.expiresAt), gt(licenses.expiresAt, now)),
      ),
    )
    .returning({ id: licenses.id });

  if (!claimed) {
    log.warn("license claim failed", { userId: auth.userId });
    return NextResponse.json(
      { error: "invalid, expired, or already-used key" },
      { status: 400 },
    );
  }

  await db
    .update(users)
    .set({ licenseId: claimed.id })
    .where(eq(users.id, auth.userId));

  log.info("license activated", { userId: auth.userId, licenseId: claimed.id });
  return NextResponse.json({ ok: true });
}
