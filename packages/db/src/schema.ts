import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { RawPlannedSession } from "@trihards/core";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  integer("created_at")
    .notNull()
    .$defaultFn(() => Math.floor(Date.now() / 1000));

export const users = sqliteTable("users", {
  id: id(),
  stravaAthleteId: integer("strava_athlete_id").notNull().unique(),
  licenseId: text("license_id"),
  displayName: text("display_name"),
  firstSeenAt: integer("first_seen_at")
    .notNull()
    .$defaultFn(() => Math.floor(Date.now() / 1000)),
});

export const licenses = sqliteTable(
  "licenses",
  {
    id: id(),
    // sha256 hex digest of the plaintext key. The plaintext is only ever
    // shown once at generation time and is never persisted.
    keyHash: text("key_hash").notNull().unique(),
    // First chars of the plaintext key (e.g. "LIC-ABCD") for admin display,
    // so revoke/identify flows don't require knowing the full key.
    keyPrefix: text("key_prefix").notNull(),
    boundUserId: text("bound_user_id").references(() => users.id),
    createdByAdminAthleteId: integer("created_by_admin_athlete_id").notNull(),
    revokedAt: integer("revoked_at"),
    // Unix seconds at which an unredeemed key becomes invalid. Cleared
    // (set to NULL) once the key is claimed — bound licenses are permanent.
    // The sweep in admin actions deletes unbound rows past this point.
    expiresAt: integer("expires_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("licenses_bound_user_idx").on(t.boundUserId),
    index("licenses_expires_at_idx").on(t.expiresAt),
  ],
);

export const stravaTokens = sqliteTable("strava_tokens", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: integer("expires_at").notNull(),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Math.floor(Date.now() / 1000)),
});

export const mobileTokens = sqliteTable(
  "mobile_tokens",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("mobile_tokens_user_idx").on(t.userId)],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: integer("started_at")
      .notNull()
      .$defaultFn(() => Math.floor(Date.now() / 1000)),
    lastMessageAt: integer("last_message_at")
      .notNull()
      .$defaultFn(() => Math.floor(Date.now() / 1000)),
    summary: text("summary"),
  },
  (t) => [index("conversations_user_idx").on(t.userId, t.lastMessageAt)],
);

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "tool_result"] }).notNull(),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("chat_messages_user_created_idx").on(t.userId, t.createdAt),
    index("chat_messages_conv_created_idx").on(t.conversationId, t.createdAt),
  ],
);

export const analyses = sqliteTable(
  "analyses",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activityId: text("activity_id").notNull(),
    text: text("text").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("analyses_user_activity_uq").on(t.userId, t.activityId)],
);

export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  createdAt: createdAt(),
  // Unix seconds when the athlete archived it: done with, but kept to look
  // back on. Null while the goal is active.
  archivedAt: integer("archived_at"),
});

export const customWorkouts = sqliteTable(
  "custom_workouts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    discipline: text("discipline", { enum: ["swim", "ride", "run", "strength"] }).notNull(),
    name: text("name").notNull(),
    distanceKm: real("distance_km"),
    durationMin: real("duration_min"),
    notes: text("notes"),
    addedBy: text("added_by", { enum: ["athlete", "coach"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("custom_workouts_user_date_idx").on(t.userId, t.date)],
);

export const planOverrides = sqliteTable(
  "plan_overrides",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    originalDate: text("original_date").notNull(),
    newDate: text("new_date").notNull(),
    movedAt: integer("moved_at").notNull(),
    reason: text("reason"),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    // "I did not do this one, and here is why." Deliberately distinct from
    // `hidden`: a hidden session is gone from the plan, while a skipped one
    // stays on the calendar so the athlete — and the coach — can still see it
    // was prescribed. `skipReason` is its own column rather than a second use
    // of `reason` above, which carries the *move* reason: a session can be both
    // moved and skipped, and collapsing the two would make "moved to Thursday
    // because of work travel" indistinguishable from "not done at all".
    skipped: integer("skipped", { mode: "boolean" }).notNull().default(false),
    skipReason: text("skip_reason"),
    // Athlete edits to the session's own fields. Null means "unchanged, use
    // whatever the plan says", which is what keeps a re-upload of the same plan
    // from silently discarding edits — the override layers on top rather than
    // replacing the stored session.
    name: text("name"),
    type: text("type"),
    km: real("km"),
    durationMin: integer("duration_min"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sessionId] })],
);

// An athlete's own training plan. One row is one whole plan.
//
// `sessions` is a JSON column rather than a `plan_sessions` child table because
// packages/core/src/plan.ts only ever consumes a plan whole: `matchSessions`,
// `plannedVsActualByWeek`, and the calendar all take a complete `TrainingPlan`
// and iterate `plan.sessions` in memory. Nothing queries, filters, or mutates a
// single session by id in SQL — reschedules and removals live in the separate
// `plan_overrides` table, keyed by the slug id derived from (date, name). A
// child table would therefore add a join plus re-ordering on every dashboard
// render and buy nothing, while the JSON column is a single row read that maps
// 1:1 onto `RawTrainingPlan`.
//
// Uploads are append-only: a new upload inserts a new row and the athlete's
// active plan is their most recent one, so an accidental upload never destroys
// the plan it replaced.
export const trainingPlans = sqliteTable(
  "training_plans",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Where the plan came from: "Runna", "Coach", the uploaded file's origin.
    source: text("source").notNull(),
    // "multi" when sessions carry their own sports (a triathlon plan).
    discipline: text("discipline", { enum: ["swim", "ride", "run", "multi"] }).notNull(),
    startDate: text("start_date").notNull(),
    raceDate: text("race_date").notNull(),
    raceName: text("race_name").notNull(),
    // JSON array of { date, name, type, km } — validated by
    // parseRawTrainingPlan (@trihards/core) before it is ever written or read.
    sessions: text("sessions", { mode: "json" })
      .$type<RawPlannedSession[]>()
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("training_plans_user_created_idx").on(t.userId, t.createdAt)],
);

export const personalBests = sqliteTable(
  "personal_bests",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    effortName: text("effort_name").notNull(),
    distance: integer("distance").notNull(),
    movingTime: integer("moving_time").notNull(),
    activityId: text("activity_id").notNull(),
    activityName: text("activity_name").notNull(),
    activityDate: text("activity_date").notNull(),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Math.floor(Date.now() / 1000)),
  },
  (t) => [primaryKey({ columns: [t.userId, t.effortName] })],
);

// Resume cursor for the year-to-date personal-best backfill. Strava only returns
// `best_efforts` on the per-activity detail endpoint, so covering a whole year
// costs one API call per run — far past the 100-reads/15-min budget for a single
// request. The backfill therefore runs in bounded batches and records how far it
// got here: `syncedThrough` is the `start_date` (Unix seconds) of the last
// activity it processed, so the next batch resumes after it and a re-run of an
// already-synced year is free.
export const pbSyncState = sqliteTable("pb_sync_state", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  syncedThrough: integer("synced_through").notNull(),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Math.floor(Date.now() / 1000)),
});

// Durable cache for Strava API responses that back the dashboard render path
// (recent activities + the Fitness Profile's athlete detail/zones/stats). Stored
// in the database — not an in-memory Map — so it survives server restarts and is
// shared across serverless instances: a plain browser reload re-serves these
// rows instead of spending Strava rate-limit budget. Rows are refreshed only
// when explicitly invalidated (a fresh OAuth login or the dashboard "Sync"
// button), which deletes the athlete's rows so the next render refetches.
export const stravaCache = sqliteTable(
  "strava_cache",
  {
    athleteId: integer("athlete_id").notNull(),
    cacheKey: text("cache_key").notNull(),
    data: text("data").notNull(),
    fetchedAt: integer("fetched_at")
      .notNull()
      .$defaultFn(() => Math.floor(Date.now() / 1000)),
  },
  (t) => [primaryKey({ columns: [t.athleteId, t.cacheKey] })],
);

/**
 * One activity's derived training-quality profile.
 *
 * Deliberately NOT in `strava_cache`: every dashboard Sync press calls
 * invalidateAthleteCache, which deletes that athlete's rows wholesale. These
 * rows cost one to two Strava reads each to rebuild, so a single button press
 * would throw away hours of accumulated scanning.
 *
 * What is stored is DERIVED, never raw. A 90-minute run sampled at 1 Hz across
 * five stream channels is several hundred kilobytes of JSON; the aggregates
 * below are about one, and answer every question the quality panel asks.
 */
export const activityQuality = sqliteTable(
  "activity_quality",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Text, matching analyses.activityId and personalBests.activityId: Strava
    // ids keep growing and JS numbers are not 64-bit safe.
    activityId: text("activity_id").notNull(),

    // Identity, copied so the panel can render without joining the cache.
    startDate: text("start_date").notNull(), // YYYY-MM-DD, athlete-local
    startedAt: integer("started_at").notNull(), // Unix seconds
    name: text("name").notNull(),
    workoutKey: text("workout_key").notNull(), // normalised, for same-workout comparison
    movingTime: integer("moving_time").notNull(),
    elapsedTime: integer("elapsed_time").notNull(),
    distance: real("distance").notNull(), // meters
    avgHr: integer("avg_hr"),
    maxHr: integer("max_hr"),

    // Seconds at each 1 bpm bucket (see HR_HIST_MIN/MAX in @trihards/core),
    // NOT five zone totals. Zone boundaries are the least stable input in the
    // feature: an athlete who sets custom zones, or whose /athlete/zones call
    // starts succeeding, would invalidate every stored bucket and force a full
    // re-scan at a Strava read apiece. A histogram is re-bucketable for free,
    // which makes the zone model a read-time decision instead of a stored one.
    hrSeconds: text("hr_seconds", { mode: "json" }).$type<number[] | null>(),
    hrCoverage: real("hr_coverage"), // attributed seconds / elapsed, 0..1

    decoupling: real("decoupling"),
    decouplingEligible: integer("decoupling_eligible", { mode: "boolean" })
      .notNull()
      .default(false),

    // Session structure from the lap file; null when laps were not fetched.
    structureKind: text("structure_kind", {
      enum: ["intervals", "steady", "progression", "unknown"],
    }),
    sets: text("sets", { mode: "json" }).$type<unknown[] | null>(),
    workSeconds: integer("work_seconds"),
    recoverySeconds: integer("recovery_seconds"),

    // Provenance, so the panel can say honestly what it has and the scan knows
    // what is worth retrying.
    streamStatus: text("stream_status", {
      enum: ["ok", "partial", "none", "error"],
    }).notNull(),
    lapStatus: text("lap_status", {
      enum: ["ok", "auto-laps", "none", "skipped", "error"],
    }).notNull(),
    attempts: integer("attempts").notNull().default(1),
    // The only invalidation lever: bump it and every row re-derives.
    schemaVersion: integer("schema_version").notNull(),
    derivedAt: integer("derived_at")
      .notNull()
      .$defaultFn(() => Math.floor(Date.now() / 1000)),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.activityId] }),
    index("activity_quality_user_started_idx").on(t.userId, t.startedAt),
    index("activity_quality_user_workout_idx").on(t.userId, t.workoutKey),
  ],
);

/**
 * Progress metadata for the multi-batch backfills.
 *
 * `pb_sync_state` cannot host a second scan — it is user-scoped with a single
 * scalar cursor — so `kind` is the generalisation. That table is deliberately
 * left in place rather than migrated: moving a live cursor buys nothing and a
 * mistake would re-spend a year of personal-best reads.
 *
 * Note this carries no cursor of its own. The quality scan finds its pending
 * work by anti-joining activity_quality against the cached activity list, so
 * the rows themselves ARE the progress record. What lives here is only what the
 * UI wants to report back.
 */
export const scanState = sqliteTable(
  "scan_state",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["quality"] }).notNull(),
    lastRunAt: integer("last_run_at").notNull(),
    lastResult: text("last_result"), // "done" | "rate-limited" | "error"
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Math.floor(Date.now() / 1000)),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind] })],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type License = typeof licenses.$inferSelect;
export type NewLicense = typeof licenses.$inferInsert;
export type Goal = typeof goals.$inferSelect;
export type CustomWorkout = typeof customWorkouts.$inferSelect;
export type PlanOverride = typeof planOverrides.$inferSelect;
export type TrainingPlanRow = typeof trainingPlans.$inferSelect;
export type NewTrainingPlanRow = typeof trainingPlans.$inferInsert;
export type PersonalBest = typeof personalBests.$inferSelect;
export type PbSyncState = typeof pbSyncState.$inferSelect;
export type Analysis = typeof analyses.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type StravaToken = typeof stravaTokens.$inferSelect;
export type MobileToken = typeof mobileTokens.$inferSelect;
export type StravaCacheEntry = typeof stravaCache.$inferSelect;
export type ActivityQualityRow = typeof activityQuality.$inferSelect;
export type NewActivityQualityRow = typeof activityQuality.$inferInsert;
export type ScanStateRow = typeof scanState.$inferSelect;

// Suppress unused-import warning for `sql` if no schema entry uses it.
void sql;
