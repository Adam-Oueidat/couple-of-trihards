"use client";

import {
  formatSecondsAsClock,
  readQuality,
  type QualityRecap,
  type ZoneSource,
} from "@trihards/core";
import { Delta, Reads, Readout, Rule } from "./parts";
import { ZoneBar } from "./ZoneBar";
import { EfficiencySpark } from "./EfficiencySpark";

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
export function QualityPanel({ recap }: { recap: QualityRecap }) {
  const insights = readQuality(recap);
  const { efficiency, paceAtHr, timeInZone, summary, coverage, zones } = recap;

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
          value={paceAtHr?.eligible ? pace(paceAtHr.latePaceSecPerKm) : "—"}
          note={
            paceAtHr?.eligible && paceAtHr.deltaSecPerKm !== null
              ? `${paceAtHr.deltaSecPerKm <= 0 ? "↓" : "↑"} ${Math.abs(paceAtHr.deltaSecPerKm)} sec/km from ${pace(paceAtHr.earlyPaceSecPerKm)}`
              : "needs more runs in one band"
          }
        />
        <Readout
          label="Sessions with HR"
          value={`${coverage.eligible}`}
          note={
            coverage.tier === "summary"
              ? "in the last six weeks"
              : `${coverage.scanned} analysed in full`
          }
        />
        <Readout
          label="Easy share"
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

      <p className="mt-2 font-data text-[11px] text-gray-600">
        Zones: {zoneProvenance(zones.source, zones.maxHr)}
      </p>

      <Rule className="my-6" />

      <div className="flex items-baseline justify-between gap-3">
        <span className="font-display text-[12px] uppercase tracking-[0.22em] text-gray-500">
          Aerobic efficiency
        </span>
        <span className="font-data text-[11px] text-gray-600">
          {range(recap.trendFrom, recap.trendTo)} · speed per heartbeat
        </span>
      </div>
      <div className="mt-4">
        <EfficiencySpark trend={efficiency} />
      </div>

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
