"use client";

import { useEffect, useState } from "react";
import {
  AthleteDetail,
  AthleteStats,
  AthleteZones,
} from "@trihards/core";
import type { PbSyncResult, PersonalBest } from "@/lib/personal-bests";
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

// Render an ISO `YYYY-MM-DD` PB date as a compact, readable label like
// "12 Mar 2026". Parsed as a local date (no time component) so the day
// doesn't shift across timezones.
function formatPbDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Build a caption describing the date range the PBs are drawn from. Returns a
// single date when all PBs share one day, otherwise an "earliest – latest"
// range. PB dates are ISO `YYYY-MM-DD` so lexical comparison matches chronology.
function formatPbRange(bests: PersonalBest[]): string | null {
  const dates = bests.flatMap((pb) => (pb.activityDate ? [pb.activityDate] : []));
  if (dates.length === 0) return null;
  let earliest = dates[0];
  let latest = dates[0];
  for (const d of dates) {
    if (d < earliest) earliest = d;
    if (d > latest) latest = d;
  }
  if (earliest === latest) return `Based on an activity from ${formatPbDate(earliest)}`;
  return `Based on activities from ${formatPbDate(earliest)} – ${formatPbDate(latest)}`;
}

export function FitnessProfile({ refreshKey }: { refreshKey?: number }) {
  const [data, setData] = useState<FitnessData | null>(null);
  const [error, setError] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const currentYear = new Date().getFullYear();

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

  // Walks the year in batches: Strava exposes best efforts only per activity, so
  // one request can't cover a whole season's runs without blowing the API's
  // rate limit. The route reports how much is left and resumes from a stored
  // cursor, so this just keeps posting until it says done.
  async function syncYear() {
    // The button is disabled while syncing, but `disabled` only takes effect on
    // the render after setSyncing — a double-click inside one tick would start
    // two scan loops racing on the same server-side cursor.
    if (syncing) return;
    setSyncing(true);
    setSyncNote(null);
    let scanned = 0;
    try {
      for (;;) {
        const res = await fetch("/api/personal-bests/sync", { method: "POST" });
        if (!res.ok) throw new Error("sync failed");
        const batch = (await res.json()) as PbSyncResult;
        scanned += batch.processed;

        if (batch.rateLimited) {
          setSyncNote(
            `Strava's rate limit paused the scan after ${scanned} runs. Run it again in ~15 minutes to carry on from here.`,
          );
          break;
        }
        if (batch.done) {
          setSyncNote(scanned === 0 ? "Already up to date." : `Scanned ${scanned} runs.`);
          break;
        }
        // Defensive: a batch that reports neither progress nor completion would
        // otherwise spin this loop forever.
        if (batch.processed === 0) break;
        setSyncNote(`Scanned ${scanned} runs, ${batch.remaining} to go...`);
      }

      const fresh = await fetch("/api/fitness");
      if (fresh.ok) setData(await fresh.json());
    } catch {
      setSyncNote("Scan failed. Try again.");
    } finally {
      setSyncing(false);
    }
  }

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
                key={`${z.min}-${z.max}`}
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
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <h3 className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
            Personal Bests
            <span className="px-1.5 py-px rounded-full border border-gray-700 bg-gray-950/60 text-gray-400 tracking-normal">
              {currentYear}
            </span>
          </h3>
          <button
            type="button"
            onClick={syncYear}
            disabled={syncing}
            className="px-2 py-0.5 rounded-full border border-gray-700 bg-gray-950/60 text-[10px] text-gray-400 hover:text-white hover:border-gray-600 disabled:opacity-50 disabled:cursor-default cursor-pointer transition-colors"
          >
            {syncing ? "Scanning..." : "Scan year"}
          </button>
        </div>
        {personalBests.length === 0 ? (
          <p className="text-gray-600 text-[11px] leading-snug">
            No bests recorded for {currentYear} yet. Scan the year to read best
            efforts from every run you&apos;ve logged since January.
          </p>
        ) : (
          <>
            <p className="text-gray-500 text-[11px] leading-snug mb-1.5">
              Your best efforts so far in {currentYear}.
              {(() => {
                const range = formatPbRange(personalBests);
                return range ? <span className="block">{range}</span> : null;
              })()}
            </p>
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
          </>
        )}
        {syncNote && (
          <p className="text-gray-600 text-[11px] leading-snug mt-1.5">{syncNote}</p>
        )}
      </div>
    </div>
  );
}
