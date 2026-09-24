import type {
  ActivityTotals,
  AthleteDetail,
  AthleteStats,
  AthleteZones,
  DetailedActivity,
  Lap,
  Split,
  StravaActivity,
  StreamSet,
} from "@trihards/core";

/**
 * A stand-in Strava for local development and browser testing.
 *
 * Signing in through Strava needs a real account and a real OAuth round trip,
 * which makes the dashboard impossible to exercise from a script. In `next dev`
 * only, /api/dev/login signs in a made-up athlete whose access token is
 * MOCK_ACCESS_TOKEN, and stravaFetch answers that token from here instead of
 * calling Strava. Every other account on the same dev server still talks to the
 * real Strava: the switch is the token, not a global flag.
 *
 * The data is generated, not recorded: a year of swim/ride/run training
 * building to a half marathon four days before "today", then an easy recovery
 * week, so the dashboard has form, load, a race and recent sessions to show.
 * It is deterministic for a given day.
 */

/** Far outside Strava's real id range, so it can never collide with a real athlete. */
export const MOCK_ATHLETE_ID = 999_999_999_999;
export const MOCK_ACCESS_TOKEN = "dev-mock-strava-token";

export const MOCK_ATHLETE = {
  firstname: "Test",
  lastname: "Athlete",
};

/**
 * Only under `next dev`, and only against a local database file.
 *
 * The first condition keeps it out of production builds. The second matters as
 * much: the everyday dev server points at the live Turso database, so a mock
 * sign-in there would write a fake athlete, licence and cache rows into
 * production. `pnpm dev:mock` runs the dev server on apps/web/.data/local.db.
 */
export function devMockEnabled(): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  const url = process.env.TURSO_DATABASE_URL ?? "";
  return url.startsWith("file:") || url === ":memory:";
}

export function isMockAccessToken(token: string): boolean {
  return devMockEnabled() && token === MOCK_ACCESS_TOKEN;
}

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 365;
const RACE_DAYS_AGO = 4;
const FTP = 250;

interface Template {
  name: string;
  sport: "Run" | "Ride" | "Swim";
  km: number;
  min: number;
  hr: number;
  watts?: number;
  workoutType?: number;
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Small deterministic jitter in [-1, 1] from a day index. */
function jitter(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/** What was trained on a day, `daysAgo` before today. */
function sessionsFor(daysAgo: number, weekday: number): Template[] {
  if (daysAgo === RACE_DAYS_AGO) {
    return [{ name: "Half Marathon", sport: "Run", km: 21.1, min: 92.8, hr: 168, workoutType: 1 }];
  }
  if (daysAgo < RACE_DAYS_AGO) {
    // Recovery week after the race.
    if (daysAgo === 1) return [{ name: "Recovery run", sport: "Run", km: 6.2, min: 36, hr: 124 }];
    if (daysAgo === 2) return [{ name: "Easy swim", sport: "Swim", km: 1.8, min: 38, hr: 118 }];
    return [];
  }
  if (daysAgo <= RACE_DAYS_AGO + 7) {
    // Taper: shorter, same rhythm.
    if (daysAgo === RACE_DAYS_AGO + 1) return [{ name: "Shakeout + strides", sport: "Run", km: 4, min: 21, hr: 131 }];
    if (daysAgo === RACE_DAYS_AGO + 2) return [{ name: "Openers ride", sport: "Ride", km: 32, min: 60, hr: 128, watts: 175 }];
    if (weekday === 2) return [{ name: "Race-pace 3 x 2 km", sport: "Run", km: 10, min: 48, hr: 158 }];
    if (weekday === 4) return [{ name: "Easy swim", sport: "Swim", km: 2, min: 40, hr: 122 }];
    return [];
  }
  // A build that grows over the year: 70% of full volume a year out.
  const scale = 0.7 + 0.3 * (1 - daysAgo / HISTORY_DAYS);
  const s = (t: Template): Template => ({ ...t, km: +(t.km * scale).toFixed(1), min: Math.round(t.min * scale) });
  switch (weekday) {
    case 1: return [s({ name: "Swim technique", sport: "Swim", km: 2.4, min: 50, hr: 126 })];
    case 2: return [s({ name: "Threshold intervals", sport: "Run", km: 12, min: 58, hr: 156 })];
    case 3: return [s({ name: "Endurance ride", sport: "Ride", km: 60, min: 120, hr: 132, watts: 180 })];
    case 4: return [s({ name: "Easy run", sport: "Run", km: 10, min: 56, hr: 140 }), s({ name: "Pool session", sport: "Swim", km: 2, min: 42, hr: 124 })];
    case 5: return [];
    case 6: return [s({ name: "Long ride", sport: "Ride", km: 90, min: 180, hr: 135, watts: 185 })];
    default: return [s({ name: "Long run", sport: "Run", km: 20, min: 112, hr: 146 })];
  }
}

function toActivity(t: Template, day: Date, idx: number, n: number): StravaActivity {
  const wobble = 1 + jitter(n) * 0.04;
  const moving = Math.round(t.min * 60 * wobble);
  const distance = Math.round(t.km * 1000 * (t.workoutType ? 1 : wobble));
  const start = new Date(day.getTime() + (7 + idx * 10) * 3_600_000);
  return {
    id: 8_000_000_000 + n * 10 + idx,
    name: t.name,
    sport_type: t.sport,
    type: t.sport,
    start_date: start.toISOString(),
    start_date_local: start.toISOString(),
    distance,
    moving_time: moving,
    elapsed_time: moving + 60,
    total_elevation_gain: t.sport === "Swim" ? 0 : Math.round(t.km * 6),
    average_speed: distance / moving,
    max_speed: (distance / moving) * 1.35,
    average_heartrate: Math.round(t.hr + jitter(n + 1) * 3),
    max_heartrate: Math.round(t.hr + 18),
    suffer_score: Math.round(t.min * (t.hr - 100) / 40),
    average_watts: t.watts,
    weighted_average_watts: t.watts ? t.watts + 8 : undefined,
    kilojoules: t.watts ? Math.round((t.watts * moving) / 1000) : undefined,
    trainer: false,
    manual: false,
    workout_type: t.workoutType ?? null,
  };
}

/** Every mock activity, newest first. */
export function mockActivities(now = new Date()): StravaActivity[] {
  const today = new Date(`${dateOnly(now)}T00:00:00Z`);
  const out: StravaActivity[] = [];
  for (let daysAgo = 0; daysAgo <= HISTORY_DAYS; daysAgo++) {
    const day = new Date(today.getTime() - daysAgo * DAY_MS);
    // Day number since the epoch keeps ids and jitter stable across requests.
    const n = Math.floor(day.getTime() / DAY_MS);
    sessionsFor(daysAgo, day.getUTCDay()).forEach((t, i) => out.push(toActivity(t, day, i, n)));
  }
  // Nothing from later today: the athlete hasn't done it yet.
  return out
    .filter((a) => new Date(a.start_date).getTime() <= now.getTime())
    .sort((a, b) => b.start_date.localeCompare(a.start_date));
}

function detailFor(a: StravaActivity): DetailedActivity {
  const isRun = a.sport_type === "Run";
  const km = Math.floor(a.distance / 1000);
  const perKm = a.moving_time / (a.distance / 1000);
  const splits: Split[] = isRun
    ? Array.from({ length: km }, (_, i) => {
        // Races finish faster than they start: a negative split.
        const drift = a.workout_type === 1 ? 1.02 - (0.04 * i) / Math.max(km - 1, 1) : 1 + jitter(i) * 0.02;
        const t = Math.round(perKm * drift);
        return {
          split: i + 1,
          distance: 1000,
          moving_time: t,
          elapsed_time: t,
          average_speed: 1000 / t,
          average_heartrate: Math.round((a.average_heartrate ?? 140) - 6 + (12 * i) / Math.max(km, 1)),
          elevation_difference: Math.round(jitter(i + 7) * 4),
        };
      })
    : [];
  const lapCount = a.sport_type === "Swim" ? 4 : 3;
  const laps: Lap[] = Array.from({ length: lapCount }, (_, i) => ({
    id: a.id * 10 + i,
    name: `Lap ${i + 1}`,
    lap_index: i + 1,
    distance: Math.round(a.distance / lapCount),
    moving_time: Math.round(a.moving_time / lapCount),
    elapsed_time: Math.round(a.moving_time / lapCount),
    average_speed: a.average_speed,
    average_heartrate: a.average_heartrate,
    average_watts: a.average_watts,
  }));
  return {
    ...a,
    description: "Generated by the dev Strava mock.",
    device_name: "Mock Watch",
    splits_metric: splits,
    laps,
    best_efforts: isRun && a.distance >= 5000
      ? [
          { name: "1k", distance: 1000, moving_time: Math.round(perKm * 0.93) },
          { name: "5k", distance: 5000, moving_time: Math.round(perKm * 5 * 0.97) },
        ]
      : [],
  };
}

function streamsFor(a: StravaActivity): StreamSet {
  const step = 10;
  const points = Math.max(2, Math.floor(a.moving_time / step));
  const time = Array.from({ length: points }, (_, i) => i * step);
  const hr0 = a.average_heartrate ?? 140;
  return {
    time: { data: time },
    distance: { data: time.map((t) => Math.round((a.distance * t) / a.moving_time)) },
    heartrate: { data: time.map((t, i) => Math.round(hr0 - 10 + Math.min(1, t / 600) * 10 + jitter(i) * 3)) },
    velocity_smooth: { data: time.map((_, i) => +(a.average_speed * (1 + jitter(i + 3) * 0.05)).toFixed(2)) },
    altitude: { data: time.map((_, i) => +(20 + Math.sin(i / 30) * 8).toFixed(1)) },
    ...(a.average_watts ? { watts: { data: time.map((_, i) => Math.round(a.average_watts! * (1 + jitter(i + 5) * 0.12))) } } : {}),
  };
}

function totals(acts: StravaActivity[]): ActivityTotals {
  return {
    count: acts.length,
    distance: acts.reduce((s, a) => s + a.distance, 0),
    moving_time: acts.reduce((s, a) => s + a.moving_time, 0),
    elevation_gain: acts.reduce((s, a) => s + a.total_elevation_gain, 0),
  };
}

function statsFor(all: StravaActivity[], now: Date): AthleteStats {
  const fourWeeks = now.getTime() - 28 * DAY_MS;
  const yearStart = `${now.getUTCFullYear()}-01-01`;
  const of = (sport: string, from?: (a: StravaActivity) => boolean) =>
    totals(all.filter((a) => a.sport_type === sport && (!from || from(a))));
  const recent = (a: StravaActivity) => new Date(a.start_date).getTime() >= fourWeeks;
  const ytd = (a: StravaActivity) => a.start_date >= yearStart;
  return {
    biggest_ride_distance: Math.max(0, ...all.filter((a) => a.sport_type === "Ride").map((a) => a.distance)),
    biggest_climb_elevation_gain: 420,
    recent_ride_totals: of("Ride", recent),
    recent_run_totals: of("Run", recent),
    recent_swim_totals: of("Swim", recent),
    ytd_ride_totals: of("Ride", ytd),
    ytd_run_totals: of("Run", ytd),
    ytd_swim_totals: of("Swim", ytd),
    all_ride_totals: of("Ride"),
    all_run_totals: of("Run"),
    all_swim_totals: of("Swim"),
  };
}

export class MockStravaError extends Error {}

/** Answers a Strava API path the way Strava would, for the mock athlete. */
export function mockStravaResponse(path: string, params?: Record<string, string>): unknown {
  const now = new Date();
  const all = mockActivities(now);

  if (path === "/athlete/activities") {
    const after = Number(params?.after ?? 0) * 1000;
    const perPage = Number(params?.per_page ?? 30);
    const page = Number(params?.page ?? 1);
    // Strava returns oldest-first when filtering by `after`.
    const matching = all.filter((a) => new Date(a.start_date).getTime() > after).reverse();
    return matching.slice((page - 1) * perPage, page * perPage);
  }
  if (path === "/athlete") {
    const athlete: AthleteDetail = {
      id: MOCK_ATHLETE_ID,
      firstname: MOCK_ATHLETE.firstname,
      lastname: MOCK_ATHLETE.lastname,
      profile: "",
      profile_medium: "",
      city: "Copenhagen",
      country: "Denmark",
      weight: 72,
      ftp: FTP,
      measurement_preference: "meters",
    };
    return athlete;
  }
  if (path === "/athlete/zones") {
    const zones: AthleteZones = {
      heart_rate: {
        custom_zones: true,
        zones: [
          { min: 0, max: 128 },
          { min: 128, max: 145 },
          { min: 145, max: 158 },
          { min: 158, max: 170 },
          { min: 170, max: -1 },
        ],
      },
    };
    return zones;
  }
  if (/^\/athletes\/\d+\/stats$/.test(path)) return statsFor(all, now);

  const streams = path.match(/^\/activities\/(\d+)\/streams$/);
  const detail = path.match(/^\/activities\/(\d+)$/);
  const id = Number((streams ?? detail)?.[1]);
  if (id) {
    const activity = all.find((a) => a.id === id);
    if (!activity) throw new MockStravaError(`Strava API error 404: mock has no activity ${id}`);
    return streams ? streamsFor(activity) : detailFor(activity);
  }

  throw new MockStravaError(`Strava API error 404: mock does not implement ${path}`);
}
