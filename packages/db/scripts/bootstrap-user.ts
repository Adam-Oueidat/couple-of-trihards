import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { createLogger } from "@trihards/core";
import { makeDb } from "../src/client";
import { licenses, users } from "../src/schema";

const log = createLogger("db:bootstrap");

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateKey(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const segs: string[] = [];
  for (let i = 0; i < 3; i++) {
    let seg = "";
    for (let j = 0; j < 4; j++) {
      seg += ALPHABET[bytes[i * 4 + j] % ALPHABET.length];
    }
    segs.push(seg);
  }
  return `LIC-${segs.join("-")}`;
}

function hashKey(k: string): string {
  return createHash("sha256").update(k.toUpperCase()).digest("hex");
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is not set");
  const athleteArg = process.argv[2] ?? process.env.SEED_STRAVA_ATHLETE_ID;
  const athleteId = Number(athleteArg);
  if (!Number.isInteger(athleteId) || athleteId <= 0) {
    console.error(
      "Usage: pnpm db:bootstrap <strava_athlete_id>\n" +
        "  or: SEED_STRAVA_ATHLETE_ID=<id> pnpm db:bootstrap",
    );
    process.exit(1);
  }

  const { db, client } = makeDb(url, process.env.TURSO_AUTH_TOKEN);

  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.stravaAthleteId, athleteId));
  let userId: string;
  if (existing) {
    userId = existing.id;
    log.info("user already exists", { userId, athleteId });
  } else {
    const [created] = await db
      .insert(users)
      .values({ stravaAthleteId: athleteId })
      .returning({ id: users.id });
    userId = created.id;
    log.info("created user", { userId, athleteId });
  }

  const [active] = await db
    .select({ id: licenses.id, keyPrefix: licenses.keyPrefix })
    .from(licenses)
    .where(eq(licenses.boundUserId, userId));

  let plaintextKey: string | null = null;
  if (active) {
    log.info("user already has an active license", {
      userId,
      keyPrefix: active.keyPrefix,
    });
  } else {
    plaintextKey = generateKey();
    const [lic] = await db
      .insert(licenses)
      .values({
        keyHash: hashKey(plaintextKey),
        keyPrefix: plaintextKey.slice(0, 8),
        boundUserId: userId,
        createdByAdminAthleteId: athleteId,
      })
      .returning({ id: licenses.id });
    await db
      .update(users)
      .set({ licenseId: lic.id })
      .where(eq(users.id, userId));
    log.info("minted and bound license", { userId, licenseId: lic.id });
  }

  client.close();

  console.log("");
  console.log("Bootstrap complete.");
  console.log("");
  console.log(`  user_id           : ${userId}`);
  console.log(`  strava_athlete_id : ${athleteId}`);
  if (plaintextKey) {
    console.log(`  license_key       : ${plaintextKey}`);
    console.log("  (Already bound to you. Copy it now — it will not be shown again.)");
  }
  console.log("");
  console.log("Next:");
  console.log(
    `  - Put your id in apps/web/.env.local: ADMIN_ATHLETE_IDS=${athleteId}`,
  );
  console.log("  - Restart pnpm dev, sign in via Strava → /dashboard");
  console.log("");
}

main().catch((err) => {
  log.error("bootstrap failed", err);
  process.exit(1);
});
