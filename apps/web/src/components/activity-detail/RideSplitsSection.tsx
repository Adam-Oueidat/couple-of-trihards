"use client";

import type { RideSplit } from "@trihards/core";
import { formatTime } from "./format";

/**
 * A ride's splits in 5 km (or, past 100 km, 10 km) chunks. Km splits are a
 * run's unit; on a bike they pass in under two minutes each and a long ride
 * becomes a hundred rows. Columns appear only when some chunk has the data.
 */
export function RideSplitsSection({ splits }: { splits: RideSplit[] }) {
  const hasWatts = splits.some((s) => s.watts != null);
  const hasHr = splits.some((s) => s.heartrate != null);
  const hasCadence = splits.some((s) => s.cadence != null);
  const hasElev = splits.some((s) => s.elevationDiff != null);

  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
        Splits
      </h3>
      <div className="border border-gray-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-950/60 text-gray-500 text-xs">
              <th className="text-left px-3 py-2 font-medium">KM</th>
              <th className="text-left px-3 py-2 font-medium">Time</th>
              <th className="text-left px-3 py-2 font-medium">Speed</th>
              {hasWatts && <th className="text-left px-3 py-2 font-medium">Power</th>}
              {hasHr && <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">HR</th>}
              {hasCadence && (
                <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">rpm</th>
              )}
              {hasElev && (
                <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">Elev</th>
              )}
            </tr>
          </thead>
          <tbody>
            {splits.map((s) => (
              <tr key={s.fromKm} className="border-t border-gray-800 text-gray-300">
                <td className="px-3 py-1.5">
                  {s.fromKm}–{s.toKm}
                </td>
                <td className="px-3 py-1.5">{formatTime(s.movingTime)}</td>
                <td className="px-3 py-1.5">
                  {s.speed > 0 ? `${(s.speed * 3.6).toFixed(1)} km/h` : "-"}
                </td>
                {hasWatts && (
                  <td className="px-3 py-1.5">{s.watts != null ? `${s.watts} W` : "-"}</td>
                )}
                {hasHr && (
                  <td className="px-3 py-1.5 hidden sm:table-cell">
                    {s.heartrate != null ? `${s.heartrate} bpm` : "-"}
                  </td>
                )}
                {hasCadence && (
                  <td className="px-3 py-1.5 hidden sm:table-cell">{s.cadence ?? "-"}</td>
                )}
                {hasElev && (
                  <td className="px-3 py-1.5 hidden sm:table-cell">
                    {s.elevationDiff != null
                      ? `${s.elevationDiff > 0 ? "+" : ""}${s.elevationDiff} m`
                      : "-"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
