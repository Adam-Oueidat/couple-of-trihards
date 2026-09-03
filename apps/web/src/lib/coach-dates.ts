import type { StravaActivity } from "@trihards/core";

// Pure date helpers for the coach, kept free of heavy/side-effecting imports so
// the timezone logic — the source of the date-confusion bugs — is unit-testable.

// Strava reports `start_date` in true UTC and `start_date_local` as the local
// wall-clock time (with a misleading trailing "Z"). Diffing the two recovers
// the athlete's UTC offset, which we use to compute *their* current date when
// the client didn't send one.
export function athleteOffsetMs(activities: StravaActivity[]): number | null {
  const a = activities[0];
  if (!a?.start_date || !a?.start_date_local) return null;
  const utc = new Date(a.start_date).getTime();
  const local = new Date(a.start_date_local).getTime();
  if (Number.isNaN(utc) || Number.isNaN(local)) return null;
  return local - utc;
}

// Resolve "today" in the athlete's timezone. Priority:
//   1. the date the browser sent (most reliable — it's the user's real clock)
//   2. the IANA timezone the browser sent
//   3. derived from their most recent activity's UTC offset
//   4. server UTC date (last resort)
// Steps 2-4 are resolveNow's chain; this is the date-only front door onto it,
// for the callers that need a day and not a moment.
export function resolveToday(
  clientToday: string | undefined,
  activities: StravaActivity[],
  timezone?: string,
): string {
  if (clientToday && /^\d{4}-\d{2}-\d{2}$/.test(clientToday)) return clientToday;
  return resolveNow({ activities, timezone }).date;
}

// The athlete-local calendar date (YYYY-MM-DD) of a unix-seconds timestamp,
// using the same activity-derived UTC offset as resolveToday. Lets the server
// tell whether a stored conversation belongs to a prior local day.
export function localDateOf(
  unixSeconds: number,
  activities: StravaActivity[],
): string {
  const offset = athleteOffsetMs(activities) ?? 0;
  return new Date(unixSeconds * 1000 + offset).toISOString().split("T")[0];
}

// Jan 1 of the year an ISO `YYYY-MM-DD` date falls in. The lower bound for
// "year to date": personal bests are scoped to the current calendar year, so
// this is what both the read filter and the backfill window compare against.
export function yearStartOf(today: string): string {
  return `${today.slice(0, 4)}-01-01`;
}

// Unix-seconds instant of an ISO `YYYY-MM-DD` date at midnight UTC. Strava's
// `start_date` is true UTC, so this is the comparable form of a year boundary
// when filtering activities.
export function epochOfDate(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
}

// Whole days from one ISO date to another; negative when `to` is in the past.
export function daysBetween(from: string, to: string): number {
  return Math.round((epochOfDate(to) - epochOfDate(from)) / 86400);
}

// A real IANA zone name is the only way to report a *time* correctly: an offset
// derived from an activity is a snapshot that travel or DST has likely moved
// since. Intl is the validator — it throws on any zone it doesn't know.
export function isValidTimeZone(timezone: string | undefined): timezone is string {
  if (!timezone || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// "UTC+02:00" / "UTC-05:30" — how we name a zone we only know as an offset.
function offsetLabel(offsetMs: number): string {
  if (offsetMs === 0) return "UTC";
  const total = Math.round(Math.abs(offsetMs) / 60000);
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `UTC${offsetMs < 0 ? "-" : "+"}${hh}:${mm}`;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

// Day name of an ISO `YYYY-MM-DD` date, read off the UTC calendar so it always
// describes the date string itself and never the server's local day.
export function dayOfWeekOf(date: string): string {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? "";
}

// Where a reported moment came from, strongest first. Surfaced to the coach so
// it can hedge on a weak clock instead of asserting a time it cannot know.
export type NowSource =
  | "client-timezone"
  | "client-date"
  | "activity-offset"
  | "server-utc";

export interface ResolvedNow {
  date: string; // YYYY-MM-DD, athlete-local
  time: string; // HH:MM, athlete-local, 24-hour
  dayOfWeek: string;
  timezone: string; // IANA name when known, otherwise a UTC±HH:MM label
  utc: string; // the same instant as an ISO 8601 UTC string
  source: NowSource;
}

// The parts of `instant` as they read on the wall clock of `timeZone`. en-CA
// gives ISO-ordered date parts, and h23 avoids the "24:05" hour that the
// default hour cycle emits just after midnight.
function partsInZone(
  instant: number,
  timeZone: string,
): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

// The authoritative current moment in the athlete's timezone — what the coach's
// get_current_datetime tool hands back. Priority:
//   1. the IANA timezone the browser reported (a real zone, so DST is right)
//   2. the UTC offset derived from their most recent activity
//   3. the server's own UTC clock
// A client-sent calendar date outranks the *date* of 2 and 3 — the browser
// knows which day it is even when we can only guess its offset. The fallback's
// wall-clock time is kept in that case rather than dropped: a stale offset is
// wrong about the day boundary, not about the hour.
export function resolveNow(opts: {
  activities: StravaActivity[];
  timezone?: string;
  clientToday?: string;
  now?: number;
}): ResolvedNow {
  const instant = opts.now ?? Date.now();
  const utc = new Date(instant).toISOString();

  if (isValidTimeZone(opts.timezone)) {
    const { date, time } = partsInZone(instant, opts.timezone);
    return {
      date,
      time,
      dayOfWeek: dayOfWeekOf(date),
      timezone: opts.timezone,
      utc,
      source: "client-timezone",
    };
  }

  const offset = athleteOffsetMs(opts.activities);
  const shifted = new Date(instant + (offset ?? 0)).toISOString();
  let date = shifted.slice(0, 10);
  let source: NowSource = offset !== null ? "activity-offset" : "server-utc";

  const clientToday = opts.clientToday;
  if (clientToday && /^\d{4}-\d{2}-\d{2}$/.test(clientToday) && clientToday !== date) {
    date = clientToday;
    source = "client-date";
  }

  return {
    date,
    time: shifted.slice(11, 16),
    dayOfWeek: dayOfWeekOf(date),
    timezone: offsetLabel(offset ?? 0),
    utc,
    source,
  };
}

const SOURCE_NOTES: Record<NowSource, string> = {
  "client-timezone": "the athlete's device timezone (exact)",
  "client-date":
    "the athlete's device calendar date; the time is approximate, derived from their latest activity's UTC offset",
  "activity-offset":
    "the UTC offset of the athlete's latest activity; approximate if they have travelled or DST has shifted since",
  "server-utc":
    "the server clock in UTC — no timezone signal was available, so the athlete's local time may differ",
};

// Rendered as the get_current_datetime tool result. States the source so the
// coach can qualify a weak clock rather than asserting a time it cannot know.
export function formatResolvedNow(now: ResolvedNow): string {
  return [
    `Current date: ${now.date} (${now.dayOfWeek})`,
    `Current local time: ${now.time} (${now.timezone})`,
    `UTC instant: ${now.utc}`,
    `Source: ${SOURCE_NOTES[now.source]}`,
  ].join("\n");
}
