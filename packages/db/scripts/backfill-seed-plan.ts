import { desc, eq } from "drizzle-orm";
import { createLogger, SEED_PLAN, parseRawTrainingPlan } from "@trihards/core";
import { makeDb } from "../src/client";
import { trainingPlans, users } from "../src/schema";

const log = createLogger("db:backfill-seed-plan");

// One-time backfill: the bundled Runna plan (packages/core/src/data/runna-plan.json)
// used to be served to every athlete from the core package. It belongs to one
// athlete, so this script assigns it to them as a normal training_plans row and
// nothing else in the app ever reads it again.
//
// Deliberately explicit and single-target: it takes the athlete it is for and
// refuses to guess. There is no code path that hands this plan to an athlete
// who did not run this script for themselves.
//
//   pnpm db:backfill-seed-plan <strava_athlete_id | user_id>
//
// Idempotent: an athlete who already has a plan is left alone.

const DEFAULT_ATHLETE_ID = 145353543;

async function resolveUserId(
  db: ReturnType<typeof makeDb>["db"],
  target: string,
): Promise<string | null> {
  const athleteId = Number(target);
  if (Number.isInteger(athleteId) && athleteId > 0) {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.stravaAthleteId, athleteId));
    return row?.id ?? null;
  }
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, target));
  return row?.id ?? null;
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is not set");

  const target = process.argv[2] ?? String(DEFAULT_ATHLETE_ID);
  const { db, client } = makeDb(url, process.env.TURSO_AUTH_TOKEN);

  try {
    const userId = await resolveUserId(db, target);
    if (!userId) {
      console.error(
        `No user matches "${target}".\n` +
          "Usage: pnpm db:backfill-seed-plan <strava_athlete_id | user_id>",
      );
      process.exit(1);
    }

    const [existing] = await db
      .select({ id: trainingPlans.id, name: trainingPlans.name })
      .from(trainingPlans)
      .where(eq(trainingPlans.userId, userId))
      .orderBy(desc(trainingPlans.createdAt), desc(trainingPlans.id))
      .limit(1);

    if (existing) {
      log.info("user already has a training plan; nothing to backfill", {
        userId,
        planId: existing.id,
        name: existing.name,
      });
      console.log(`\n${userId} already has a plan ("${existing.name}"). No change.\n`);
      return;
    }

    // Validate before writing, exactly as an upload would, so the seeded row is
    // indistinguishable from one the athlete uploaded themselves.
    const raw = parseRawTrainingPlan({
      name: SEED_PLAN.name,
      source: SEED_PLAN.source,
      discipline: SEED_PLAN.discipline,
      startDate: SEED_PLAN.startDate,
      raceDate: SEED_PLAN.raceDate,
      raceName: SEED_PLAN.raceName,
      sessions: SEED_PLAN.sessions.map((s) => ({
        date: s.date,
        name: s.name,
        type: s.type,
        km: s.km,
      })),
    });

    const [row] = await db
      .insert(trainingPlans)
      .values({
        id: crypto.randomUUID(),
        userId,
        name: raw.name,
        source: raw.source,
        discipline: raw.discipline as "swim" | "ride" | "run",
        startDate: raw.startDate,
        raceDate: raw.raceDate,
        raceName: raw.raceName,
        sessions: raw.sessions,
      })
      .returning({ id: trainingPlans.id });

    log.info("seed plan backfilled", {
      userId,
      planId: row.id,
      sessions: raw.sessions.length,
    });

    console.log("");
    console.log("Seed plan backfilled.");
    console.log("");
    console.log(`  user_id  : ${userId}`);
    console.log(`  plan_id  : ${row.id}`);
    console.log(`  plan     : ${raw.name} (${raw.sessions.length} sessions)`);
    console.log("");
    console.log("Every other athlete stays on no plan until they upload one.");
    console.log("");
  } finally {
    client.close();
  }
}

main().catch((err) => {
  log.error("backfill failed", err);
  process.exit(1);
});
