"use client";

import { formatDuration } from "@trihards/core";

/**
 * The five-zone distribution, as one bar plus a legend.
 *
 * Takes plain counts and a unit rather than a zone object, because the same
 * component renders two genuinely different claims: seconds actually spent in
 * each zone (from heart-rate streams) and a count of sessions bucketed by their
 * average heart rate (all summary data can support). The caller supplies the
 * title and caption that say which, and the two must never be confused — an
 * interval session averages into Z3 between its Z5 reps and its Z1 recoveries,
 * so the session-average view of a polarised week looks like a grey one.
 */

const ZONE_COLORS = [
  "var(--zone-1)",
  "var(--zone-2)",
  "var(--zone-3)",
  "var(--zone-4)",
  "var(--zone-5)",
];

/** Matches the pill treatment used by the fitness profile card. */
const ZONE_PILL = [
  "bg-[var(--zone-1)]/15 text-[var(--zone-1)] border-[var(--zone-1)]/35",
  "bg-[var(--zone-2)]/15 text-[var(--zone-2)] border-[var(--zone-2)]/35",
  "bg-[var(--zone-3)]/15 text-[var(--zone-3)] border-[var(--zone-3)]/35",
  "bg-[var(--zone-4)]/15 text-[var(--zone-4)] border-[var(--zone-4)]/35",
  "bg-[var(--zone-5)]/15 text-[var(--zone-5)] border-[var(--zone-5)]/35",
];

const ZONE_NAMES = ["Recovery", "Endurance", "Tempo", "Threshold", "VO2 max"];

interface Props {
  /** Five values, in zone order. */
  values: number[];
  /** How to read a value: seconds of training, or a count of sessions. */
  unit: "seconds" | "sessions";
}

export function ZoneBar({ values, unit }: Props) {
  const total = values.reduce((a, b) => a + b, 0);

  if (total === 0) {
    return (
      <p className="font-data text-[11px] text-gray-600">
        No heart-rate data in this window.
      </p>
    );
  }

  const format = (v: number) =>
    unit === "seconds"
      ? formatDuration(Math.round(v / 60))
      : `${v} session${v === 1 ? "" : "s"}`;

  return (
    <div>
      <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full">
        {values.map((v, i) =>
          v === 0 ? null : (
            <div
              key={i}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${(v / total) * 100}%`, background: ZONE_COLORS[i] }}
              title={`Z${i + 1} ${ZONE_NAMES[i]}: ${format(v)}`}
            />
          ),
        )}
      </div>

      {/* The zone number is text inside the pill, so hue is never the only
          thing carrying which zone a figure belongs to. */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        {values.map((v, i) => (
          <span key={i} className="inline-flex items-baseline gap-1.5 font-data text-[11px]">
            <span
              className={`rounded-full border px-1.5 py-px text-[10px] font-semibold ${ZONE_PILL[i]}`}
            >
              Z{i + 1}
            </span>
            <span className="text-gray-400">{format(v)}</span>
            <span className="text-gray-600">{Math.round((v / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
