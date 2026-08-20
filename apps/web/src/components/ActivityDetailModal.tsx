"use client";

import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { DetailedActivity, StravaActivity, StreamSet } from "@trihards/core";
import { getDiscipline, formatDuration, formatPace, activityDay } from "@trihards/core";

interface Props {
  activity: StravaActivity;
  onClose: () => void;
}

interface DetailResponse {
  activity: DetailedActivity;
  streams: StreamSet | null;
  analysis: { text: string; createdAt: string } | null;
}

interface ChartPoint {
  km: number;
  hr?: number;
  pace?: number; // min/km for runs, km/h for rides
  alt?: number;
}

interface LapPoint {
  lap: string;
  speed: number; // m/s — drives bar height so faster laps read taller
  seconds: number; // moving time — drives bar width so longer laps read wider
  pace: string; // discipline-aware label (min/km, /100m, or km/h) for the tooltip
  dist: string;
  time: string;
  hr?: number;
  work: boolean; // at/above the median lap speed — the hard reps
}

const MAX_POINTS = 300;

function buildChartPoints(streams: StreamSet, isRide: boolean): ChartPoint[] {
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

function formatPaceValue(minPerKm: number): string {
  const min = Math.floor(minPerKm);
  const sec = Math.round((minPerKm - min) * 60);
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Discipline-aware pace/speed for a recorded lap. Swims read per-100m, rides
// read as speed, everything else as min/km.
function formatSplitPace(
  averageSpeed: number,
  discipline: ReturnType<typeof getDiscipline>,
): string {
  if (averageSpeed <= 0) return "-";
  if (discipline === "swim") return `${formatTime(Math.round(100 / averageSpeed))}/100m`;
  if (discipline === "ride") return `${(averageSpeed * 3.6).toFixed(1)} km/h`;
  return `${formatPaceValue(1000 / averageSpeed / 60)}/km`;
}

function formatLapDistance(
  meters: number,
  discipline: ReturnType<typeof getDiscipline>,
): string {
  return discipline === "swim"
    ? `${Math.round(meters)} m`
    : `${(meters / 1000).toFixed(2)} km`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildLapPoints(
  laps: NonNullable<DetailedActivity["laps"]>,
  discipline: ReturnType<typeof getDiscipline>,
): LapPoint[] {
  const medianSpeed = median(laps.map((l) => l.average_speed));
  return laps.map((l) => ({
    lap: `${l.lap_index}`,
    speed: l.average_speed,
    seconds: l.moving_time,
    pace: formatSplitPace(l.average_speed, discipline),
    dist: formatLapDistance(l.distance, discipline),
    time: formatTime(l.moving_time),
    hr: l.average_heartrate,
    work: l.average_speed >= medianSpeed,
  }));
}

// A proportional lap timeline: each lap is a bar whose WIDTH is its duration
// and whose HEIGHT is its speed. So a short fast rep reads narrow-and-tall, a
// long recovery jog wide-and-short, and a walk break wide-and-flat — the shape
// of the session is legible at a glance. Rendered as raw SVG because Recharts'
// categorical bars are always equal width.
function LapChart({
  laps,
  discipline,
}: {
  laps: NonNullable<DetailedActivity["laps"]>;
  discipline: ReturnType<typeof getDiscipline>;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const points = buildLapPoints(laps, discipline);
  const totalTime = points.reduce((s, p) => s + p.seconds, 0) || 1;
  const maxSpeed = Math.max(...points.map((p) => p.speed), 0.1);

  const VW = 1000; // viewBox width units (scaled to container by the browser)
  const H = 160;
  const GAP = 2; // horizontal inset per side, in viewBox units
  const MIN_H = 4; // keep even a slow walk visible

  const fracs = points.map((p) => p.seconds / totalTime);
  const starts = fracs.map((_, i) => fracs.slice(0, i).reduce((a, b) => a + b, 0));
  const bars = points.map((p, i) => ({
    i,
    x: starts[i] * VW,
    w: fracs[i] * VW,
    bh: Math.max(MIN_H, (p.speed / maxSpeed) * (H - 8)),
    p,
  }));

  const active = hover !== null ? bars[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VW} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
      >
        {bars.map((b) => (
          <rect
            key={b.i}
            x={b.x + GAP}
            y={H - b.bh}
            width={Math.max(0, b.w - GAP * 2)}
            height={b.bh}
            fill={b.p.work ? "#f97316" : "#4b5563"}
            opacity={hover === null || hover === b.i ? 1 : 0.45}
            onMouseEnter={() => setHover(b.i)}
          />
        ))}
      </svg>
      {active && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg px-3 py-2 text-gray-200"
          style={{
            ...tooltipStyle,
            left: `${((active.x + active.w / 2) / VW) * 100}%`,
            top: H - active.bh - 8,
          }}
        >
          <p className="font-semibold text-white">Lap {active.p.lap}</p>
          <p>{active.p.dist} · {active.p.time}</p>
          <p>{active.p.pace}</p>
          {active.p.hr ? <p>{active.p.hr.toFixed(0)} bpm</p> : null}
        </div>
      )}
      <p className="mt-1.5 text-gray-500 text-xs">
        Bar width = duration · height = speed
      </p>
    </div>
  );
}

const axisStyle = { fill: "#9ca3af", fontSize: 11 };
const tooltipStyle = {
  backgroundColor: "#1f2937",
  border: "1px solid #374151",
  borderRadius: "8px",
  fontSize: "13px",
};

export function ActivityDetailModal({ activity, onClose }: Props) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [lapsOpen, setLapsOpen] = useState(false);

  async function runAnalysis() {
    if (analyzing) return;
    setAnalyzing(true);
    setAnalysis("");
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activityId: activity.id }),
      });
      if (!res.ok || !res.body) throw new Error(`Failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        setAnalysis(text);
      }
    } catch {
      setAnalysis("Analysis failed. Check that your Anthropic API key is configured, then try again.");
    } finally {
      setAnalyzing(false);
    }
  }
  const discipline = getDiscipline(activity);
  const isRide = discipline === "ride";

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/activities/${activity.id}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed (${res.status})`);
        return res.json();
      })
      .then((d: DetailResponse) => {
        if (cancelled) return;
        setData(d);
        if (d.analysis) setAnalysis(d.analysis.text);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load activity details.");
      });
    return () => {
      cancelled = true;
    };
  }, [activity.id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const detail = data?.activity;
  const points = data?.streams ? buildChartPoints(data.streams, isRide) : [];
  const hasHr = points.some((p) => p.hr !== undefined);
  const hasPace = points.some((p) => p.pace !== undefined);
  const hasAlt = points.some((p) => p.alt !== undefined);

  const laps = detail?.laps ?? [];
  const hasLaps = laps.length > 1;

  const stats: { label: string; value: string }[] = [
    {
      label: "Distance",
      value:
        discipline === "swim"
          ? `${activity.distance.toFixed(0)} m`
          : `${(activity.distance / 1000).toFixed(2)} km`,
    },
    { label: "Moving time", value: formatDuration(activity.moving_time / 60) },
    { label: "Pace", value: formatPace(activity) },
    ...(detail?.calories
      ? [{ label: "Calories", value: `${Math.round(detail.calories)}` }]
      : []),
    ...(activity.total_elevation_gain > 0
      ? [{ label: "Elevation", value: `${Math.round(activity.total_elevation_gain)} m` }]
      : []),
    ...(activity.average_heartrate
      ? [
          {
            label: "Avg / max HR",
            value: `${activity.average_heartrate.toFixed(0)} / ${activity.max_heartrate?.toFixed(0) ?? "-"} bpm`,
          },
        ]
      : []),
    ...(detail?.gear
      ? [{ label: "Gear", value: detail.gear.name }]
      : []),
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close activity details"
        onClick={onClose}
        className="absolute inset-0 bg-black/70 cursor-default"
      />
      <div className="relative bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-3xl max-h-[85vh] overflow-y-auto">
        <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-6 py-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-white font-bold text-lg leading-tight">
              {activity.name}
            </h2>
            <p className="text-gray-500 text-xs mt-0.5">
              {activityDay(activity.start_date_local).toLocaleDateString("en-US", {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
              {detail?.device_name ? ` · ${detail.device_name}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white text-sm px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-500 transition-colors cursor-pointer flex-shrink-0"
          >
            Close
          </button>
        </div>

        <div className="p-6 space-y-6">
          {error && <p className="text-red-400 text-sm">{error}</p>}
          {!data && !error && (
            <p className="text-gray-500 text-sm animate-pulse">Loading details...</p>
          )}

          {detail?.description && (
            <p className="text-gray-300 text-sm whitespace-pre-wrap">
              {detail.description}
            </p>
          )}

          <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
            {stats.map((s) => (
              <div key={s.label} className="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
                <p className="text-gray-500 text-xs">{s.label}</p>
                <p className="text-white text-sm font-semibold mt-0.5">{s.value}</p>
              </div>
            ))}
          </div>

          <div>
            {analysis === null ? (
              <button
                type="button"
                onClick={runAnalysis}
                disabled={!data}
                className="w-full py-2.5 bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors cursor-pointer"
              >
                Coach Analysis
              </button>
            ) : (
              <div className="border border-orange-500/30 bg-orange-500/5 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold text-orange-400 uppercase tracking-wider">
                    Coach Analysis
                  </h3>
                  {!analyzing && (
                    <button
                      type="button"
                      onClick={runAnalysis}
                      className="text-gray-500 hover:text-white text-xs transition-colors cursor-pointer"
                    >
                      Re-run
                    </button>
                  )}
                </div>
                <div className="text-gray-200 text-sm whitespace-pre-wrap leading-relaxed">
                  {analysis || <span className="text-gray-500 animate-pulse">Analyzing your session...</span>}
                </div>
              </div>
            )}
          </div>

          {hasHr && (
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                Heart Rate
              </h3>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={points} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                  <XAxis dataKey="km" tick={axisStyle} axisLine={false} tickLine={false} unit="km" />
                  <YAxis domain={["dataMin - 5", "dataMax + 5"]} tick={axisStyle} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    labelFormatter={(km) => `${km} km`}
                    formatter={(value) => [`${value} bpm`, "HR"]}
                  />
                  <Line type="monotone" dataKey="hr" stroke="#f43f5e" strokeWidth={1.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {hasPace && (
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                {isRide ? "Speed" : "Pace"}
              </h3>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={points} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                  <XAxis dataKey="km" tick={axisStyle} axisLine={false} tickLine={false} unit="km" />
                  <YAxis
                    reversed={!isRide}
                    domain={["auto", "auto"]}
                    tick={axisStyle}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) => (isRide ? `${v}` : formatPaceValue(v))}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    labelFormatter={(km) => `${km} km`}
                    formatter={(value) => [
                      isRide ? `${value} km/h` : `${formatPaceValue(value as number)}/km`,
                      isRide ? "Speed" : "Pace",
                    ]}
                  />
                  <Line type="monotone" dataKey="pace" stroke="#60a5fa" strokeWidth={1.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {hasAlt && (
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                Elevation
              </h3>
              <ResponsiveContainer width="100%" height={120}>
                <AreaChart data={points} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                  <XAxis dataKey="km" tick={axisStyle} axisLine={false} tickLine={false} unit="km" />
                  <YAxis domain={["dataMin - 10", "dataMax + 10"]} tick={axisStyle} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    labelFormatter={(km) => `${km} km`}
                    formatter={(value) => [`${Math.round(value as number)} m`, "Altitude"]}
                  />
                  <Area type="monotone" dataKey="alt" stroke="#9ca3af" fill="#9ca3af33" strokeWidth={1} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {hasLaps && (
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                Laps
              </h3>
              <LapChart laps={laps} discipline={discipline} />

              <button
                type="button"
                onClick={() => setLapsOpen((o) => !o)}
                aria-expanded={lapsOpen}
                className="mt-2 flex items-center gap-1.5 text-gray-400 hover:text-white text-xs transition-colors cursor-pointer"
              >
                <span
                  className={`inline-block transition-transform ${lapsOpen ? "rotate-90" : ""}`}
                  aria-hidden
                >
                  ›
                </span>
                {lapsOpen ? "Hide" : "Show"} lap details
              </button>

              {lapsOpen && (
                <div className="mt-2 border border-gray-800 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-950/60 text-gray-500 text-xs">
                        <th className="text-left px-3 py-2 font-medium">Lap</th>
                        <th className="text-left px-3 py-2 font-medium">Dist</th>
                        <th className="text-left px-3 py-2 font-medium">Time</th>
                        <th className="text-left px-3 py-2 font-medium">
                          {isRide ? "Speed" : "Pace"}
                        </th>
                        <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">HR</th>
                        {!isRide && discipline !== "swim" && (
                          <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">
                            Elev
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {laps.map((lap) => (
                        <tr key={lap.id} className="border-t border-gray-800 text-gray-300">
                          <td className="px-3 py-1.5">{lap.lap_index}</td>
                          <td className="px-3 py-1.5">
                            {formatLapDistance(lap.distance, discipline)}
                          </td>
                          <td className="px-3 py-1.5">{formatTime(lap.moving_time)}</td>
                          <td className="px-3 py-1.5">
                            {formatSplitPace(lap.average_speed, discipline)}
                          </td>
                          <td className="px-3 py-1.5 hidden sm:table-cell">
                            {lap.average_heartrate ? `${lap.average_heartrate.toFixed(0)} bpm` : "-"}
                          </td>
                          {!isRide && discipline !== "swim" && (
                            <td className="px-3 py-1.5 hidden sm:table-cell">
                              {lap.total_elevation_gain
                                ? `${Math.round(lap.total_elevation_gain)} m`
                                : "-"}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {detail?.splits_metric && detail.splits_metric.length > 1 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                Splits
              </h3>
              <div className="border border-gray-800 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-950/60 text-gray-500 text-xs">
                      <th className="text-left px-3 py-2 font-medium">KM</th>
                      <th className="text-left px-3 py-2 font-medium">Pace</th>
                      <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">HR</th>
                      <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">Elev</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.splits_metric.map((s) => (
                      <tr key={s.split} className="border-t border-gray-800 text-gray-300">
                        <td className="px-3 py-1.5">
                          {s.distance < 950 ? (s.distance / 1000).toFixed(1) : s.split}
                        </td>
                        <td className="px-3 py-1.5">
                          {s.average_speed > 0
                            ? `${formatPaceValue(1000 / s.average_speed / 60)}/km`
                            : "-"}
                        </td>
                        <td className="px-3 py-1.5 hidden sm:table-cell">
                          {s.average_heartrate ? `${s.average_heartrate.toFixed(0)} bpm` : "-"}
                        </td>
                        <td className="px-3 py-1.5 hidden sm:table-cell">
                          {s.elevation_difference > 0 ? "+" : ""}
                          {Math.round(s.elevation_difference)} m
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {detail?.best_efforts && detail.best_efforts.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                Best Efforts
              </h3>
              <div className="flex flex-wrap gap-2">
                {detail.best_efforts.map((e) => (
                  <span
                    key={e.name}
                    className="px-3 py-1.5 rounded-full border border-gray-700 bg-gray-950/60 text-xs"
                  >
                    <span className="text-gray-400">{e.name}</span>{" "}
                    <span className="text-white font-semibold">{formatTime(e.moving_time)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
