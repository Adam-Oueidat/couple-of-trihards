"use client";

import type { EfficiencyTrend } from "@trihards/core";

/**
 * Aerobic efficiency over the season, as one line.
 *
 * Hand-drawn SVG rather than recharts, for the same reason as the block strip:
 * this card deliberately stays out of the charts chunk, and a single trend line
 * needs none of what that library provides.
 *
 * Deliberately unaxed and direct-labelled at both ends. The absolute value of
 * speed-per-beat means nothing to anyone — 19.1 is not a number an athlete has
 * intuition for — so the chart's whole job is the direction and the size of the
 * move between two labelled endpoints. A y-axis would invite reading precision
 * into a figure that carries terrain, heat and strap placement in it.
 */

const H = 56;

function path(values: number[], close: boolean): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  // Pad both ends so a gently rising line neither flattens against the top
  // edge nor grazes the baseline.
  const lo = span === 0 ? min - 1 : min - span * 0.3;
  const hi = span === 0 ? min + 1 : max + span * 0.3;
  const y = (v: number) => 100 - ((v - lo) / (hi - lo)) * 100;
  const step = 100 / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(2)},${y(v).toFixed(2)}`);
  return close
    ? `M0,100 L${pts.join(" L")} L100,100 Z`
    : `M${pts.join(" L")}`;
}

export function EfficiencySpark({ trend }: { trend: EfficiencyTrend }) {
  const values = trend.weekly.map((w) => w.ef);

  if (values.length < 2) {
    return (
      <p className="font-data text-[11px] text-gray-600">
        Not enough easy runs with heart rate to plot a trend yet.
      </p>
    );
  }

  const rising = trend.late >= trend.early;

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <span className="font-display text-2xl leading-none tabular-nums text-gray-500">
          {trend.early.toFixed(1)}
        </span>
        <div className="relative h-[56px] flex-1" style={{ height: H }}>
          <svg
            className="h-full w-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            role="img"
            aria-label={`Aerobic efficiency ${trend.early.toFixed(1)} rising to ${trend.late.toFixed(1)} over ${trend.weekly.length} weeks`}
          >
            <path d={path(values, true)} fill="var(--accent)" fillOpacity={0.12} />
            <path
              d={path(values, false)}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
        <span
          className="font-display text-2xl leading-none tabular-nums"
          style={{ color: rising ? "var(--ok)" : "var(--warn)" }}
        >
          {trend.late.toFixed(1)}
        </span>
      </div>
      <div className="mt-1.5 flex justify-between font-data text-[10px] uppercase tracking-wider text-gray-600">
        <span>Earliest weeks</span>
        <span>{trend.weekly.length} weeks of easy running</span>
        <span>Now</span>
      </div>
    </div>
  );
}
