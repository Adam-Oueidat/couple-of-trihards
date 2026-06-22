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
});

export const customWorkouts = sqliteTable(
  "custom_workouts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    discipline: text("discipline", { enum: ["swim", "ride", "run"] }).notNull(),
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
  },
  (t) => [primaryKey({ columns: [t.userId, t.sessionId] })],
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

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type License = typeof licenses.$inferSelect;
export type NewLicense = typeof licenses.$inferInsert;
export type Goal = typeof goals.$inferSelect;
export type CustomWorkout = typeof customWorkouts.$inferSelect;
export type PlanOverride = typeof planOverrides.$inferSelect;
export type PersonalBest = typeof personalBests.$inferSelect;
export type Analysis = typeof analyses.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type StravaToken = typeof stravaTokens.$inferSelect;
export type MobileToken = typeof mobileTokens.$inferSelect;
export type StravaCacheEntry = typeof stravaCache.$inferSelect;

// Suppress unused-import warning for `sql` if no schema entry uses it.
void sql;
