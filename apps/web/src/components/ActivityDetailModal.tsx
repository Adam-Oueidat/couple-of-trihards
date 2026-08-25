"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { StravaActivity } from "@trihards/core";
import { getDiscipline, formatDuration, formatPace, activityDay } from "@trihards/core";

// Built once at module scope rather than per render: constructing an
// Intl formatter is the expensive part, and these options never vary.
// The locale stays pinned to en-US, so this is not a behaviour change.
const DETAIL_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
});

interface Props {
  activity: StravaActivity;
  onClose: () => void;
}

import {
  buildChartPoints,
  formatTime,
  type DetailResponse,
} from "./activity-detail/format";
import { AnalysisPanel } from "./activity-detail/AnalysisPanel";
import { SummaryStats } from "./activity-detail/SummaryStats";
import { StreamCharts } from "./activity-detail/StreamCharts";
import { LapsSection } from "./activity-detail/LapsSection";
import { SplitsSection } from "./activity-detail/SplitsSection";


export function ActivityDetailModal({ activity, onClose }: Props) {
  const { data, error: loadError } = useSWR<DetailResponse>(
    `/api/activities/${activity.id}`,
    fetcher,
    { revalidateOnFocus: false },
  );
  const error = loadError ? "Could not load activity details." : null;
  // A saved analysis arrives with the detail payload; a streaming one replaces
  // it the moment runAnalysis starts. Deriving rather than seeding state in an
  // effect keeps the streaming value winning without an ordering dance.
  const [streamedAnalysis, setStreamedAnalysis] = useState<string | null>(null);
  const analysis = streamedAnalysis ?? data?.analysis?.text ?? null;
  const [analyzing, setAnalyzing] = useState(false);

  async function runAnalysis() {
    if (analyzing) return;
    setAnalyzing(true);
    setStreamedAnalysis("");
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
        setStreamedAnalysis(text);
      }
    } catch {
      setStreamedAnalysis("Analysis failed. Check that your Anthropic API key is configured, then try again.");
    } finally {
      setAnalyzing(false);
    }
  }
  const discipline = getDiscipline(activity);
  const isRide = discipline === "ride";


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
              {DETAIL_DATE_FMT.format(activityDay(activity.start_date_local))}
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

          <SummaryStats stats={stats} />

          <AnalysisPanel
            analysis={analysis}
            analyzing={analyzing}
            ready={Boolean(data)}
            onRun={runAnalysis}
          />

          <StreamCharts points={points} isRide={isRide} />







          {hasLaps && (
            <LapsSection laps={laps} discipline={discipline} isRide={isRide} />
          )}

          {detail?.splits_metric && detail.splits_metric.length > 1 && (
            <SplitsSection splits={detail.splits_metric} />
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
