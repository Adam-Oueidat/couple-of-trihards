"use client";

import { useState } from "react";
import { StravaActivity } from "@trihards/core";
import { getDiscipline, formatDuration, formatPace, activityDay } from "@trihards/core";
import { ActivityDetailModal } from "./ActivityDetailModal";
import { DisciplineGlyph } from "./DisciplineGlyph";

interface Props {
  activities: StravaActivity[];
  sortable?: boolean;
}

type SortKey = "date" | "distance" | "duration";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "date", label: "Date" },
  { key: "distance", label: "Distance" },
  { key: "duration", label: "Duration" },
];

function sortValue(act: StravaActivity, key: SortKey): number {
  if (key === "distance") return act.distance;
  if (key === "duration") return act.moving_time;
  return new Date(act.start_date).getTime();
}

const DISCIPLINE_CONFIG = {
  run: {
    label: "Run",
    color: "text-green-400",
    bg: "bg-green-950/50 border-green-900",
    badge: "bg-green-500/15 text-green-400 border-green-500/30",
  },
  ride: {
    label: "Ride",
    color: "text-blue-400",
    bg: "bg-blue-950/50 border-blue-900",
    badge: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  },
  swim: {
    label: "Swim",
    color: "text-cyan-400",
    bg: "bg-cyan-950/50 border-cyan-900",
    badge: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  },
  other: {
    label: "Other",
    color: "text-gray-400",
    bg: "bg-gray-800/50 border-gray-700",
    badge: "bg-gray-500/15 text-gray-400 border-gray-500/30",
  },
};

function formatDistance(activity: StravaActivity): string {
  const d = getDiscipline(activity);
  if (d === "swim") return `${activity.distance.toFixed(0)} m`;
  return `${(activity.distance / 1000).toFixed(2)} km`;
}

function formatDate(dateStr: string): string {
  return activityDay(dateStr).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function ActivityList({ activities, sortable = false }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [descending, setDescending] = useState(true);
  const [selected, setSelected] = useState<StravaActivity | null>(null);

  if (activities.length === 0) {
    return <p className="text-gray-500 text-center py-8">No activities found.</p>;
  }

  const sorted = sortable
    ? activities.toSorted((a, b) => {
        const diff = sortValue(a, sortKey) - sortValue(b, sortKey);
        return descending ? -diff : diff;
      })
    : activities;

  return (
    <div>
      {sortable && (
        <div className="flex items-center justify-end gap-2 mb-3">
          <span className="text-gray-500 text-xs">Sort by</span>
          <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
            {SORT_OPTIONS.map((opt) => (
              <button
                type="button"
                key={opt.key}
                onClick={() => setSortKey(opt.key)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  sortKey === opt.key
                    ? "bg-orange-500 text-white"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setDescending((d) => !d)}
            title={descending ? "Descending" : "Ascending"}
            className="px-2.5 py-1.5 rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 text-xs font-medium transition-colors cursor-pointer"
          >
            {descending ? "↓" : "↑"}
          </button>
        </div>
      )}

      <div className="space-y-2">
        {sorted.map((act) => {
        const discipline = getDiscipline(act);
        const cfg = DISCIPLINE_CONFIG[discipline];
        return (
          <div
            key={act.id}
            onClick={() => setSelected(act)}
            className={`flex items-center gap-4 p-3 rounded-lg border ${cfg.bg} cursor-pointer hover:brightness-125 transition-[filter]`}
          >
            <span
              className={`flex-shrink-0 inline-flex items-center justify-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-full border ${cfg.badge}`}
            >
              <DisciplineGlyph discipline={discipline} size={14} />
              {cfg.label}
            </span>

            <div className="flex-1 min-w-0">
              <p className="text-white font-medium text-sm truncate">{act.name}</p>
              <p className="text-gray-500 text-xs">{formatDate(act.start_date_local)}</p>
            </div>

            <div className="flex items-center gap-6 text-sm flex-shrink-0">
              <div className="text-right">
                <p className={`font-bold ${cfg.color}`}>{formatDistance(act)}</p>
                <p className="text-gray-500 text-xs">distance</p>
              </div>
              <div className="text-right hidden sm:block">
                <p className="text-white font-medium">
                  {formatDuration(act.moving_time / 60)}
                </p>
                <p className="text-gray-500 text-xs">time</p>
              </div>
              <div className="text-right hidden md:block">
                <p className="text-gray-300">{formatPace(act)}</p>
                <p className="text-gray-500 text-xs">pace</p>
              </div>
              {act.average_heartrate && (
                <div className="text-right hidden lg:block">
                  <p className="text-red-400">{act.average_heartrate.toFixed(0)} bpm</p>
                  <p className="text-gray-500 text-xs">avg HR</p>
                </div>
              )}
            </div>
          </div>
        );
        })}
      </div>

      {selected && (
        <ActivityDetailModal
          activity={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
