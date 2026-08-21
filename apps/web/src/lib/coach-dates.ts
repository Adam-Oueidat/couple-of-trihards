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
//   2. derived from their most recent activity's UTC offset
//   3. server UTC date (last resort)
export function resolveToday(
  clientToday: string | undefined,
  activities: StravaActivity[],
): string {
  if (clientToday && /^\d{4}-\d{2}-\d{2}$/.test(clientToday)) return clientToday;
  const offset = athleteOffsetMs(activities);
  if (offset !== null) {
    return new Date(Date.now() + offset).toISOString().split("T")[0];
  }
  return new Date().toISOString().split("T")[0];
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
