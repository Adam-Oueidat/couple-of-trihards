"use client";

import { useState } from "react";
import { DetailedActivity } from "@trihards/core";
import { getDiscipline } from "@trihards/core";
import { buildLapPoints, formatSplitPace, tooltipStyle } from "./format";

export function LapChart({
  laps,
  discipline,
}: {
  laps: NonNullable<DetailedActivity["laps"]>;
  discipline: ReturnType<typeof getDiscipline>;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const points = buildLapPoints(laps, discipline);
  const totalTime = points.reduce((s, p) => s + p.seconds, 0) || 1;
  const maxSpeed = Math.max(...points.map((p) => p.speed), 0.1);

  const VW = 1000; // viewBox width units (scaled to container by the browser)
  const H = 160;
  const TOP = 8; // headroom above the tallest bar
  const GAP = 2; // horizontal inset per side, in viewBox units
  const MIN_H = 4; // keep even a slow walk visible
  const AXIS_W = 52; // px gutter for the pace axis

  const fracs = points.map((p) => p.seconds / totalTime);
  const starts = fracs.map((_, i) => fracs.slice(0, i).reduce((a, b) => a + b, 0));
  const bars = points.map((p, i) => ({
    i,
    x: starts[i] * VW,
    w: fracs[i] * VW,
    bh: Math.max(MIN_H, (p.speed / maxSpeed) * (H - TOP)),
    p,
  }));

  // Pace reference lines: evenly-spaced speeds mapped to their y and labeled in
  // pace, so faster (taller) sits higher. Non-round on purpose — they read off
  // the actual lap range rather than arbitrary round paces.
  const TICKS = 4;
  const paceTicks = Array.from({ length: TICKS }, (_, k) => {
    const speed = (maxSpeed * (k + 1)) / TICKS;
    return { y: H - (speed / maxSpeed) * (H - TOP), label: formatSplitPace(speed, discipline) };
  });

  const active = hover !== null ? bars[hover] : null;

  return (
    <div>
      <div className="flex">
        <div className="relative flex-shrink-0" style={{ width: AXIS_W, height: H }}>
          {paceTicks.map((t, k) => (
            <span
              key={k}
              className="absolute right-1.5 -translate-y-1/2 text-gray-500 text-[10px] tabular-nums"
              style={{ top: t.y }}
            >
              {t.label}
            </span>
          ))}
        </div>
        <div className="relative flex-1">
          <svg
            viewBox={`0 0 ${VW} ${H}`}
            width="100%"
            height={H}
            preserveAspectRatio="none"
            onMouseLeave={() => setHover(null)}
          >
            {paceTicks.map((t, k) => (
              <line
                key={k}
                x1={0}
                x2={VW}
                y1={t.y}
                y2={t.y}
                stroke="#374151"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
            ))}
            {bars.map((b) => (
              <rect
                key={b.i}
                x={b.x + GAP}
                y={H - b.bh}
                width={Math.max(0, b.w - GAP * 2)}
                height={b.bh}
                fill={b.p.walk ? "#4b5563" : "#f97316"}
                opacity={hover === null || hover === b.i ? 1 : 0.5}
                onMouseEnter={() => setHover(b.i)}
              />
            ))}
          </svg>
          {active && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg px-3 py-2 text-gray-200"
              style={{
                ...tooltipStyle,
                left: `${((active.x + active.w / 2) / VW) * 100}%`,
                top: H - active.bh - 8,
              }}
            >
              <p className="font-semibold text-white">Lap {active.p.lap}</p>
              <p>{active.p.dist} · {active.p.time}</p>
              <p>{active.p.pace}</p>
              {active.p.hr ? <p>{active.p.hr.toFixed(0)} bpm</p> : null}
            </div>
          )}
        </div>
      </div>
      <p className="mt-1.5 text-gray-500 text-xs" style={{ paddingLeft: AXIS_W }}>
        Bar width = duration · height = pace (taller = faster)
        {points.some((p) => p.walk) ? " · grey = walking rest" : ""}
      </p>
    </div>
  );
}

