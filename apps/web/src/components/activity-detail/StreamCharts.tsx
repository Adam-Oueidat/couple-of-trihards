"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { axisStyle, formatPaceValue, tooltipStyle, type ChartPoint } from "./format";

interface Props {
  points: ChartPoint[];
  isRide: boolean;
}

/**
 * Heart rate, pace/speed and elevation over distance. Which charts appear is
 * derived from the points rather than passed in as three more booleans — the
 * caller would only be computing them from this same array.
 */
export function StreamCharts({ points, isRide }: Props) {
  const hasHr = points.some((p) => p.hr !== undefined);
  const hasPace = points.some((p) => p.pace !== undefined);
  const hasAlt = points.some((p) => p.alt !== undefined);

  return (
    <>
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
    </>
  );
}
