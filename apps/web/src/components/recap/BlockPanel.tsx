"use client";

import {
  formatDuration,
  readBlock,
  timeShare,
  type BlockRecap,
  type TrainingDiscipline,
} from "@trihards/core";
import { DisciplineGlyph } from "../DisciplineGlyph";
import { BlockStrip } from "./BlockStrip";
import { Delta, MeterBar, Reads, Readout, Rule, pctChange } from "./parts";

const DISCIPLINE_COLOR: Record<TrainingDiscipline, string> = {
  swim: "var(--swim)",
  ride: "var(--ride)",
  run: "var(--run)",
  strength: "var(--strength)",
};

const DISCIPLINE_LABEL: Record<TrainingDiscipline, string> = {
  swim: "Swim",
  ride: "Ride",
  run: "Run",
  strength: "Strength",
};

const ORDER: TrainingDiscipline[] = ["swim", "ride", "run", "strength"];

export function BlockPanel({ recap }: { recap: BlockRecap }) {
  const insights = readBlock(recap);
  const { totals, prior, fitness } = recap;
  const share = timeShare(totals);
  const priorShare = timeShare(prior);
  const maxMinutes = Math.max(
    1,
    ...ORDER.map((key) =>
      Math.max(totals.byDiscipline[key].minutes, prior.byDiscipline[key].minutes),
    ),
  );

  if (totals.sessions === 0 && prior.sessions === 0) {
    return (
      <div className="px-6 py-10 text-center sm:px-7">
        <p className="font-display text-lg text-gray-300">
          Nothing to summarise yet
        </p>
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-gray-500">
          Once you have a few weeks of synced activities, this reads them back to
          you — volume, consistency, fitness, and where the time actually went.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 sm:p-7">
      <BlockStrip recap={recap} />

      <Rule className="my-6" />

      <div className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
        <Readout
          label="Training time"
          value={formatDuration(totals.minutes)}
          note={<Delta pct={pctChange(totals.minutes, prior.minutes)} suffix="on the six before" />}
        />
        <Readout
          label="Days trained"
          value={`${recap.daysTrained}`}
          unit={`/ ${recap.days}`}
          note={
            recap.longestGap === 0
              ? `${recap.longestStreak}-day streak, no rest`
              : `longest gap ${recap.longestGap} day${recap.longestGap === 1 ? "" : "s"}`
          }
        />
        <Readout
          label="Fitness · CTL"
          value={fitness ? fitness.ctlEnd.toFixed(0) : "—"}
          note={
            fitness
              ? `${fitness.ctlEnd >= fitness.ctlStart ? "+" : ""}${(fitness.ctlEnd - fitness.ctlStart).toFixed(0)} over the block · ${fitness.rampPerWeek.toFixed(1)}/wk`
              : "no history yet"
          }
        />
        <Readout
          label="Sessions"
          value={`${totals.sessions}`}
          note={
            recap.longestSession
              ? `longest ${formatDuration(recap.longestSession.minutes)}`
              : undefined
          }
        />
      </div>

      <Rule className="my-6" />

      {/* Where the time went, against where it went in the previous six weeks.
          The comparison is the point: a triathlete's imbalance only shows up
          across blocks, never inside one week. */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-display text-[12px] uppercase tracking-[0.22em] text-gray-500">
          Where the time went
        </span>
        <span className="font-data text-[11px] text-gray-600">
          share of hours · previous block in brackets
        </span>
      </div>

      <div className="mt-4 space-y-3">
        {ORDER.map((key) => {
          const now = totals.byDiscipline[key];
          const was = prior.byDiscipline[key];
          const drift = share[key] - priorShare[key];
          return (
            <div
              key={key}
              className="grid grid-cols-[88px_minmax(0,1fr)_auto] items-center gap-3 max-sm:grid-cols-[72px_minmax(0,1fr)_auto]"
            >
              <span
                className="inline-flex items-center gap-1.5 font-display text-[13px] uppercase tracking-wider"
                style={{ color: DISCIPLINE_COLOR[key] }}
              >
                <DisciplineGlyph discipline={key} size={13} />
                {DISCIPLINE_LABEL[key]}
              </span>
              <div>
                <MeterBar
                  fraction={now.minutes / maxMinutes}
                  color={DISCIPLINE_COLOR[key]}
                  title={`${DISCIPLINE_LABEL[key]}: ${formatDuration(now.minutes)}`}
                />
                <div className="mt-1.5 font-data text-[11px] text-gray-500">
                  {now.sessions === 0
                    ? "nothing logged"
                    : `${formatDuration(now.minutes)}${key === "strength" ? "" : ` · ${now.km.toFixed(1)} km`} · ${now.sessions} session${now.sessions === 1 ? "" : "s"}`}
                </div>
              </div>
              <div className="text-right">
                <div className="font-display text-lg leading-none tabular-nums text-gray-200">
                  {share[key]}%
                </div>
                <div className="mt-1 font-data text-[11px] text-gray-600">
                  {was.minutes > 0 || now.minutes > 0
                    ? `(${priorShare[key]}%${drift === 0 ? "" : drift > 0 ? ` ↑${drift}` : ` ↓${Math.abs(drift)}`})`
                    : "—"}
                </div>
              </div>
            </div>
          );
        })}
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
