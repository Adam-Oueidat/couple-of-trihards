"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import type { QualityScanResult } from "@/lib/quality-scan";
import {
  formatSecondsAsClock,
  readQuality,
  type QualityRecap,
  type ZoneSource,
} from "@trihards/core";
import { Delta, InfoHint, Reads, Readout, Rule } from "./parts";
import { ZoneBar } from "./ZoneBar";
import { EfficiencySpark } from "./EfficiencySpark";
import { RepChart, RepTable } from "./RepChart";

const RANGE_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const RANGE_FMT_YEAR = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * A date range, carrying the year only when it needs to.
 *
 * The trend window is a full season, so without the year it renders as
 * "24 Sept – 22 Sept" — which reads as a typo rather than as twelve months.
 * The six-week window never crosses a year boundary and stays compact.
 */
function range(from: string, to: string): string {
  const start = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  const fmt = start.getFullYear() === end.getFullYear() ? RANGE_FMT : RANGE_FMT_YEAR;
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

/**
 * Plain-language definitions for the measures on this panel.
 *
 * Each says what the number IS first, then why it is worth looking at. Written
 * for an athlete rather than a physiologist: no jargon that is not immediately
 * unpacked, and no claim the panel does not actually compute.
 */
const HINTS = {
  efficiency:
    "Speed per heartbeat. Rising means you cover more ground for the same cardiac cost, which is the clearest sign your aerobic base is growing. Measured on easy runs only, so it tracks fitness rather than how hard you chose to run that day.",
  paceAtHr:
    "Your average pace on runs whose heart rate sat inside this band. Holding effort constant is what makes it a fair comparison: if the pace improves, that is fitness rather than simply trying harder.",
  sessions:
    "Runs in the last six weeks that recorded heart rate. Everything on this panel is built from these, so the count is also how much evidence there is behind it.",
  easyShare:
    "Share of your training time spent in zones 1 and 2. Most endurance plans aim for roughly 80 percent easy, which is what leaves enough freshness to do the hard sessions properly.",
} as const;

function pace(secPerKm: number): string {
  return `${formatSecondsAsClock(secPerKm)}/km`;
}

/** Where the zone boundaries came from — stated, never implied. */
function zoneProvenance(source: ZoneSource, maxHr: number | null): string {
  switch (source) {
    case "strava-custom":
      return "your own zones";
    case "strava-default":
      return "Strava defaults, not personalised";
    case "estimated-max":
      return `estimated from your max of ${maxHr} bpm`;
    case "none":
      return "no zones available";
  }
}

/**
 * Training quality: what the heart-rate and pace data say, as opposed to how
 * much work was done.
 *
 * Two windows, each labelled where it is shown. The trends span the full
 * history because that is the only length at which they mean anything — the
 * same athlete's efficiency moved 11% across a year and is indistinguishable
 * from noise month to month. The intensity mix covers the current block,
 * because what you do about it is a decision about next week.
 */
export const QUALITY_KEY = "/api/training-quality";

/**
 * A full season is more Strava reads than one rate-limit window allows, so the
 * scan runs in batches. Capping the batches per press matters: spending the
 * whole 100-read budget here would make the athlete's next dashboard Sync fail
 * with a 429 that has nothing to do with what they just clicked.
 */
const MAX_BATCHES_PER_PRESS = 4;

export function QualityPanel({ recap: seed }: { recap: QualityRecap }) {
  // Server-rendered for the first paint, then revalidated here so scan progress
  // appears without a reload. One builder, one shape, no waterfall.
  const { data, mutate } = useSWR<QualityRecap>(QUALITY_KEY, fetcher, {
    fallbackData: seed,
    revalidateOnFocus: false,
  });
  const recap = data ?? seed;

  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);

  const insights = readQuality(recap);
  const { efficiency, paceAtHr, timeInZone, summary, coverage, zones } = recap;
  const [openSession, setOpenSession] = useState(0);
  const session = recap.sessions[openSession] ?? recap.sessions[0];

  async function scan() {
    // `disabled` only takes effect on the render after setScanning, so a
    // double-click inside one tick would start two loops on the same rows.
    if (scanning) return;
    setScanning(true);
    setScanNote(null);
    let done = 0;
    try {
      for (let i = 0; i < MAX_BATCHES_PER_PRESS; i++) {
        const res = await fetch(`${QUALITY_KEY}/scan`, { method: "POST" });
        if (!res.ok) throw new Error("scan failed");
        const batch = (await res.json()) as QualityScanResult;
        done += batch.processed;

        if (batch.rateLimited) {
          setScanNote(
            `Strava's rate limit paused the scan after ${done} session${done === 1 ? "" : "s"}. Run it again in about 15 minutes to carry on from here.`,
          );
          break;
        }
        if (batch.done) {
          setScanNote(done === 0 ? "Already up to date." : `Scanned ${done} sessions.`);
          break;
        }
        // Defensive: a batch reporting neither progress nor completion would
        // otherwise spin this loop until the cap.
        if (batch.processed === 0) break;
        setScanNote(`Scanned ${done}, ${batch.remaining} to go...`);
        if (i === MAX_BATCHES_PER_PRESS - 1) {
          setScanNote(
            `Scanned ${done} sessions, ${batch.remaining} to go. Press again to continue — this is paced so it does not use up your whole Strava allowance at once.`,
          );
        }
      }
    } catch {
      setScanNote("Scan failed. Try again.");
    } finally {
      setScanning(false);
      void mutate();
    }
  }

  const easyShare = timeInZone
    ? Math.round((timeInZone.share[0] + timeInZone.share[1]) * 100)
    : null;

  if (zones.source === "none") {
    return (
      <div className="px-6 py-10 text-center sm:px-7">
        <p className="font-display text-lg text-gray-300">No heart-rate data yet</p>
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-gray-500">
          Record a few runs with a heart-rate monitor and this reads back how hard
          you actually trained, how your easy pace is changing, and how your
          interval sessions went.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 sm:p-7">
      <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
        <Readout
          label="Aerobic efficiency"
          hint={HINTS.efficiency}
          value={efficiency.eligible ? efficiency.late.toFixed(1) : "—"}
          note={
            efficiency.eligible && efficiency.changePct !== null ? (
              <Delta pct={Math.round(efficiency.changePct)} suffix="across the season" />
            ) : (
              "needs more easy runs"
            )
          }
        />
        <Readout
          label={paceAtHr ? `Pace at ${paceAtHr.lowBpm}–${paceAtHr.highBpm} bpm` : "Pace at a fixed effort"}
          hint={HINTS.paceAtHr}
          value={paceAtHr?.eligible ? pace(paceAtHr.latePaceSecPerKm) : "—"}
          note={
            paceAtHr?.eligible && paceAtHr.deltaSecPerKm !== null
              ? `${paceAtHr.deltaSecPerKm <= 0 ? "↓" : "↑"} ${Math.abs(paceAtHr.deltaSecPerKm)} sec/km from ${pace(paceAtHr.earlyPaceSecPerKm)}`
              : "needs more runs in one band"
          }
        />
        <Readout
          label="Sessions with HR"
          hint={HINTS.sessions}
          value={`${coverage.eligible}`}
          note={
            coverage.tier === "summary"
              ? "in the last six weeks"
              : `${coverage.scanned} analysed in full`
          }
        />
        <Readout
          label="Easy share"
          hint={HINTS.easyShare}
          // Last column: a left-aligned panel would run off the card, which
          // hides overflow and would clip it.
          hintAlign="right"
          value={easyShare === null ? "—" : `${easyShare}%`}
          note={easyShare === null ? "needs a session scan" : "of training time in Z1–Z2"}
        />
      </div>

      <Rule className="my-6" />

      {/* Intensity mix. The title and caption change with the source, because
          session averages and real time in zone are different claims and the
          weaker one must never borrow the stronger one's words. */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-display text-[12px] uppercase tracking-[0.22em] text-gray-500">
          {timeInZone ? "Time in zone" : "Session average HR"}
        </span>
        <span className="font-data text-[11px] text-gray-600">
          {range(recap.mixFrom, recap.mixTo)}
        </span>
      </div>

      <div className="mt-4">
        {timeInZone ? (
          <ZoneBar values={timeInZone.seconds} unit="seconds" />
        ) : (
          <ZoneBar values={summary.sessionAverage} unit="sessions" />
        )}
      </div>

      {!timeInZone && (
        <p className="mt-3 max-w-2xl text-[13px] leading-snug text-gray-500">
          Where whole sessions averaged — not time in zone. An interval session
          averages into Z3 between its Z5 reps and its Z1 recoveries, so this
          understates how polarised your training actually is.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={scan}
          disabled={scanning}
          className="cursor-pointer rounded-[10px] border border-orange-500/40 bg-orange-500/10 px-4 py-1.5 font-display text-[12px] uppercase tracking-wider text-orange-300 transition-colors hover:border-orange-500 hover:bg-orange-500/20 disabled:cursor-default disabled:opacity-60"
        >
          {scanning
            ? "Reading sessions…"
            : timeInZone
              ? "Scan more sessions"
              : "Scan for real time in zone"}
        </button>
        <span className="font-data text-[11px] text-gray-600">
          {coverage.scanned} of {coverage.eligible} sessions read in full
        </span>
      </div>

      {scanNote && (
        <p className="mt-2 max-w-2xl font-data text-[11px] leading-snug text-gray-500">
          {scanNote}
        </p>
      )}

      <p className="mt-2 font-data text-[11px] text-gray-600">
        Zones: {zoneProvenance(zones.source, zones.maxHr)}
      </p>

      <Rule className="my-6" />

      <div className="flex items-baseline justify-between gap-3">
        <span className="font-display text-[12px] uppercase tracking-[0.22em] text-gray-500">
          Aerobic efficiency
          <InfoHint text={HINTS.efficiency} />
        </span>
        <span className="font-data text-[11px] text-gray-600">
          {range(recap.trendFrom, recap.trendTo)} · speed per heartbeat
        </span>
      </div>
      <div className="mt-4">
        <EfficiencySpark trend={efficiency} />
      </div>

      {recap.sessions.length > 0 && session?.structure && (
        <>
          <Rule className="my-6" />
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-display text-[12px] uppercase tracking-[0.22em] text-gray-500">
              Interval sessions
            </span>
            <span className="font-data text-[11px] text-gray-600">
              {range(recap.mixFrom, recap.mixTo)}
            </span>
          </div>

          {/* Newest first: the session an athlete wants to look at is almost
              always the one they just did. */}
          <div className="mt-3 flex flex-wrap gap-2">
            {recap.sessions.map((s, i) => (
              <button
                key={s.activityId}
                type="button"
                onClick={() => setOpenSession(i)}
                aria-pressed={i === openSession}
                className={`cursor-pointer rounded-[8px] border px-3 py-1 font-data text-[11px] transition-colors ${
                  i === openSession
                    ? "border-orange-500 bg-orange-500/15 text-orange-300"
                    : "border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-300"
                }`}
              >
                {s.name}
              </button>
            ))}
          </div>

          <div className="mt-4 space-y-5">
            {session.structure.sets.map((set, i) => (
              <div key={i}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="font-display text-[15px] text-gray-200">{set.label}</span>
                  <span className="font-data text-[11px] text-gray-500">
                    {set.fadePct !== null && (
                      <>
                        {set.fadePct > 0
                          ? `faded ${set.fadePct.toFixed(1)}%`
                          : set.fadePct < 0
                            ? `negative split ${Math.abs(set.fadePct).toFixed(1)}%`
                            : "even"}
                      </>
                    )}
                    {set.hrDriftBpm !== null && set.fadePct !== null && " · "}
                    {set.hrDriftBpm !== null && (
                      <>heart rate {set.hrDriftBpm >= 0 ? "+" : ""}{set.hrDriftBpm} bpm</>
                    )}
                  </span>
                </div>
                {/* The chart carries legibility, the table carries the numbers.
                    Twenty bars in 320px is not readable, so narrow screens get
                    the table alone. */}
                <div className="mt-2 max-sm:hidden">
                  <RepChart set={set} />
                </div>
                <div className="mt-3">
                  <RepTable set={set} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {insights.length > 0 && (
        <>
          <Rule className="my-6" />
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <span className="font-display text-[12px] uppercase tracking-[0.22em] text-gray-500">
              What it says
            </span>
            <span className="font-data text-[11px] text-gray-600">
              read from the figures above
            </span>
          </div>
          <Reads insights={insights} />
        </>
      )}
    </div>
  );
}
