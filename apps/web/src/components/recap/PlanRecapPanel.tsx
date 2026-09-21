"use client";

import {
  adherencePct,
  readPlan,
  typeLabel,
  type PlanRecap,
} from "@trihards/core";
import { MeterBar, Reads, Readout, Rule } from "./parts";

const DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * The four grades a session can end on, in the order the ribbon stacks them:
 * best outcome first, so the bar reads left to right as the plan degrading.
 * Colours are the app's status tokens, never the discipline hues — a green bar
 * here means "done", not "run".
 */
const GRADES = [
  { key: "completed", label: "Done", color: "var(--ok)" },
  { key: "partial", label: "Partial", color: "var(--warn)" },
  { key: "missed", label: "Missed", color: "var(--err)" },
  { key: "skipped", label: "Skipped", color: "var(--text-faint)" },
] as const;

export function PlanRecapPanel({ recap }: { recap: PlanRecap }) {
  const insights = readPlan(recap);
  const { adherence, fitness } = recap;
  const done = adherence.completed + adherence.partial;
  const rate = adherencePct(recap.adherence);
  const graded =
    adherence.completed + adherence.partial + adherence.missed + adherence.skipped;

  return (
    <div className="p-6 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="font-display text-2xl uppercase leading-tight tracking-wide text-white">
            {recap.raceName}
          </h3>
          <p className="mt-1 font-data text-[11px] text-gray-500">
            {DATE_FMT.format(new Date(`${recap.raceDate}T12:00:00`))} ·{" "}
            {recap.weeks}-week {recap.discipline} plan · {recap.name}
          </p>
        </div>
        <span className="inline-flex items-center rounded-full border border-gray-700 bg-gray-800 px-2.5 py-0.5 font-data text-[11px] uppercase tracking-wide text-gray-400">
          {recap.daysSinceRace === 1
            ? "Raced yesterday"
            : `Raced ${recap.daysSinceRace} days ago`}
        </span>
      </div>

      {/* The outcome, as one bar. Every session the plan prescribed is in here
          exactly once, so the widths are the plan and nothing is rounded away. */}
      <div className="mt-6 flex items-end justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-5xl font-semibold leading-none tabular-nums text-white">
            {done}
          </span>
          <span className="font-display text-2xl leading-none tabular-nums text-gray-600">
            / {adherence.total}
          </span>
          <span className="ml-1 font-data text-[11px] uppercase tracking-wider text-gray-500">
            sessions done
          </span>
        </div>
        <span className="font-display text-2xl leading-none tabular-nums text-gray-300">
          {rate}%
        </span>
      </div>

      {graded > 0 && (
        <div className="mt-3 flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full">
          {GRADES.map((grade) => {
            const count = adherence[grade.key];
            if (count === 0) return null;
            return (
              <div
                key={grade.key}
                className="h-full first:rounded-l-full last:rounded-r-full"
                style={{
                  width: `${(count / graded) * 100}%`,
                  background: grade.color,
                }}
                title={`${grade.label}: ${count}`}
              />
            );
          })}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
        {GRADES.map((grade) => (
          <span
            key={grade.key}
            className="inline-flex items-center gap-1.5 font-data text-[11px] text-gray-500"
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: grade.color }}
              aria-hidden
            />
            {grade.label}
            <span className="text-gray-300">{adherence[grade.key]}</span>
          </span>
        ))}
      </div>

      <Rule className="my-6" />

      <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
        <Readout
          label="Distance"
          value={`${Math.round(adherence.actualKm)}`}
          unit={`/ ${Math.round(adherence.plannedKm)} km`}
          note={
            adherence.plannedKm > 0
              ? `${Math.round((adherence.actualKm / adherence.plannedKm) * 100)}% of the plan's volume`
              : undefined
          }
        />
        <Readout
          label="Fitness built"
          value={
            fitness
              ? `${fitness.ctlRace >= fitness.ctlStart ? "+" : ""}${(fitness.ctlRace - fitness.ctlStart).toFixed(0)}`
              : "—"
          }
          note={
            fitness
              ? `CTL ${fitness.ctlStart.toFixed(0)} → ${fitness.ctlRace.toFixed(0)}`
              : "no history for this plan"
          }
        />
        <Readout
          label="Peak fitness"
          value={fitness ? fitness.ctlPeak.toFixed(0) : "—"}
          note="the level your next block starts from"
        />
        <Readout
          label="Form on race day"
          value={
            fitness
              ? `${fitness.tsbRace > 0 ? "+" : ""}${fitness.tsbRace.toFixed(0)}`
              : "—"
          }
          note="above +10 is a taper that landed"
        />
      </div>

      {recap.byType.length > 0 && (
        <>
          <Rule className="my-6" />
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-display text-[12px] uppercase tracking-[0.22em] text-gray-500">
              Which sessions you kept
            </span>
            <span className="font-data text-[11px] text-gray-600">
              done, partials included
            </span>
          </div>
          <div className="mt-4 space-y-3">
            {recap.byType.map((type) => {
              const typeRate = type.total > 0 ? type.done / type.total : 0;
              // Green when a session type was largely honoured, amber when it
              // was half-kept, red when it mostly did not happen. Same
              // vocabulary as the ribbon above, so one legend covers both.
              const color =
                typeRate >= 0.8
                  ? "var(--ok)"
                  : typeRate >= 0.5
                    ? "var(--warn)"
                    : "var(--err)";
              return (
                <div
                  key={type.type}
                  className="grid grid-cols-[88px_minmax(0,1fr)_auto] items-center gap-3 max-sm:grid-cols-[72px_minmax(0,1fr)_auto]"
                >
                  <span className="font-display text-[13px] uppercase tracking-wider text-gray-300">
                    {typeLabel(type.type)}
                  </span>
                  <MeterBar
                    fraction={typeRate}
                    color={color}
                    title={`${type.done} of ${type.total} done`}
                  />
                  <span className="font-data text-[11px] tabular-nums text-gray-500">
                    {type.done}/{type.total}
                  </span>
                </div>
              );
            })}
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
