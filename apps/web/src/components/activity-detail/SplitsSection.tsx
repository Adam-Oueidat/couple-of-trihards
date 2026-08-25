"use client";

import type { DetailedActivity } from "@trihards/core";
import { formatPaceValue } from "./format";

interface Props {
  splits: NonNullable<DetailedActivity["splits_metric"]>;
}

/** Per-kilometre splits table. */
export function SplitsSection({ splits }: Props) {
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
                <th className="text-left px-3 py-2 font-medium">Pace</th>
                <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">HR</th>
                <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">Elev</th>
              </tr>
            </thead>
            <tbody>
              {splits.map((s) => (
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
  );
}
