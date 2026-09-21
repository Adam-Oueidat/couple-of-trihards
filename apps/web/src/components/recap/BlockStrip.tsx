"use client";

import { useMemo, useState } from "react";
import { formatDuration, type BlockRecap, type TriDiscipline } from "@trihards/core";
import { DisciplineGlyph } from "../DisciplineGlyph";

/**
 * Forty-two days of training, drawn as one object.
 *
 * This is the recap's centrepiece, and the shape is not decorative. One column
 * per day, six groups of seven with a wider gutter between groups, so the week
 * structure is legible without a single label. Column height is that day's
 * training load; column colour is the discipline the day's time went into. A
 * rest day is a baseline tick rather than an empty slot, so the gaps that break
 * a block are visible as gaps — which is precisely the thing an athlete cannot
 * see from inside any one week.
 *
 * Behind the columns runs the fitness (CTL) curve for the same 42 days. It is
 * deliberately unaxed: the two series answer different questions and must never
 * be read off a shared scale, so CTL is direct-labelled at both ends instead —
 * the reader gets its magnitude and its direction without being invited to
 * compare its height against a bar's.
 *
 * Drawn in plain HTML and one stretched SVG path rather than through recharts:
 * it costs nothing at the bundle level and stays out of the charts chunk.
 */

const DISCIPLINE_COLOR: Record<TriDiscipline, string> = {
  swim: "var(--swim)",
  ride: "var(--ride)",
  run: "var(--run)",
};

const DISCIPLINE_LABEL: Record<TriDiscipline, string> = {
  swim: "Swim",
  ride: "Ride",
  run: "Run",
};

const DAY_FMT = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

const STRIP_HEIGHT = 76;

function shortWeek(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * The fitness curve as an SVG path in a 0–100 box, stretched to the strip.
 *
 * Padding the value range on both sides keeps a gently rising curve from
 * flattening against the top edge or grazing the baseline, and a block whose
 * CTL never moves draws as a level line rather than dividing by zero.
 */
function ridgePath(values: number[]): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const lo = span === 0 ? min - 1 : min - span * 0.45;
  const hi = span === 0 ? min + 1 : max + span * 0.2;
  const y = (v: number) => 100 - ((v - lo) / (hi - lo)) * 100;
  const step = 100 / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(3)},${y(v).toFixed(3)}`);
  return `M0,100 L${points.join(" L")} L100,100 Z`;
}

export function BlockStrip({ recap }: { recap: BlockRecap }) {
  const [hovered, setHovered] = useState<number | null>(null);

  const maxTss = useMemo(
    () => Math.max(1, ...recap.daily.map((d) => d.tss)),
    [recap.daily],
  );
  const ridge = useMemo(
    () => ridgePath(recap.daily.map((d) => d.ctl)),
    [recap.daily],
  );
  const hasFitness = recap.fitness !== null && recap.daily.some((d) => d.ctl > 0);

  const day = hovered === null ? null : recap.daily[hovered];

  return (
    <div>
      {/* Readout line. Always present, so hovering never shifts the layout —
          it swaps the block's summary for the hovered day's detail. */}
      <div className="flex min-h-[20px] flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        {day ? (
          <>
            <span className="font-data text-[11px] text-gray-400">
              {DAY_FMT.format(new Date(`${day.date}T12:00:00`))}
            </span>
            <span className="font-data text-[11px] text-gray-500">
              {day.dominant ? (
                <>
                  <span style={{ color: DISCIPLINE_COLOR[day.dominant] }}>
                    {DISCIPLINE_LABEL[day.dominant]}
                  </span>
                  {day.sessions > 1 ? ` ·  ${day.sessions} sessions` : ""} ·{" "}
                  {formatDuration(day.minutes)} · {day.tss} load
                </>
              ) : (
                "Rest day"
              )}
              {hasFitness && ` · fitness ${day.ctl.toFixed(0)}`}
            </span>
          </>
        ) : (
          <>
            <span className="font-data text-[11px] text-gray-500">
              Daily load, coloured by discipline
            </span>
            {hasFitness && recap.fitness && (
              <span className="font-data text-[11px] text-gray-500">
                Fitness{" "}
                <span style={{ color: "var(--accent)" }}>
                  {recap.fitness.ctlStart.toFixed(0)} → {recap.fitness.ctlEnd.toFixed(0)}
                </span>
              </span>
            )}
          </>
        )}
      </div>

      <div
        className="relative mt-2"
        style={{ height: STRIP_HEIGHT }}
        onMouseLeave={() => setHovered(null)}
      >
        {/* Fitness curve, stretched behind the columns. Non-uniform scaling is
            correct here: the path carries a trend, not a measurable geometry. */}
        {hasFitness && (
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden
          >
            <path d={ridge} fill="var(--accent)" fillOpacity={0.12} />
            <path
              d={ridge}
              fill="none"
              stroke="var(--accent)"
              strokeOpacity={0.5}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}

        {/* Day columns, grouped a week at a time. */}
        <div
          className="absolute inset-0 flex items-end gap-[5px]"
          role="img"
          aria-label={`Daily training load over ${recap.days} days: ${recap.daysTrained} days trained, longest gap ${recap.longestGap} days.`}
        >
          {recap.weekly.map((week, w) => (
            <div key={week.start} className="flex h-full flex-1 items-end gap-[2px]">
              {recap.daily.slice(w * 7, w * 7 + 7).map((d, i) => {
                const index = w * 7 + i;
                const active = hovered === index;
                const height = d.dominant
                  ? Math.max(3, (d.tss / maxTss) * STRIP_HEIGHT)
                  : 2;
                return (
                  <div
                    key={d.date}
                    className="flex-1 rounded-[2px] transition-opacity"
                    style={{
                      height,
                      background: d.dominant
                        ? DISCIPLINE_COLOR[d.dominant]
                        : "var(--text-faint)",
                      opacity: hovered === null || active ? 1 : 0.45,
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>

        {/* Hit layer: full-height targets over 6px-wide marks, so a day can
            actually be pointed at. Mirrors the grouping above exactly. */}
        <div className="absolute inset-0 flex gap-[5px]">
          {recap.weekly.map((week, w) => (
            <div key={week.start} className="flex h-full flex-1 gap-[2px]">
              {recap.daily.slice(w * 7, w * 7 + 7).map((d, i) => (
                <div
                  key={d.date}
                  className="h-full flex-1 cursor-pointer"
                  onMouseEnter={() => setHovered(w * 7 + i)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Baseline plus one date per week, which is as dense as the strip's own
          week grouping — a label per day would be unreadable and redundant. */}
      <div className="mt-1.5 h-px bg-gray-800" aria-hidden />
      <div className="mt-1.5 flex gap-[5px]">
        {recap.weekly.map((week) => (
          <span
            key={week.start}
            className="flex-1 font-data text-[10px] text-gray-600"
          >
            {shortWeek(week.start)}
          </span>
        ))}
      </div>

      {/* Legend. Glyphs carry identity alongside colour, so the three
          disciplines stay distinguishable without relying on hue. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {(["swim", "ride", "run"] as TriDiscipline[]).map((key) => {
          const totals = recap.totals.byDiscipline[key];
          return (
            <span
              key={key}
              className="inline-flex items-center gap-1.5 font-data text-[11px]"
              style={{ color: DISCIPLINE_COLOR[key] }}
            >
              <DisciplineGlyph discipline={key} size={12} />
              {DISCIPLINE_LABEL[key]}
              <span className="text-gray-500">{formatDuration(totals.minutes)}</span>
            </span>
          );
        })}
        {hasFitness && (
          <span className="inline-flex items-center gap-1.5 font-data text-[11px] text-gray-500">
            <span
              className="h-[2px] w-4 rounded-full"
              style={{ background: "var(--accent)" }}
              aria-hidden
            />
            Fitness
          </span>
        )}
      </div>
    </div>
  );
}
