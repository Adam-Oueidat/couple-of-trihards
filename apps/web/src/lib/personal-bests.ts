import { asc, eq } from "drizzle-orm";
import { getDb, personalBests } from "@trihards/db";
import { DetailedActivity } from "@trihards/core";

export interface PersonalBest {
  name: string;
  distance: number;
  moving_time: number;
  activityId: number;
  activityName: string;
  activityDate: string;
}

function rowToPB(row: typeof personalBests.$inferSelect): PersonalBest {
  return {
    name: row.effortName,
    distance: row.distance,
    moving_time: row.movingTime,
    activityId: Number(row.activityId),
    activityName: row.activityName,
    activityDate: row.activityDate,
  };
}

export async function updatePersonalBests(
  userId: string,
  activity: DetailedActivity,
): Promise<void> {
  if (!activity.best_efforts?.length) return;
  const db = getDb();
  const existingRows = await db
    .select()
    .from(personalBests)
    .where(eq(personalBests.userId, userId));
  const existing = new Map(existingRows.map((r) => [r.effortName, r]));

  const date = activity.start_date_local.split("T")[0];
  // Each effort has a distinct name, so the upserts are independent — fire them
  // together instead of awaiting one at a time.
  const writes = activity.best_efforts
    .filter((e) => {
      const prior = existing.get(e.name);
      return !prior || e.moving_time < prior.movingTime;
    })
    .map((e) =>
      db
        .insert(personalBests)
        .values({
          userId,
          effortName: e.name,
          distance: e.distance,
          movingTime: e.moving_time,
          activityId: String(activity.id),
          activityName: activity.name,
          activityDate: date,
        })
        .onConflictDoUpdate({
          target: [personalBests.userId, personalBests.effortName],
          set: {
            distance: e.distance,
            movingTime: e.moving_time,
            activityId: String(activity.id),
            activityName: activity.name,
            activityDate: date,
            updatedAt: Math.floor(Date.now() / 1000),
          },
        }),
    );
  await Promise.all(writes);
}

export async function getPersonalBests(userId: string): Promise<PersonalBest[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(personalBests)
    .where(eq(personalBests.userId, userId))
    .orderBy(asc(personalBests.distance));
  return rows.map(rowToPB);
}
