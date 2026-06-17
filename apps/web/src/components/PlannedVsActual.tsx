"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { StravaActivity } from "@trihards/core";
import {
  plan,
  plannedVsActualByWeek,
  matchSessions,
  daysUntilRace,
  SessionWithStatus,
} from "@trihards/core";
import type { PlanOverrideMap } from "@trihards/core";
import { getWeekStart } from "@trihards/core";

interface Props {
  activities: StravaActivity[];
}

const STATUS_STYLES: Record<SessionWithStatus["status"], { label: string; cls: string }> = {
  completed: { label: "Done", cls: "bg-green-500/15 text-green-400 border-green-500/30" },
  partial: { label: "Partial", cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
  missed: { label: "Missed", cls: "bg-red-500/15 text-red-400 border-red-500/30" },
  today: { label: "Today", cls: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  upcoming: { label: "Upcoming", cls: "bg-gray-500/15 text-gray-400 border-gray-500/30" },
};

function formatWeekLabel(weekStart: string): string {
  const d = new Date(weekStart);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatSessionDate(date: string): string {
  return new Date(date + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatWeekRange(weekStart: string): string {
  const start = new Date(weekStart + "T12:00:00");
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

export function PlannedVsActual({ activities }: Props) {
  const [overrides, setOverrides] = useState<PlanOverrideMap>({});

  useEffect(() => {
    fetch("/api/plan-overrides")
      .then((res) => (res.ok ? res.json() : {}))
      .then(setOverrides)
      .catch(() => {});
  }, []);

  const weeks = useMemo(
    () => plannedVsActualByWeek(activities, overrides),
    [activities, overrides]
  );
  const allSessions = useMemo(
    () => matchSessions(activities, overrides),
    [activities, overrides]
  );
  const days = daysUntilRace();

  const currentWeekStart = getWeekStart(new Date());
  const currentIdx = Math.max(
    0,
    weeks.findIndex((w) => w.weekStart === currentWeekStart)
  );

  const [selectedIdx, setSelectedIdx] = useState(currentIdx);
  const selected = weeks[selectedIdx];
  const planWeekNumber = selectedIdx + 1;
  const isCurrent = selected?.weekStart === currentWeekStart;

  const selectedSessions = useMemo(
    () =>
      selected
        ? allSessions.filter(
            (s) =>
              getWeekStart(new Date(s.date + "T12:00:00")) === selected.weekStart
          )
        : [],
    [allSessions, selected]
  );

  const chartData = weeks.map((w, i) => ({
    week: formatWeekLabel(w.weekStart),
    Planned: w.plannedKm,
    Actual: w.isFuture ? null : w.actualKm,
    isFuture: w.isFuture,
    isSelected: i === selectedIdx,
  }));

  return (
    <div className="space-y-6">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
            Plan: {plan.name}
          </h2>
          <span className="text-xs font-semibold px-3 py-1 rounded-full bg-orange-500/15 text-orange-400 border border-orange-500/30">
            Race in {days} days
          </span>
        </div>

        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chartData} margin={{ top: 0, right: 0, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
            <XAxis dataKey="week" tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} unit="km" />
            <Tooltip
              contentStyle={{
                backgroundColor: "#1f2937",
                border: "1px solid #374151",
                borderRadius: "8px",
                fontSize: "13px",
              }}
              labelStyle={{ color: "#9ca3af" }}
              cursor={false}
            />
            <Legend
              wrapperStyle={{ paddingTop: "12px", fontSize: "12px" }}
              formatter={(value) => <span style={{ color: "#d1d5db" }}>{value}</span>}
            />
            <Bar
              dataKey="Planned"
              radius={[3, 3, 0, 0]}
              onClick={(_, i) => setSelectedIdx(i)}
              style={{ cursor: "pointer" }}
            >
              {chartData.map((d, i) => (
                <Cell
                  key={i}
                  fill={
                    d.isSelected
                      ? "#f97316"
                      : d.isFuture
                        ? "#9ca3af55"
                        : "#9ca3af"
                  }
                />
              ))}
            </Bar>
            <Bar
              dataKey="Actual"
              fill="#4ade80"
              radius={[3, 3, 0, 0]}
              onClick={(_, i) => setSelectedIdx(i)}
              style={{ cursor: "pointer" }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
              Week {planWeekNumber} of {weeks.length}
              {isCurrent && (
                <span className="ml-2 text-orange-400 normal-case tracking-normal">
                  · this week
                </span>
              )}
            </h2>
            {selected && (
              <p className="text-gray-500 text-xs mt-0.5">
                {formatWeekRange(selected.weekStart)} ·{" "}
                {selected.plannedKm.toFixed(1)} km planned
                {!selected.isFuture && ` · ${selected.actualKm.toFixed(1)} km actual`}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelectedIdx((i) => Math.max(0, i - 1))}
              disabled={selectedIdx === 0}
              className="px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-500 disabled:opacity-30 disabled:cursor-not-allowed text-gray-300 text-sm transition-colors cursor-pointer"
            >
              ←
            </button>
            {!isCurrent && (
              <button
                onClick={() => setSelectedIdx(currentIdx)}
                className="px-3 py-1.5 rounded-lg border border-orange-500/40 hover:border-orange-500 text-orange-400 text-xs font-semibold transition-colors cursor-pointer"
              >
                Today
              </button>
            )}
            <button
              onClick={() =>
                setSelectedIdx((i) => Math.min(weeks.length - 1, i + 1))
              }
              disabled={selectedIdx === weeks.length - 1}
              className="px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-500 disabled:opacity-30 disabled:cursor-not-allowed text-gray-300 text-sm transition-colors cursor-pointer"
            >
              →
            </button>
          </div>
        </div>

        {selectedSessions.length === 0 ? (
          <p className="text-gray-500 text-sm">No planned sessions this week.</p>
        ) : (
          <div className="space-y-2">
            {selectedSessions.map((s) => {
              const style = STATUS_STYLES[s.status];
              return (
                <div
                  key={s.date}
                  className="flex items-center gap-4 p-3 rounded-lg border border-gray-800 bg-gray-950/50"
                >
                  <span
                    className={`flex-shrink-0 w-20 py-1 text-center text-xs font-semibold rounded-full border ${style.cls}`}
                  >
                    {style.label}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">{s.name}</p>
                    <p className="text-gray-500 text-xs">
                      {formatSessionDate(s.date)} · {s.type.replace("_", " ")}
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-white text-sm font-semibold">
                      {s.actualKm !== undefined ? `${s.actualKm} / ${s.km} km` : `${s.km} km`}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
