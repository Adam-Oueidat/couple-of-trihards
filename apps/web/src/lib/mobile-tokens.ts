import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { createLogger } from "@trihards/core";
import { getDb, mobileTokens, users, type User } from "@trihards/db";

const log = createLogger("mobile-tokens");

export function generateMobileToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, hash };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function mintMobileToken(userId: string): Promise<string> {
  const { token, hash } = generateMobileToken();
  const db = getDb();
  await db.insert(mobileTokens).values({ userId, tokenHash: hash });
  log.info("minted mobile token", { userId, hashPrefix: hash.slice(0, 8) });
  return token;
}

export async function resolveBearerToken(token: string): Promise<User | null> {
  const hash = hashToken(token);
  const db = getDb();
  const [row] = await db
    .select({ user: users })
    .from(mobileTokens)
    .innerJoin(users, eq(users.id, mobileTokens.userId))
    .where(and(eq(mobileTokens.tokenHash, hash), isNull(mobileTokens.revokedAt)));
  if (!row) {
    log.warn("bearer token not recognized", { hashPrefix: hash.slice(0, 8) });
    return null;
  }
  // Touch last_used_at (fire-and-forget — failure shouldn't block auth).
  void db
    .update(mobileTokens)
    .set({ lastUsedAt: Math.floor(Date.now() / 1000) })
    .where(eq(mobileTokens.tokenHash, hash))
    .catch((err) => log.warn("failed to touch last_used_at", { error: String(err) }));
  return row.user;
}
