import { DetailedActivity, StreamSet } from "@trihards/core";
import { getDiscipline } from "@trihards/core";

export interface DetailResponse {
  activity: DetailedActivity;
  streams: StreamSet | null;
  analysis: { text: string; createdAt: string } | null;
}

export interface ChartPoint {
  km: number;
  hr?: number;
  pace?: number; // min/km for runs, km/h for rides
  alt?: number;
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

export function buildChartPoints(streams: StreamSet, isRide: boolean): ChartPoint[] {
  const dist = streams.distance?.data;
  if (!dist || dist.length === 0) return [];

  const step = Math.max(1, Math.floor(dist.length / MAX_POINTS));
  const points: ChartPoint[] = [];

  for (let i = 0; i < dist.length; i += step) {
    const v = streams.velocity_smooth?.data[i];
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
    });
  }
  return points;
}

export function formatPaceValue(minPerKm: number): string {
  const min = Math.floor(minPerKm);
  const sec = Math.round((minPerKm - min) * 60);
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
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
