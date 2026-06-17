"use client";

import { Discipline, WeeklyVolume } from "@trihards/core";
import { TrainingLoadPoint, formatDuration } from "@trihards/core";
import { DisciplineGlyph } from "./DisciplineGlyph";

interface Props {
  currentWeek?: WeeklyVolume;
  trainingLoad: TrainingLoadPoint[];
}

export function SummaryCards({ currentWeek, trainingLoad }: Props) {
  const latest = trainingLoad[trainingLoad.length - 1];

  const cards: Array<{
    label: string;
    value: string;
    sub: string;
    color: string;
    discipline?: Discipline;
  }> = [
    {
      label: "Run this week",
      value: currentWeek ? `${currentWeek.run.toFixed(1)} km` : "—",
      sub: currentWeek ? formatDuration(currentWeek.runTime) : "",
      color: "text-green-400",
      discipline: "run",
    },
    {
      label: "Ride this week",
      value: currentWeek ? `${currentWeek.ride.toFixed(1)} km` : "—",
      sub: currentWeek ? formatDuration(currentWeek.rideTime) : "",
      color: "text-blue-400",
      discipline: "ride",
    },
    {
      label: "Swim this week",
      value: currentWeek ? `${(currentWeek.swim / 1000).toFixed(1)} km` : "—",
      sub: currentWeek ? formatDuration(currentWeek.swimTime) : "",
      color: "text-cyan-400",
      discipline: "swim",
    },
    {
      label: "Fitness (CTL)",
      value: latest ? String(latest.ctl.toFixed(0)) : "—",
      sub: latest
        ? `ATL ${latest.atl.toFixed(0)} · TSB ${latest.tsb > 0 ? "+" : ""}${latest.tsb.toFixed(0)}`
        : "",
      color: latest && latest.tsb > 0 ? "text-green-400" : "text-orange-400",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className="bg-gray-900 border border-gray-800 rounded-xl p-4"
        >
          <div className="flex items-center gap-1.5 mb-2 text-gray-400 text-xs font-medium">
            {card.discipline && (
              <span className={card.color}>
                <DisciplineGlyph discipline={card.discipline} size={14} />
              </span>
            )}
            <span>{card.label}</span>
          </div>
          <p className={`text-2xl font-black ${card.color}`}>{card.value}</p>
          {card.sub && <p className="text-gray-500 text-xs mt-1">{card.sub}</p>}
        </div>
      ))}
    </div>
  );
}
