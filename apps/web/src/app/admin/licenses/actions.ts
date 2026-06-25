"use server";

import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { createLogger } from "@trihards/core";
import { getDb, licenses, type Db } from "@trihards/db";
import { isAdminAthlete, resolveSession } from "@/lib/auth";
import {
  generateLicenseKey,
  hashLicenseKey,
  licenseKeyPrefix,
  licenseRetentionSeconds,
} from "@/lib/license-key";

const log = createLogger("admin:licenses");

// Gate for every server action in this file. Named requireAuth so it reads as
// the action's authentication boundary: each exported action below is a public
// POST endpoint and must verify the caller is an admin before any data access.
async function requireAuth(): Promise<number> {
  const resolved = await resolveSession();
  if (!resolved || !isAdminAthlete(resolved.stravaAthleteId)) {
    throw new Error("forbidden");
  }
  return resolved.stravaAthleteId;
}

// Removes unredeemed, expired rows. Bound rows have expires_at = NULL and
// are never touched. Returns how many rows were pruned.
export async function pruneExpiredLicenses(db: Db = getDb()): Promise<number> {
  await requireAuth();
  const now = Math.floor(Date.now() / 1000);
  const deleted = await db
    .delete(licenses)
    .where(
      and(
        isNull(licenses.boundUserId),
        isNotNull(licenses.expiresAt),
        lt(licenses.expiresAt, now),
      ),
    )
    .returning({ id: licenses.id });
  if (deleted.length) {
    log.info("pruned expired licenses", { count: deleted.length });
  }
  return deleted.length;
}

export async function generateLicenses(count: number): Promise<string[]> {
  const adminId = await requireAuth();
  const n = Math.max(1, Math.min(50, Math.floor(count)));
  const db = getDb();

  // Sweep stale rows first so the table doesn't grow unboundedly when an
  // admin keeps minting batches that nobody redeems.
  await pruneExpiredLicenses(db);

  const expiresAt =
    Math.floor(Date.now() / 1000) + licenseRetentionSeconds();
  const plaintexts = Array.from({ length: n }, () => generateLicenseKey());

  await db.insert(licenses).values(
    plaintexts.map((p) => ({
      keyHash: hashLicenseKey(p),
      keyPrefix: licenseKeyPrefix(p),
      expiresAt,
      createdByAdminAthleteId: adminId,
    })),
  );
  log.info("generated licenses", { adminId, count: n, expiresAt });
  revalidatePath("/admin/licenses");
  // Plaintexts returned exactly once and never persisted.
  return plaintexts;
}

export async function revokeLicense(id: string) {
  const adminId = await requireAuth();
  const db = getDb();
  // Hard delete. The WARN log line below is the audit trail.
  // Any user bound to this license loses access on their next request:
  // requireAuth will find no row in licenses for them and redirect to /activate.
  const [removed] = await db
    .delete(licenses)
    .where(eq(licenses.id, id))
    .returning({ id: licenses.id, keyPrefix: licenses.keyPrefix, boundUserId: licenses.boundUserId });
  if (!removed) {
    log.warn("revoke: license not found", { adminId, licenseId: id });
    return;
  }
  log.warn("revoked license", {
    adminId,
    licenseId: removed.id,
    keyPrefix: removed.keyPrefix,
    wasBoundTo: removed.boundUserId ?? null,
  });
  revalidatePath("/admin/licenses");
}
