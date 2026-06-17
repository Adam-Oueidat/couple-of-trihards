import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createLogger } from "@trihards/core";
import { makeDb } from "../src/client";

const log = createLogger("db:import");
import {
  analyses,
  customWorkouts,
  goals,
  personalBests,
  planOverrides,
  users,
} from "../src/schema";

interface JsonGoal {
  id: string;
  text: string;
  createdAt: string;
}

interface JsonWorkout {
  id: string;
  date: string;
  discipline: "swim" | "ride" | "run";
  name: string;
  distanceKm?: number;
  durationMin?: number;
  notes?: string;
  addedBy: "athlete" | "coach";
  createdAt: string;
}

interface JsonOverride {
  sessionId: string;
  originalDate: string;
  newDate: string;
  movedAt: string;
  reason?: string;
}

interface JsonPB {
  name: string;
  distance: number;
  moving_time: number;
  activityId: number;
  activityName: string;
  activityDate: string;
}

interface JsonAnalysis {
  text: string;
  createdAt: string;
}

function toUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    log.warn("failed to parse json", { path, error: String(err) });
    return fallback;
  }
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is not set");
  const athleteIdRaw = process.env.SEED_STRAVA_ATHLETE_ID;
  if (!athleteIdRaw) throw new Error("SEED_STRAVA_ATHLETE_ID is not set");
  const athleteId = Number(athleteIdRaw);
  if (!Number.isInteger(athleteId)) {
    throw new Error("SEED_STRAVA_ATHLETE_ID must be an integer");
  }

  const dataDir =
    process.env.SEED_DATA_DIR ?? join(process.cwd(), "..", "..", "apps", "web", ".data");
  console.log(`importing from ${dataDir} for strava athlete ${athleteId}`);

  const { db, client } = makeDb(url, process.env.TURSO_AUTH_TOKEN);

  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.stravaAthleteId, athleteId));

  const userId = existingUser
    ? existingUser.id
    : (await db
        .insert(users)
        .values({ stravaAthleteId: athleteId })
        .returning({ id: users.id }))[0].id;

  console.log(`user_id = ${userId}`);

  // Goals
  const goalsJson = readJson<JsonGoal[]>(join(dataDir, "goals.json"), []);
  if (goalsJson.length) {
    await db.delete(goals).where(eq(goals.userId, userId));
    await db.insert(goals).values(
      goalsJson.map((g) => ({
        id: g.id,
        userId,
        text: g.text,
        createdAt: toUnix(g.createdAt),
      })),
    );
    console.log(`imported ${goalsJson.length} goals`);
  }

  // Custom workouts
  const workoutsJson = readJson<JsonWorkout[]>(
    join(dataDir, "custom-workouts.json"),
    [],
  );
  if (workoutsJson.length) {
    await db.delete(customWorkouts).where(eq(customWorkouts.userId, userId));
    await db.insert(customWorkouts).values(
      workoutsJson.map((w) => ({
        id: w.id,
        userId,
        date: w.date,
        discipline: w.discipline,
        name: w.name,
        distanceKm: w.distanceKm,
        durationMin: w.durationMin,
        notes: w.notes,
        addedBy: w.addedBy,
        createdAt: toUnix(w.createdAt),
      })),
    );
    console.log(`imported ${workoutsJson.length} custom workouts`);
  }

  // Plan overrides
  const overridesJson = readJson<Record<string, JsonOverride>>(
    join(dataDir, "plan-overrides.json"),
    {},
  );
  const overrideRows = Object.values(overridesJson);
  if (overrideRows.length) {
    await db.delete(planOverrides).where(eq(planOverrides.userId, userId));
    await db.insert(planOverrides).values(
      overrideRows.map((o) => ({
        userId,
        sessionId: o.sessionId,
        originalDate: o.originalDate,
        newDate: o.newDate,
        movedAt: toUnix(o.movedAt),
        reason: o.reason,
      })),
    );
    console.log(`imported ${overrideRows.length} plan overrides`);
  }

  // Personal bests
  const pbsJson = readJson<Record<string, JsonPB>>(
    join(dataDir, "personal-bests.json"),
    {},
  );
  const pbRows = Object.values(pbsJson);
  if (pbRows.length) {
    await db.delete(personalBests).where(eq(personalBests.userId, userId));
    await db.insert(personalBests).values(
      pbRows.map((p) => ({
        userId,
        effortName: p.name,
        distance: p.distance,
        movingTime: p.moving_time,
        activityId: String(p.activityId),
        activityName: p.activityName,
        activityDate: p.activityDate,
      })),
    );
    console.log(`imported ${pbRows.length} personal bests`);
  }

  // Analyses
  const analysesJson = readJson<Record<string, JsonAnalysis>>(
    join(dataDir, "analyses.json"),
    {},
  );
  const analysisEntries = Object.entries(analysesJson);
  if (analysisEntries.length) {
    await db.delete(analyses).where(eq(analyses.userId, userId));
    await db.insert(analyses).values(
      analysisEntries.map(([activityId, a]) => ({
        userId,
        activityId,
        text: a.text,
        createdAt: toUnix(a.createdAt),
      })),
    );
    console.log(`imported ${analysisEntries.length} analyses`);
  }

  client.close();
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
