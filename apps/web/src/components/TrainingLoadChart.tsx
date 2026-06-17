"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { TrainingLoadPoint } from "@trihards/core";

interface Props {
  data: TrainingLoadPoint[];
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function CustomTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 text-sm shadow-xl">
      <p className="text-gray-400 mb-2 font-medium">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span style={{ color: p.color }}>■</span>
          <span className="text-gray-300">{p.name}:</span>
          <span className="text-white font-semibold">{p.value}</span>
        </div>
      ))}
    </div>
  );
}

// Show every ~7th label to avoid crowding
function tickFormatter(value: string, index: number): string {
  return index % 7 === 0 ? formatDate(value) : "";
}

export function TrainingLoadChart({ data }: Props) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 0, right: 0, left: -10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={tickFormatter}
          tick={{ fill: "#9ca3af", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} />
        <Tooltip content={<CustomTooltip />} />
        <Legend
          wrapperStyle={{ paddingTop: "12px", fontSize: "12px" }}
          formatter={(value) => <span style={{ color: "#d1d5db" }}>{value}</span>}
        />
        <ReferenceLine y={0} stroke="#4b5563" strokeDasharray="4 2" />
        <Line type="monotone" dataKey="ctl" name="CTL (Fitness)" stroke="#f97316" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="atl" name="ATL (Fatigue)" stroke="#f43f5e" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="tsb" name="TSB (Form)" stroke="#a78bfa" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
      </LineChart>
    </ResponsiveContainer>
  );
}
