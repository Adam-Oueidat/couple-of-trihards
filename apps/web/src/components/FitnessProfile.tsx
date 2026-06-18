"use client";

import { useEffect, useState } from "react";
import {
  AthleteDetail,
  AthleteStats,
  AthleteZones,
} from "@trihards/core";
import type { PersonalBest } from "@/lib/personal-bests";
import { DisciplineGlyph } from "./DisciplineGlyph";
import type { Discipline } from "@trihards/core";
import { SectionLabel } from "./SectionLabel";

interface FitnessData {
  athlete: AthleteDetail | null;
  zones: AthleteZones | null;
  stats: AthleteStats | null;
  personalBests: PersonalBest[];
}

// Dedicated heart-rate zone ramp (see --zone-* in globals.css). Kept separate
// from the discipline colors so the Z1→Z5 scale reads as its own sequence and
// Z2 stays blue regardless of how ride/run/swim are themed.
const ZONE_COLORS = [
  "bg-[var(--zone-1)]/15 text-[var(--zone-1)] border-[var(--zone-1)]/35",
  "bg-[var(--zone-2)]/15 text-[var(--zone-2)] border-[var(--zone-2)]/35",
  "bg-[var(--zone-3)]/15 text-[var(--zone-3)] border-[var(--zone-3)]/35",
  "bg-[var(--zone-4)]/15 text-[var(--zone-4)] border-[var(--zone-4)]/35",
  "bg-[var(--zone-5)]/15 text-[var(--zone-5)] border-[var(--zone-5)]/35",
];

const ZONE_NAMES = ["Z1", "Z2", "Z3", "Z4", "Z5"];

function formatHours(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  return `${h}h`;
}

function formatKm(meters: number): string {
  return `${(meters / 1000).toFixed(0)}km`;
}

function formatPbTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function FitnessProfile({ refreshKey }: { refreshKey?: number }) {
  const [data, setData] = useState<FitnessData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/fitness")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((d) => {
        if (!cancelled) {
          setError(false);
          setData(d);
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (error) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <p className="text-gray-500 text-sm">Could not load fitness profile.</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <p className="text-gray-500 text-sm animate-pulse">Loading fitness profile...</p>
      </div>
    );
  }

  const { athlete, zones, stats, personalBests } = data;
  const hrZones = zones?.heart_rate?.zones ?? [];
  const wkg = athlete?.weight && athlete?.ftp ? athlete.ftp / athlete.weight : null;

  const profileStats: { label: string; value: string }[] = [];
  if (athlete?.weight) profileStats.push({ label: "Weight", value: `${athlete.weight}kg` });
  if (athlete?.ftp) profileStats.push({ label: "FTP", value: `${athlete.ftp}W` });
  if (wkg) profileStats.push({ label: "W/kg", value: wkg.toFixed(2) });

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-4">
      <SectionLabel className="mb-0">Fitness Profile</SectionLabel>

      {profileStats.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {profileStats.map((s) => (
            <span
              key={s.label}
              className="px-2 py-1 rounded-md bg-gray-950/60 border border-gray-800 text-xs"
            >
              <span className="text-gray-500">{s.label}</span>{" "}
              <span className="text-white font-semibold">{s.value}</span>
            </span>
          ))}
        </div>
      )}

      {hrZones.length > 0 && (
        <div>
          <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
            HR Zones
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {hrZones.map((z, i) => (
              <div
                key={i}
                className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold ${ZONE_COLORS[i] ?? ZONE_COLORS[0]}`}
              >
                {ZONE_NAMES[i] ?? `Z${i + 1}`} {z.min}{z.max === -1 ? "+" : `–${z.max}`}
              </div>
            ))}
          </div>
        </div>
      )}

      {stats && (
        <div>
          <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
            Season Totals
          </h3>
          <div className="space-y-1 text-xs">
            <div className="grid grid-cols-[auto_1fr_1fr] gap-2 text-gray-500 text-[10px] uppercase tracking-wider">
              <span />
              <span className="text-right">4 wks</span>
              <span className="text-right">YTD</span>
            </div>
            {([
              ["Swim", "swim", stats.recent_swim_totals, stats.ytd_swim_totals, "text-cyan-400"],
              ["Ride", "ride", stats.recent_ride_totals, stats.ytd_ride_totals, "text-blue-400"],
              ["Run", "run", stats.recent_run_totals, stats.ytd_run_totals, "text-green-400"],
            ] as const).map(([label, discipline, recent, ytd, color]) => (
              <div key={label} className="grid grid-cols-[auto_1fr_1fr] gap-2">
                <span className={`font-semibold inline-flex items-center gap-1.5 ${color}`}>
                  <DisciplineGlyph discipline={discipline as Discipline} size={13} />
                  {label}
                </span>
                <span className="text-right text-gray-300">
                  {formatKm(recent.distance)} · {formatHours(recent.moving_time)}
                </span>
                <span className="text-right text-gray-300">
                  {formatKm(ytd.distance)} · {formatHours(ytd.moving_time)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
          Personal Bests
        </h3>
        {personalBests.length === 0 ? (
          <p className="text-gray-600 text-[11px] leading-snug">
            PBs are tracked as you open or analyze runs.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {personalBests.map((pb) => (
              <div
                key={pb.name}
                title={`${pb.activityName} · ${pb.activityDate}`}
                className="px-2 py-0.5 rounded-full border border-gray-700 bg-gray-950/60 text-[11px]"
              >
                <span className="text-gray-400">{pb.name}</span>{" "}
                <span className="text-white font-semibold">{formatPbTime(pb.moving_time)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
