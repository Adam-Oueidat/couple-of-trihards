import { and, asc, eq, gte } from "drizzle-orm";
import { getDb, pbSyncState, personalBests } from "@trihards/db";
import { DetailedActivity, StravaActivity, createLogger } from "@trihards/core";
import { epochOfDate, resolveToday, yearStartOf } from "./coach-dates";

const log = createLogger("personal-bests");

export interface PersonalBest {
  name: string;
  distance: number;
  moving_time: number;
  activityId: number;
  activityName: string;
  activityDate: string;
}

// Strava only computes `best_efforts` for runs; fetching detail for a swim or a
// ride would spend a rate-limit call to learn nothing.
const RUN_SPORT_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);

// How many activity-detail calls one backfill batch may spend. Strava allows
// 100 reads per 15 minutes, so a batch stays well clear of the ceiling and the
// caller loops until `done` — the cursor in pb_sync_state makes that resumable.
export const PB_SYNC_BATCH = 25;

type PbRow = typeof personalBests.$inferInsert;

interface BestEffort {
  name: string;
  distance: number;
  moving_time: number;
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

function toRow(
  userId: string,
  activity: DetailedActivity,
  effort: BestEffort,
): PbRow {
  return {
    userId,
    effortName: effort.name,
    distance: effort.distance,
    movingTime: effort.moving_time,
    activityId: String(activity.id),
    activityName: activity.name,
    activityDate: activity.start_date_local.split("T")[0],
  };
}

// Whether `candidate` should replace `prior` as the personal best. Beating the
// prior time wins as usual, but a prior set *before* the current year loses
// unconditionally: these bests are year-to-date, so last season's untouchable
// time must not sit in the table shadowing this year's actual best.
function beats(candidate: PbRow, prior: PbRow | undefined, yearStart: string): boolean {
  if (!prior) return true;
  if (prior.activityDate < yearStart) return true;
  return candidate.movingTime < prior.movingTime;
}

// Folds one activity's best efforts into an in-memory map of the current bests.
// Shared by the single-activity path and the batch backfill so both apply the
// same year-to-date comparison; returns the rows that actually changed.
function foldEfforts(
  userId: string,
  activity: DetailedActivity,
  current: Map<string, PbRow>,
  yearStart: string,
): PbRow[] {
  const changed: PbRow[] = [];
  for (const effort of activity.best_efforts ?? []) {
    const row = toRow(userId, activity, effort);
    if (row.activityDate < yearStart) continue;
    if (!beats(row, current.get(row.effortName), yearStart)) continue;
    current.set(row.effortName, row);
    changed.push(row);
  }
  return changed;
}

async function writeRows(rows: PbRow[]): Promise<void> {
  if (!rows.length) return;
  const db = getDb();
  // Each row is a distinct effort name, so the upserts are independent — fire
  // them together instead of awaiting one at a time.
  await Promise.all(
    rows.map((row) =>
      db
        .insert(personalBests)
        .values(row)
        .onConflictDoUpdate({
          target: [personalBests.userId, personalBests.effortName],
          set: {
            distance: row.distance,
            movingTime: row.movingTime,
            activityId: row.activityId,
            activityName: row.activityName,
            activityDate: row.activityDate,
            updatedAt: Math.floor(Date.now() / 1000),
          },
        }),
    ),
  );
}

async function loadCurrent(userId: string): Promise<Map<string, PbRow>> {
  const db = getDb();
  const rows = await db
    .select()
    .from(personalBests)
    .where(eq(personalBests.userId, userId));
  return new Map(rows.map((r) => [r.effortName, r as PbRow]));
}

function utcToday(): string {
  return new Date().toISOString().split("T")[0];
}

export async function updatePersonalBests(
  userId: string,
  activity: DetailedActivity,
  today = utcToday(),
): Promise<void> {
  if (!activity.best_efforts?.length) return;
  const yearStart = yearStartOf(today);
  const current = await loadCurrent(userId);
  await writeRows(foldEfforts(userId, activity, current, yearStart));
}

// Year-to-date bests only: a row set in a previous season is filtered out here
// as well as being overwritable above, so the section can never show a time
// that isn't from this year.
export async function getPersonalBests(
  userId: string,
  today = utcToday(),
): Promise<PersonalBest[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(personalBests)
    .where(
      and(
        eq(personalBests.userId, userId),
        gte(personalBests.activityDate, yearStartOf(today)),
      ),
    )
    .orderBy(asc(personalBests.distance));
  return rows.map(rowToPB);
}

export interface PbSyncResult {
  processed: number;
  updated: number;
  remaining: number;
  done: boolean;
  rateLimited: boolean;
}

function isRateLimit(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Strava API error 429");
}

async function readCursor(userId: string): Promise<number | null> {
  const db = getDb();
  const [row] = await db
    .select({ syncedThrough: pbSyncState.syncedThrough })
    .from(pbSyncState)
    .where(eq(pbSyncState.userId, userId));
  return row?.syncedThrough ?? null;
}

async function writeCursor(userId: string, syncedThrough: number): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db
    .insert(pbSyncState)
    .values({ userId, syncedThrough, updatedAt: now })
    .onConflictDoUpdate({
      target: pbSyncState.userId,
      set: { syncedThrough, updatedAt: now },
    });
}

function epochOf(activity: StravaActivity): number {
  return Math.floor(Date.parse(activity.start_date) / 1000);
}

// Runs still needing a detail fetch: this year's runs the cursor hasn't passed
// yet, oldest first so the cursor can advance monotonically.
export function pendingRuns(
  activities: StravaActivity[],
  cursor: number,
): StravaActivity[] {
  return activities
    .filter((a) => RUN_SPORT_TYPES.has(a.sport_type) && epochOf(a) > cursor)
    .sort((a, b) => epochOf(a) - epochOf(b));
}

// Walks one bounded batch of this year's runs, folding each one's best efforts
// into the table. Strava exposes `best_efforts` only on the per-activity detail
// endpoint, so this costs one API call per run — hence the batching, the
// resumable cursor, and the early exit when Strava starts returning 429.
//
// `fetchDetail` is injected rather than imported so this stays testable without
// a Strava session.
export async function syncYtdPersonalBests(
  userId: string,
  activities: StravaActivity[],
  fetchDetail: (id: number) => Promise<DetailedActivity>,
  batchSize = PB_SYNC_BATCH,
): Promise<PbSyncResult> {
  const yearStart = yearStartOf(resolveToday(undefined, activities));
  const yearStartEpoch = epochOfDate(yearStart);

  // A cursor left over from a previous season must not skip this year's runs.
  const stored = await readCursor(userId);
  const cursor = Math.max(stored ?? 0, yearStartEpoch);

  const pending = pendingRuns(activities, cursor);
  const batch = pending.slice(0, batchSize);
  if (!batch.length) {
    return { processed: 0, updated: 0, remaining: 0, done: true, rateLimited: false };
  }

  const current = await loadCurrent(userId);
  const changed = new Map<string, PbRow>();
  let processed = 0;
  let advancedTo = cursor;
  let rateLimited = false;

  for (const activity of batch) {
    let detail: DetailedActivity;
    try {
      detail = await fetchDetail(activity.id);
    } catch (err) {
      if (isRateLimit(err)) {
        rateLimited = true;
        break;
      }
      // One unreadable activity must not wedge the backfill: skip past it so
      // the cursor still advances and later runs get their chance.
      log.warn("skipping activity during PB sync", {
        activityId: activity.id,
        error: String(err),
      });
      processed++;
      advancedTo = epochOf(activity);
      continue;
    }
    for (const row of foldEfforts(userId, detail, current, yearStart)) {
      changed.set(row.effortName, row);
    }
    processed++;
    advancedTo = epochOf(activity);
  }

  await writeRows([...changed.values()]);
  if (advancedTo > cursor) await writeCursor(userId, advancedTo);

  const remaining = pending.length - processed;
  log.info("pb sync batch", {
    userId,
    processed,
    updated: changed.size,
    remaining,
    rateLimited,
  });
  return {
    processed,
    updated: changed.size,
    remaining,
    done: !rateLimited && remaining <= 0,
    rateLimited,
  };
}
