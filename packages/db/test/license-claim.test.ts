import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { licenses, users, type Db } from "../src";
import { makeTestDb } from "./setup";

function hashKey(k: string): string {
  return createHash("sha256").update(k.toUpperCase()).digest("hex");
}

describe("license atomic claim", () => {
  let db: Db;
  let userAId: string;
  let userBId: string;
  let licenseId: string;
  const KEY = "LIC-TEST-0001-AAAA";

  beforeEach(async () => {
    ({ db } = await makeTestDb());

    const [a] = await db
      .insert(users)
      .values({ stravaAthleteId: 1 })
      .returning({ id: users.id });
    const [b] = await db
      .insert(users)
      .values({ stravaAthleteId: 2 })
      .returning({ id: users.id });
    userAId = a.id;
    userBId = b.id;

    const [lic] = await db
      .insert(licenses)
      .values({
        keyHash: hashKey(KEY),
        keyPrefix: KEY.slice(0, 8),
        createdByAdminAthleteId: 999,
      })
      .returning({ id: licenses.id });
    licenseId = lic.id;
  });

  async function claim(userId: string, key: string) {
    return db
      .update(licenses)
      .set({ boundUserId: userId })
      .where(
        and(
          eq(licenses.keyHash, hashKey(key)),
          isNull(licenses.boundUserId),
          isNull(licenses.revokedAt),
        ),
      )
      .returning({ id: licenses.id });
  }

  it("first claim wins; second claim sees no rows", async () => {
    const first = await claim(userAId, KEY);
    expect(first).toHaveLength(1);

    const second = await claim(userBId, KEY);
    expect(second).toHaveLength(0);

    const [row] = await db.select().from(licenses).where(eq(licenses.id, licenseId));
    expect(row.boundUserId).toBe(userAId);
  });

  it("wrong key (different hash) cannot claim", async () => {
    const result = await claim(userAId, "LIC-WRNG-WRNG-WRNG");
    expect(result).toHaveLength(0);
  });

  it("revoked license cannot be claimed", async () => {
    await db
      .update(licenses)
      .set({ revokedAt: Math.floor(Date.now() / 1000) })
      .where(eq(licenses.id, licenseId));

    const result = await claim(userAId, KEY);
    expect(result).toHaveLength(0);
  });

  it("unique constraint prevents duplicate hashes", async () => {
    await expect(
      db
        .insert(licenses)
        .values({
          keyHash: hashKey(KEY),
          keyPrefix: KEY.slice(0, 8),
          createdByAdminAthleteId: 999,
        }),
    ).rejects.toThrow();
  });
});
