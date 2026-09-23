"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  formatDuration,
  formatSecondsAsClock,
  intensityZone,
  totalSeconds,
  type ThresholdAnchor,
  type WorkoutBlock,
} from "@trihards/core";

/**
 * A suggested session drawn as a structured workout: time along the bottom,
 * intensity up the side, a dashed line at threshold.
 *
 * The shape is the point. "6 x 400 m, 90 s jog" and "4 x 8 min, 4 min spin"
 * are both four lines of text, but one is a comb of short spikes over the line
 * and the other a few broad plateaus just under it, and an athlete reads that
 * difference at a glance in a way they never do from the steps.
 *
 * Colour repeats the height as a zone, using the same zone tokens as every
 * other zone chart in the app, so the reading never depends on colour alone.
 * Hand-drawn SVG, no charting library — like RepChart, this stays out of the
 * recharts chunk.
 */

const H = 96;
/** Headroom above the tallest block, as a fraction of threshold. */
const Y_MAX_FLOOR = 1.3;
/** Blocks are separated by a gap of surface rather than drawn with a stroke. */
const GAP = 2;
/** A stride is 20 seconds; on a phone it must still be visible. */
const MIN_BLOCK = 1.5;

const ZONE_NAME = ["Recovery", "Endurance", "Tempo", "Threshold", "VO2 max"] as const;

/** Tracks an element's rendered width, so the SVG can be drawn in real pixels. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

interface Laid {
  block: WorkoutBlock;
  x: number;
  w: number;
}

/**
 * Left to right on a shared time axis. A module-scope helper for the same
 * reason as RepChart's: the React compiler rejects a running offset
 * reassigned across a render body.
 */
function layout(blocks: WorkoutBlock[], width: number): Laid[] {
  const total = totalSeconds(blocks) || 1;
  const out: Laid[] = [];
  let x = 0;
  for (const block of blocks) {
    const w = (block.durationSec / total) * width;
    out.push({ block, x, w });
    x += w;
  }
  return out;
}

/** "Rep 3 of 6 · 400 m", or "Warm-up · 17:00" when the prescription is time. */
function extent(b: WorkoutBlock): string {
  if (b.distanceM) {
    return b.distanceM >= 1000 ? `${+(b.distanceM / 1000).toFixed(1)} km` : `${b.distanceM} m`;
  }
  return formatSecondsAsClock(b.durationSec);
}

/**
 * The headline of a block's readout. A prescribed target (their own rep pace,
 * watts from FTP) when there is one; otherwise the zone by name. The mapped
 * intensity is never printed as a number — it is an approximation for
 * drawing, and a "73%" on a warm-up would read as a prescription.
 */
function headline(b: WorkoutBlock): string {
  if (b.target) return b.target;
  const zone = intensityZone(Math.max(b.intensity, b.endIntensity ?? 0));
  return b.endIntensity !== undefined && intensityZone(b.intensity) !== zone
    ? `Building to Z${zone}`
    : `Z${zone} · ${ZONE_NAME[zone - 1]}`;
}

function describe(b: WorkoutBlock): string {
  return `${b.label}, ${extent(b)}, ${headline(b)}`;
}

function thresholdLabel(anchor: ThresholdAnchor): string {
  if (anchor.kind === "ftp") return `FTP ${anchor.watts} W`;
  if (anchor.kind === "pace") return `Threshold ${formatSecondsAsClock(anchor.secPerKm)}/km`;
  return "Threshold";
}

/** Tick spacing that keeps the time axis to a handful of labels. */
function tickStep(totalMin: number, width: number): number {
  const most = width < 480 ? 4 : 7;
  return [5, 10, 15, 20, 30, 60, 120].find((s) => totalMin / s <= most) ?? 240;
}

export function WorkoutProfile({
  blocks,
  threshold,
  name,
}: {
  blocks: WorkoutBlock[];
  threshold: ThresholdAnchor;
  name: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  if (blocks.length === 0) return null;

  const totalSec = totalSeconds(blocks);
  const yMax = Math.max(
    Y_MAX_FLOOR,
    ...blocks.map((b) => Math.max(b.intensity, b.endIntensity ?? 0) + 0.08),
  );
  const y = (intensity: number) => H - (intensity / yMax) * H;
  const thresholdY = y(1);
  const laid = width > 0 ? layout(blocks, width) : [];

  const totalMin = totalSec / 60;
  const step = tickStep(totalMin, width);
  const ticks: number[] = [];
  // Drop a tick that would collide with the total printed at the right edge.
  // Measured in pixels: "1h 9m" is wide, and on a phone a proportional margin
  // is not enough to keep a "1h" tick clear of it.
  for (let t = 0; (t / totalMin) * width <= width - 56; t += step) ticks.push(t);

  function pick(e: PointerEvent<SVGSVGElement>) {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const i = laid.findIndex((l) => x >= l.x && x < l.x + l.w);
    setActive(i >= 0 ? i : null);
  }

  // Arrow keys walk the blocks, so the readout is reachable without a pointer.
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    setActive((i) => Math.min(blocks.length - 1, Math.max(0, (i ?? (dir > 0 ? -1 : blocks.length)) + dir)));
  }

  const shown = active !== null ? laid[active] : null;
  const zoneRange = [...new Set(blocks.map((b) => intensityZone(b.intensity)))].sort();

  return (
    <figure className="m-0">
      <div
        ref={ref}
        tabIndex={0}
        role="group"
        aria-roledescription="workout chart"
        aria-label={`${name}: intensity over ${formatDuration(totalMin)}, zones ${zoneRange.join(" to ")}. Use the arrow keys to step through it.`}
        onKeyDown={onKey}
        onFocus={() => setActive((i) => i ?? 0)}
        onBlur={() => setActive(null)}
        className="relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-orange-500/60"
        style={{ height: H }}
      >
        {width > 0 && (
          <svg
            width={width}
            height={H}
            className="block cursor-crosshair touch-pan-y"
            aria-hidden
            onPointerMove={pick}
            onPointerDown={pick}
            onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
          >
            {laid.map(({ block, x, w }, i) => {
              const gap = Math.min(GAP, w * 0.25);
              const x0 = x + gap / 2;
              const x1 = x0 + Math.max(MIN_BLOCK, w - gap);
              const y0 = y(block.intensity);
              const y1 = y(block.endIntensity ?? block.intensity);
              // Flat blocks get the 2px rounded data-end; a ramp's sloped top
              // is drawn straight.
              const r = block.endIntensity === undefined ? Math.min(2, (x1 - x0) / 2) : 0;
              const d =
                r > 0
                  ? `M${x0},${H} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x1 - r} Q${x1},${y0} ${x1},${y0 + r} V${H} Z`
                  : `M${x0},${H} L${x0},${y0} L${x1},${y1} L${x1},${H} Z`;
              const zone = intensityZone(Math.max(block.intensity, block.endIntensity ?? 0));
              return (
                <path
                  key={i}
                  d={d}
                  fill={`var(--zone-${zone})`}
                  fillOpacity={active === null || active === i ? 1 : 0.4}
                  className="transition-[fill-opacity] duration-150"
                />
              );
            })}

            <line x1={0} x2={width} y1={H - 0.5} y2={H - 0.5} stroke="var(--chart-grid)" />
            <line
              x1={0}
              x2={width}
              y1={thresholdY}
              y2={thresholdY}
              stroke="var(--text-muted)"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
          </svg>
        )}

        {/* Labelled on the left, where every session is still warming up and
            the line runs clear of the blocks. */}
        <span
          className="pointer-events-none absolute left-0 font-data text-[10px] uppercase tracking-wider text-gray-500"
          style={{ top: thresholdY - 15 }}
        >
          {thresholdLabel(threshold)}
        </span>

        <div role="status" aria-live="polite" className="sr-only">
          {shown ? describe(shown.block) : ""}
        </div>

        {shown && (
          <div
            className="pointer-events-none absolute z-10 w-max max-w-[220px] -translate-x-1/2 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 shadow-lg"
            style={{
              bottom: H + 6,
              left: Math.min(Math.max(shown.x + shown.w / 2, 110), width - 110),
            }}
            aria-hidden
          >
            <div className="flex items-center gap-2">
              <span
                className="h-0.5 w-3 rounded-full"
                style={{
                  background: `var(--zone-${intensityZone(Math.max(shown.block.intensity, shown.block.endIntensity ?? 0))})`,
                }}
              />
              <span className="font-data text-[13px] text-gray-200">{headline(shown.block)}</span>
            </div>
            <div className="mt-0.5 font-data text-[11px] text-gray-500">
              {shown.block.label} · {extent(shown.block)}
            </div>
          </div>
        )}
      </div>

      <div className="relative mt-1.5 h-3.5 font-data text-[10px] text-gray-600" aria-hidden>
        {ticks.map((t) => (
          <span
            key={t}
            className="absolute top-0 tabular-nums"
            style={{
              left: `${(t / totalMin) * 100}%`,
              transform: t === 0 ? undefined : "translateX(-50%)",
            }}
          >
            {t === 0 ? "0" : t % 60 === 0 ? `${t / 60}h` : formatDuration(t)}
          </span>
        ))}
        <span className="absolute right-0 top-0 tabular-nums text-gray-500">
          {formatDuration(totalMin)}
        </span>
      </div>

      {/* An estimated pace says where it came from, so it can be argued with. */}
      {threshold.kind === "pace" && (
        <p className="mt-1.5 font-data text-[10px] text-gray-600">
          Threshold estimated from {threshold.from}
        </p>
      )}
    </figure>
  );
}
