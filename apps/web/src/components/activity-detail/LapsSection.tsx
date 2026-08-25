"use client";

import { useState } from "react";
import { getDiscipline, type DetailedActivity } from "@trihards/core";
import { formatLapDistance, formatSplitPace, formatTime } from "./format";
import { LapChart } from "./LapChart";

interface Props {
  laps: NonNullable<DetailedActivity["laps"]>;
  discipline: ReturnType<typeof getDiscipline>;
  isRide: boolean;
}

/**
 * Lap chart plus the collapsible per-lap table. `lapsOpen` lives here because
 * nothing outside this section reads it.
 */
export function LapsSection({ laps, discipline, isRide }: Props) {
  const [lapsOpen, setLapsOpen] = useState(false);

  return (
      <div>
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
          Laps
        </h3>
        <LapChart laps={laps} discipline={discipline} />

        <button
          type="button"
          onClick={() => setLapsOpen((o) => !o)}
          aria-expanded={lapsOpen}
          className="mt-2 flex items-center gap-1.5 text-gray-400 hover:text-white text-xs transition-colors cursor-pointer"
        >
          <span
            className={`inline-block transition-transform ${lapsOpen ? "rotate-90" : ""}`}
            aria-hidden
          >
            ›
          </span>
          {lapsOpen ? "Hide" : "Show"} lap details
        </button>

        {lapsOpen && (
          <div className="mt-2 border border-gray-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-950/60 text-gray-500 text-xs">
                  <th className="text-left px-3 py-2 font-medium">Lap</th>
                  <th className="text-left px-3 py-2 font-medium">Dist</th>
                  <th className="text-left px-3 py-2 font-medium">Time</th>
                  <th className="text-left px-3 py-2 font-medium">
                    {isRide ? "Speed" : "Pace"}
                  </th>
                  <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">HR</th>
                  {!isRide && discipline !== "swim" && (
                    <th className="text-left px-3 py-2 font-medium hidden sm:table-cell">
                      Elev
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {laps.map((lap) => (
                  <tr key={lap.id} className="border-t border-gray-800 text-gray-300">
                    <td className="px-3 py-1.5">{lap.lap_index}</td>
                    <td className="px-3 py-1.5">
                      {formatLapDistance(lap.distance, discipline)}
                    </td>
                    <td className="px-3 py-1.5">{formatTime(lap.moving_time)}</td>
                    <td className="px-3 py-1.5">
                      {formatSplitPace(lap.average_speed, discipline)}
                    </td>
                    <td className="px-3 py-1.5 hidden sm:table-cell">
                      {lap.average_heartrate ? `${lap.average_heartrate.toFixed(0)} bpm` : "-"}
                    </td>
                    {!isRide && discipline !== "swim" && (
                      <td className="px-3 py-1.5 hidden sm:table-cell">
                        {lap.total_elevation_gain
                          ? `${Math.round(lap.total_elevation_gain)} m`
                          : "-"}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
  );
}
