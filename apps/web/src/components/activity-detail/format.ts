import { ActivityMetrics, DetailedActivity, StreamSet } from "@trihards/core";
import { getDiscipline, formatSecondsAsClock } from "@trihards/core";

export interface DetailResponse {
  activity: DetailedActivity;
  streams: StreamSet | null;
  analysis: { text: string; createdAt: string } | null;
  /** Ride or run metrics; null for other sports. */
  metrics: ActivityMetrics | null;
}

export interface ChartPoint {
  km: number;
  hr?: number;
  pace?: number; // min/km for runs, km/h for rides
  alt?: number;
  watts?: number;
  cadence?: number; // rpm for rides, steps/min for runs
}

export interface LapPoint {
  lap: string;
  speed: number; // m/s — drives bar height so faster laps read taller
  seconds: number; // moving time — drives bar width so longer laps read wider
  pace: string; // discipline-aware label (min/km, /100m, or km/h) for the tooltip
  dist: string;
  time: string;
  hr?: number;
  walk: boolean; // slower than a walking threshold — rendered as a grey rest
}

// A lap slower than 10 min/km on foot reads as a walking rest, not a running
// effort. 10 min/km = 1000m / 600s ≈ 1.667 m/s. Only meaningful for run/other;
// bikes and swims have no comparable "walk" pace, so they never grey out.
const WALK_SPEED = 1000 / (10 * 60);

export function isWalk(speed: number, discipline: ReturnType<typeof getDiscipline>): boolean {
  return (discipline === "run" || discipline === "other") && speed > 0 && speed < WALK_SPEED;
}

const MAX_POINTS = 300;

export function buildChartPoints(
  streams: StreamSet,
  discipline: ReturnType<typeof getDiscipline>,
): ChartPoint[] {
  const dist = streams.distance?.data;
  if (!dist || dist.length === 0) return [];
  const isRide = discipline === "ride";

  const step = Math.max(1, Math.floor(dist.length / MAX_POINTS));
  const points: ChartPoint[] = [];

  // Power and cadence swing second to second, so one sample per bucket reads
  // as noise. They are averaged over the bucket instead; zeros are kept for
  // power (coasting is real work done: none) but dropped for cadence, which
  // the athlete means only while pedalling or running.
  const bucketMean = (data: number[] | undefined, i: number, skipZeros: boolean) => {
    if (!data) return undefined;
    let sum = 0;
    let n = 0;
    for (let j = i; j < Math.min(i + step, data.length); j++) {
      if (skipZeros && !data[j]) continue;
      sum += data[j];
      n++;
    }
    return n > 0 ? Math.round(sum / n) : undefined;
  };
  // Strava records run cadence per leg; runners count both feet.
  const cadenceScale = discipline === "run" ? 2 : 1;

  for (let i = 0; i < dist.length; i += step) {
    const v = streams.velocity_smooth?.data[i];
    const cadence = bucketMean(streams.cadence?.data, i, true);
    points.push({
      km: Math.round((dist[i] / 1000) * 100) / 100,
      hr: streams.heartrate?.data[i],
      pace:
        v && v > 0.5
          ? isRide
            ? Math.round(v * 3.6 * 10) / 10 // km/h
            : Math.round((1000 / v / 60) * 100) / 100 // min/km
          : undefined,
      alt: streams.altitude?.data[i],
      watts: bucketMean(streams.watts?.data, i, false),
      cadence: cadence === undefined ? undefined : cadence * cadenceScale,
    });
  }
  return points;
}

export function formatPaceValue(minPerKm: number): string {
  return formatSecondsAsClock(minPerKm * 60);
}

export function formatTime(seconds: number): string {
  return formatSecondsAsClock(seconds);
}

// Discipline-aware pace/speed for a recorded lap. Swims read per-100m, rides
// read as speed, everything else as min/km.
export function formatSplitPace(
  averageSpeed: number,
  discipline: ReturnType<typeof getDiscipline>,
): string {
  if (averageSpeed <= 0) return "-";
  if (discipline === "swim") return `${formatTime(Math.round(100 / averageSpeed))}/100m`;
  if (discipline === "ride") return `${(averageSpeed * 3.6).toFixed(1)} km/h`;
  return `${formatPaceValue(1000 / averageSpeed / 60)}/km`;
}

export function formatLapDistance(
  meters: number,
  discipline: ReturnType<typeof getDiscipline>,
): string {
  return discipline === "swim"
    ? `${Math.round(meters)} m`
    : `${(meters / 1000).toFixed(2)} km`;
}

export function buildLapPoints(
  laps: NonNullable<DetailedActivity["laps"]>,
  discipline: ReturnType<typeof getDiscipline>,
): LapPoint[] {
  return laps.map((l) => ({
    lap: `${l.lap_index}`,
    speed: l.average_speed,
    seconds: l.moving_time,
    pace: formatSplitPace(l.average_speed, discipline),
    dist: formatLapDistance(l.distance, discipline),
    time: formatTime(l.moving_time),
    hr: l.average_heartrate,
    walk: isWalk(l.average_speed, discipline),
  }));
}

// A proportional lap timeline: each lap is a bar whose WIDTH is its duration
// and whose HEIGHT is its speed. So a short fast rep reads narrow-and-tall, a
// long recovery jog wide-and-short, and a walk break wide-and-flat — the shape
// of the session is legible at a glance. Rendered as raw SVG because Recharts'
// categorical bars are always equal width.

// Shared recharts styling for the detail charts.
export const axisStyle = { fill: "#9ca3af", fontSize: 11 };
export const tooltipStyle = {
  backgroundColor: "#1f2937",
  border: "1px solid #374151",
  borderRadius: "8px",
  fontSize: "13px",
};
