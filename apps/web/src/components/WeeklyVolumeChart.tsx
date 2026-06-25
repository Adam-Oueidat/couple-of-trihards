"use client";

import { useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { WeeklyVolume, type Discipline } from "@trihards/core";
import { DisciplineGlyph } from "./DisciplineGlyph";

interface Props {
  data: WeeklyVolume[];
}

// Colors come from the discipline CSS variables (defined in globals.css) so the
// chart always matches the badges, icons, and bars used elsewhere in both themes.
const DISCIPLINES = [
  { key: "Swim", color: "var(--swim)", glyph: "swim" },
  { key: "Ride", color: "var(--ride)", glyph: "ride" },
  { key: "Run", color: "var(--run)", glyph: "run" },
] as const satisfies ReadonlyArray<{
  key: string;
  color: string;
  glyph: Discipline;
}>;

type DisciplineKey = (typeof DISCIPLINES)[number]["key"];

const GLYPH_BY_KEY: Record<DisciplineKey, Discipline> = {
  Swim: "swim",
  Ride: "ride",
  Run: "run",
};

function formatWeekLabel(weekStart: string): string {
  const d = new Date(weekStart);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatHours(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

interface ChartDatum {
  week: string;
  Run: number;
  Ride: number;
  Swim: number;
  runKm: number;
  rideKm: number;
  swimM: number;
}

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{
    name: string;
    value: number;
    color: string;
    payload: ChartDatum;
  }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const datum = payload[0].payload;
  const distances: Record<string, string> = {
    Run: `${datum.runKm.toFixed(1)} km`,
    Ride: `${datum.rideKm.toFixed(1)} km`,
    Swim: `${(datum.swimM / 1000).toFixed(1)} km`,
  };
  const total = payload.reduce((sum, p) => sum + p.value, 0);
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm shadow-xl">
      <p className="text-gray-400 mb-2 font-medium">Week of {label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span style={{ color: p.color }} className="inline-flex">
            <DisciplineGlyph
              discipline={GLYPH_BY_KEY[p.name as DisciplineKey]}
              size={14}
            />
          </span>
          <span className="text-gray-300">{p.name}:</span>
          <span className="text-white font-semibold">
            {formatHours(p.value)}
          </span>
          <span className="text-gray-500">({distances[p.name]})</span>
        </div>
      ))}
      <p className="text-gray-400 mt-2 pt-2 border-t border-gray-700">
        Total:{" "}
        <span className="text-white font-semibold">{formatHours(total)}</span>
      </p>
    </div>
  );
}

export function WeeklyVolumeChart({ data }: Props) {
  const [enabled, setEnabled] = useState<Record<DisciplineKey, boolean>>({
    Swim: true,
    Ride: true,
    Run: true,
  });

  const toggle = (key: DisciplineKey) =>
    setEnabled((prev) => ({ ...prev, [key]: !prev[key] }));

  const chartData: ChartDatum[] = data.map((w) => ({
    week: formatWeekLabel(w.weekStart),
    Run: Math.round((w.runTime / 60) * 100) / 100,
    Ride: Math.round((w.rideTime / 60) * 100) / 100,
    Swim: Math.round((w.swimTime / 60) * 100) / 100,
    runKm: w.run,
    rideKm: w.ride,
    swimM: w.swim,
  }));

  const visible = DISCIPLINES.filter((d) => enabled[d.key]);
  const topKey = visible[visible.length - 1]?.key;

  return (
    <div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart
          data={chartData}
          margin={{ top: 0, right: 0, left: -10, bottom: 0 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="#374151"
            vertical={false}
          />
          <XAxis
            dataKey="week"
            tick={{ fill: "#9ca3af", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "#9ca3af", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            unit="h"
          />
          <Tooltip
            content={<CustomTooltip />}
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
          />
          {visible.map((d) => (
            <Bar
              key={d.key}
              dataKey={d.key}
              stackId="vol"
              fill={d.color}
              radius={d.key === topKey ? [3, 3, 0, 0] : undefined}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>

      <div className="flex justify-center gap-2 mt-3">
        {DISCIPLINES.map((d) => (
          <button
            type="button"
            key={d.key}
            onClick={() => toggle(d.key)}
            className={`px-3 py-1 rounded-full text-xs font-semibold border transition-all cursor-pointer inline-flex items-center gap-1.5 ${
              enabled[d.key]
                ? "border-transparent text-gray-900"
                : "border-gray-700 text-gray-500 bg-transparent"
            }`}
            style={enabled[d.key] ? { backgroundColor: d.color } : undefined}
          >
            <DisciplineGlyph discipline={d.glyph} size={12} />
            {d.key}
          </button>
        ))}
      </div>
    </div>
  );
}
