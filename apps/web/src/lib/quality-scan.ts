import { and, eq, inArray } from "drizzle-orm";
import {
  getDb,
  activityQuality,
  scanState,
  type ActivityQualityRow,
  type NewActivityQualityRow,
} from "@trihards/db";
import {
  aerobicDecoupling,
  analyzeStructure,
  buildHrHistogram,
  createLogger,
  getDiscipline,
  resolveZoneModel,
  workoutKey,
  type AthleteZones,
  type DetailedActivity,
  type QualityProfile,
  type SessionStructure,
  type StravaActivity,
  type StreamSet,
  type ZoneModel,
} from "@trihards/core";

const log = createLogger("quality-scan");

/**
 * Bump to re-derive every stored row. The only invalidation lever there is —
 * deliberately coarse, because the alternative is per-field versioning nobody
 * would keep accurate.
 */
export const QUALITY_SCHEMA_VERSION = 1;

/**
 * Activities per batch. Stage one costs a stream fetch for every run and stage
 * two a detail fetch for the structured ones, so twelve activities is roughly
 * fifteen to twenty Strava reads — comfortably inside the 100-per-15-minutes
 * ceiling even if the athlete presses Sync in the same window.
 */
export const QUALITY_SCAN_BATCH = 12;

/** A transiently failed row waits this long before it is worth another read. */
const RETRY_AFTER_SECONDS = 24 * 3600;
/** And is never retried more than this many times in total. */
const MAX_ATTEMPTS = 3;

export interface QualityScanResult {
  processed: number;
  derived: number;
  failed: number;
  remaining: number;
  /** Strava reads actually spent, so the UI can explain a pause honestly. */
  reads: number;
  done: boolean;
  rateLimited: boolean;
}

function isRateLimit(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Strava API error 429");
}

function epochOf(activity: StravaActivity): number {
  return Math.floor(Date.parse(activity.start_date) / 1000);
}

/** Runs are the only discipline with lap structure and pace worth analysing. */
function isAnalysable(activity: StravaActivity): boolean {
  return getDiscipline(activity) !== "other" && !activity.manual;
}

type PendingRow = Pick<
  ActivityQualityRow,
  "activityId" | "streamStatus" | "attempts" | "schemaVersion" | "derivedAt"
>;

/**
 * What still needs deriving — an anti-join, not a cursor.
 *
 * A scalar high-water mark is right for the personal-bests scan and wrong here.
 * This scan costs up to two reads per activity and wants to run NEWEST FIRST,
 * because the athlete cares about last month's sessions rather than January's,
 * and a scalar cursor cannot express that without either skipping work
 * permanently or re-reading it. Comparing the stored rows against the cached
 * activity list makes resumption free: a batch interrupted by a rate limit
 * leaves its finished rows written and everything else still pending, with no
 * bookkeeping at all.
 *
 * Pure, so the retry policy is testable without a database.
 */
export function pendingQuality(
  activities: StravaActivity[],
  rows: PendingRow[],
  opts: { now: number; version?: number },
): StravaActivity[] {
  const version = opts.version ?? QUALITY_SCHEMA_VERSION;
  const byId = new Map(rows.map((r) => [r.activityId, r]));

  return activities
    .filter(isAnalysable)
    .filter((a) => {
      const row = byId.get(String(a.id));
      if (!row) return true;
      if (row.schemaVersion < version) return true;
      // A manual activity or one Strava 404s on will never grow streams.
      // Retrying it forever would spend a read a scan on a known dead end.
      if (row.streamStatus === "none") return false;
      if (row.streamStatus === "error") {
        return (
          row.attempts < MAX_ATTEMPTS && opts.now - row.derivedAt > RETRY_AFTER_SECONDS
        );
      }
      return false;
    })
    .sort((a, b) => epochOf(b) - epochOf(a));
}

/**
 * Whether an activity earns a second Strava read for its lap file.
 *
 * Names are the strongest signal available: this athlete's are descriptive
 * ("400m Repeats", "Tempo 4-3-2-1", "Drop Set"), and neither `average_cadence`
 * nor `workout_type` survives into the stored activity projection, so there is
 * nothing else to go on beyond an elevated average heart rate. Fetching laps
 * for every easy run would nearly double the scan's cost to learn that they
 * have no structure.
 */
// Plurals matter: "Descending Intervals" and "400m Repeats" are both real
// session names here and neither matches a singular-only pattern. So does the
// time-based rep form — "Rolling 300s" prescribes 300-second efforts, not 300
// metres, and would otherwise be read as an easy run and never have its laps
// fetched.
const STRUCTURED_NAME =
  /\b(repeats?|intervals?|tempo|threshold|fartlek|reps?|sets?|surges?|strides?|progression|\d+\s?[×x]\s?\d|\d{3,4}\s?m|\d{2,4}s)\b/i;

export function isQualityCandidate(
  activity: StravaActivity,
  model: ZoneModel,
): boolean {
  if (STRUCTURED_NAME.test(activity.name)) return true;
  if (model.source !== "none" && activity.average_heartrate) {
    // A session averaging Z3 or above is either a sustained hard effort or a
    // mixed one; both are worth the lap file.
    return activity.average_heartrate >= model.floors[2];
  }
  return false;
}

export interface QualityScanDeps {
  /** Must THROW on a rate limit — see getActivityStreamsStrict. */
  fetchStreams: (id: number) => Promise<StreamSet | null>;
  fetchDetail: (id: number) => Promise<DetailedActivity>;
  zones: AthleteZones | null;
}

/**
 * Derive one batch of activity quality profiles.
 *
 * Mirrors the personal-bests backfill: a rate limit breaks the loop rather than
 * throwing, so completed work survives; any other error is recorded against the
 * activity and skipped, so one unreadable session cannot wedge the scan.
 *
 * Two departures from that pattern, both deliberate. Rows are written as they
 * are derived rather than batched at the end, because each row is independent
 * and doubles as the progress record — deferring the write would risk
 * re-spending reads. And activities are fetched strictly in sequence: stream
 * payloads are hundreds of kilobytes, and a parallel fan-out would race past a
 * 429 spending budget on requests that cannot succeed.
 */
export async function scanTrainingQuality(
  userId: string,
  activities: StravaActivity[],
  deps: QualityScanDeps,
  batchSize = QUALITY_SCAN_BATCH,
): Promise<QualityScanResult> {
  const db = getDb();
  const rows = await db
    .select({
      activityId: activityQuality.activityId,
      streamStatus: activityQuality.streamStatus,
      attempts: activityQuality.attempts,
      schemaVersion: activityQuality.schemaVersion,
      derivedAt: activityQuality.derivedAt,
    })
    .from(activityQuality)
    .where(eq(activityQuality.userId, userId));

  const now = Math.floor(Date.now() / 1000);
  const pending = pendingQuality(activities, rows, { now });
  const batch = pending.slice(0, batchSize);

  if (batch.length === 0) {
    await writeScanState(userId, "done");
    return {
      processed: 0, derived: 0, failed: 0, remaining: 0,
      reads: 0, done: true, rateLimited: false,
    };
  }

  const attemptsById = new Map(rows.map((r) => [r.activityId, r.attempts]));
  const model = resolveZoneModel(deps.zones, null);

  let processed = 0;
  let derived = 0;
  let failed = 0;
  let reads = 0;
  let rateLimited = false;

  for (const activity of batch) {
    const activityId = String(activity.id);
    const base = {
      userId,
      activityId,
      startDate: activity.start_date_local.split("T")[0],
      startedAt: epochOf(activity),
      name: activity.name,
      workoutKey: workoutKey(activity.name),
      movingTime: activity.moving_time,
      elapsedTime: activity.elapsed_time ?? activity.moving_time,
      distance: activity.distance,
      avgHr: activity.average_heartrate ? Math.round(activity.average_heartrate) : null,
      maxHr: activity.max_heartrate ? Math.round(activity.max_heartrate) : null,
      schemaVersion: QUALITY_SCHEMA_VERSION,
      derivedAt: Math.floor(Date.now() / 1000),
      attempts: (attemptsById.get(activityId) ?? 0) + 1,
    };

    // --- Stage one: streams. Every analysable run needs these.
    let streams: StreamSet | null;
    try {
      streams = await deps.fetchStreams(activity.id);
      reads++;
    } catch (err) {
      if (isRateLimit(err)) {
        rateLimited = true;
        break;
      }
      reads++;
      log.warn("stream fetch failed during quality scan", {
        activityId,
        error: String(err),
      });
      await upsert(db, { ...base, streamStatus: "error", lapStatus: "skipped" });
      failed++;
      processed++;
      continue;
    }

    const hist = streams ? buildHrHistogram(streams, { elapsedTime: base.elapsedTime }) : null;
    const decoupling = streams ? aerobicDecoupling(streams, model) : null;

    const row: NewActivityQualityRow = {
      ...base,
      hrSeconds: hist?.seconds ?? null,
      hrCoverage: hist?.coverage ?? null,
      decoupling: decoupling?.pct ?? null,
      decouplingEligible: decoupling?.eligible ?? false,
      streamStatus: !streams ? "none" : (hist?.status ?? "none"),
      lapStatus: "skipped",
    };

    // --- Stage two: laps, only where structure is plausible. A failure here
    // must not discard stage one's row — that read is already spent.
    if (isQualityCandidate(activity, model)) {
      try {
        const detail = await deps.fetchDetail(activity.id);
        reads++;
        const laps = detail.laps ?? [];
        if (laps.length <= 1) {
          row.lapStatus = "none";
        } else {
          const structure = analyzeStructure(laps, getDiscipline(activity));
          row.structureKind = structure.kind;
          row.sets = structure.sets;
          row.workSeconds = structure.workSeconds;
          row.recoverySeconds = structure.recoverySeconds;
          row.lapStatus = structure.kind === "steady" ? "auto-laps" : "ok";
        }
      } catch (err) {
        reads++;
        row.lapStatus = "error";
        await upsert(db, row);
        derived++;
        processed++;
        if (isRateLimit(err)) {
          rateLimited = true;
          break;
        }
        log.warn("lap fetch failed during quality scan", {
          activityId,
          error: String(err),
        });
        continue;
      }
    }

    await upsert(db, row);
    derived++;
    processed++;
  }

  const remaining = pending.length - processed;
  await writeScanState(userId, rateLimited ? "rate-limited" : remaining > 0 ? "partial" : "done");

  log.info("quality scan batch", { userId, processed, derived, failed, reads, remaining, rateLimited });

  return {
    processed,
    derived,
    failed,
    remaining,
    reads,
    done: !rateLimited && remaining <= 0,
    rateLimited,
  };
}

async function upsert(
  db: ReturnType<typeof getDb>,
  row: NewActivityQualityRow,
): Promise<void> {
  await db
    .insert(activityQuality)
    .values(row)
    .onConflictDoUpdate({
      target: [activityQuality.userId, activityQuality.activityId],
      set: { ...row },
    });
}

async function writeScanState(userId: string, result: string): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db
    .insert(scanState)
    .values({ userId, kind: "quality", lastRunAt: now, lastResult: result, updatedAt: now })
    .onConflictDoUpdate({
      target: [scanState.userId, scanState.kind],
      set: { lastRunAt: now, lastResult: result, updatedAt: now },
    });
}

/** Stored rows in the shape the core recap builder consumes. */
export async function getQualityProfiles(
  userId: string,
  fromDate?: string,
): Promise<QualityProfile[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(activityQuality)
    .where(eq(activityQuality.userId, userId));

  return rows
    .filter((r) => !fromDate || r.startDate >= fromDate)
    .map((r) => ({
      activityId: r.activityId,
      date: r.startDate,
      name: r.name,
      workoutKey: r.workoutKey,
      movingTime: r.movingTime,
      elapsedTime: r.elapsedTime,
      distance: r.distance,
      avgHr: r.avgHr,
      maxHr: r.maxHr,
      hrSeconds: r.hrSeconds,
      hrCoverage: r.hrCoverage,
      decoupling: r.decoupling,
      decouplingEligible: r.decouplingEligible,
      structure:
        r.structureKind && r.sets
          ? ({
              kind: r.structureKind,
              sets: r.sets,
              workSeconds: r.workSeconds ?? 0,
              recoverySeconds: r.recoverySeconds ?? 0,
            } as SessionStructure)
          : null,
      streamStatus: r.streamStatus,
      lapStatus: r.lapStatus,
    }));
}

/** Drop a user's derived rows — used when a schema bump makes them worthless. */
export async function clearQualityProfiles(
  userId: string,
  activityIds?: string[],
): Promise<void> {
  const db = getDb();
  await db
    .delete(activityQuality)
    .where(
      activityIds
        ? and(
            eq(activityQuality.userId, userId),
            inArray(activityQuality.activityId, activityIds),
          )
        : eq(activityQuality.userId, userId),
    );
}
