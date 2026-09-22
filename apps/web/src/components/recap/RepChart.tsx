"use client";

import { formatSecondsAsClock, type RepSet } from "@trihards/core";

/**
 * One interval set, drawn as its reps.
 *
 * Bar width is duration and bar height is speed, the same geometry the lap
 * chart uses — so a short fast rep reads narrow and tall, and the recovery
 * between them reads wide and flat. Reps and recoveries are drawn to the same
 * time scale, which is what makes a set with short recoveries look visibly
 * denser than one with long ones.
 *
 * The heart-rate dot above each rep is the point of the whole thing. Pace alone
 * cannot tell you whether a set was comfortable or survived: flat bars with
 * climbing dots is a set whose recoveries were too short, and that is legible
 * here in a way it never is in a table of split times.
 *
 * Hand-drawn SVG, no charting library — this card deliberately stays out of the
 * recharts chunk.
 */

const VW = 1000;
const H = 120;
const TOP = 26; // headroom for the HR dots
const MIN_BAR = 3;

function paceLabel(secPerKm: number): string {
  return `${formatSecondsAsClock(secPerKm)}/km`;
}

type Segment = { kind: "work" | "rest"; seconds: number; rep: RepSet["reps"][number] };

/**
 * Lay the segments out left to right on a shared time axis.
 *
 * A module-scope helper rather than a running offset inside the component: the
 * React compiler rejects reassigning a variable across a render body, and the
 * accumulation genuinely belongs to the layout rather than to the component.
 */
function layoutBars(segments: Segment[], totalSeconds: number, maxSpeed: number) {
  const bars: { i: number; x: number; w: number; h: number; seg: Segment }[] = [];
  let x = 0;
  for (const [i, seg] of segments.entries()) {
    const w = (seg.seconds / totalSeconds) * VW;
    const speed = seg.kind === "work" ? 1000 / seg.rep.paceSecPerKm : 0;
    const h =
      seg.kind === "work" ? Math.max(MIN_BAR, (speed / maxSpeed) * (H - TOP)) : MIN_BAR;
    bars.push({ i, x, w, h, seg });
    x += w;
  }
  return bars;
}

export function RepChart({ set }: { set: RepSet }) {
  const reps = set.reps;
  if (reps.length === 0) return null;

  // Every rep plus the recovery that followed it, on one time axis.
  const segments: Segment[] = reps.flatMap((r) => [
    { kind: "work" as const, seconds: r.seconds, rep: r },
    ...(r.recoverySeconds
      ? [{ kind: "rest" as const, seconds: r.recoverySeconds, rep: r }]
      : []),
  ]);
  const totalSeconds = segments.reduce((s, x) => s + x.seconds, 0) || 1;

  const speeds = reps.map((r) => (r.paceSecPerKm > 0 ? 1000 / r.paceSecPerKm : 0));
  const maxSpeed = Math.max(...speeds, 0.1);

  const hrs = reps.flatMap((r) => (r.avgHr ? [r.avgHr] : []));
  const hasHr = hrs.length === reps.length && hrs.length > 0;
  // Rounded: Strava reports lap heart rate to a decimal, and "176.6 bpm"
  // implies a precision a chest strap does not have.
  const hrMin = hasHr ? Math.round(Math.min(...hrs)) : 0;
  const hrMax = hasHr ? Math.round(Math.max(...hrs)) : 1;
  // Pad the HR scale so a set with almost no drift draws a level row of dots
  // rather than a misleading full-height swing.
  const hrSpan = Math.max(hrMax - hrMin, 8);
  const hrY = (bpm: number) => TOP - 8 - ((bpm - hrMin) / hrSpan) * (TOP - 16);

  const bars = layoutBars(segments, totalSeconds, maxSpeed);

  return (
    <div>
      <svg
        viewBox={`0 0 ${VW} ${H}`}
        preserveAspectRatio="none"
        className="h-[120px] w-full"
        role="img"
        aria-label={`${set.label}: ${reps.map((r) => paceLabel(r.paceSecPerKm)).join(", ")}`}
      >
        {bars.map(({ i, x, w, h, seg }) => (
          <g key={i}>
            <rect
              x={x + 1}
              y={H - h}
              width={Math.max(1, w - 2)}
              height={h}
              rx={2}
              fill={seg.kind === "work" ? "var(--accent)" : "var(--zone-1)"}
              fillOpacity={seg.kind === "work" ? 1 : 0.45}
            />
            {/* Work bars carry a bright cap as well as a different hue, so the
                work/rest distinction survives without colour. */}
            {seg.kind === "work" && (
              <rect
                x={x + 1}
                y={H - h}
                width={Math.max(1, w - 2)}
                height={2}
                fill="var(--accent-hover)"
              />
            )}
          </g>
        ))}

        {hasHr &&
          bars
            .filter((b) => b.seg.kind === "work")
            .map(({ i, x, w, seg }) => (
              <circle
                key={`hr-${i}`}
                cx={x + w / 2}
                cy={hrY(seg.rep.avgHr!)}
                r={3}
                fill="var(--err)"
                stroke="var(--card)"
                strokeWidth={1.5}
              />
            ))}
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-data text-[11px] text-gray-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm" style={{ background: "var(--accent)" }} aria-hidden />
          Rep
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-2 w-3 rounded-sm opacity-45"
            style={{ background: "var(--zone-1)" }}
            aria-hidden
          />
          Recovery
        </span>
        {hasHr && (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: "var(--err)" }}
              aria-hidden
            />
            Heart rate {hrMin}–{hrMax} bpm
          </span>
        )}
        <span className="text-gray-600">height = speed · width = time</span>
      </div>
    </div>
  );
}

/** The same set as numbers — the only form rendered on a narrow screen. */
export function RepTable({ set }: { set: RepSet }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[320px] font-data text-[11px]">
        <thead>
          <tr className="text-left uppercase tracking-wider text-gray-600">
            <th className="py-1 pr-3 font-normal">Rep</th>
            <th className="py-1 pr-3 font-normal">Dist</th>
            <th className="py-1 pr-3 font-normal">Time</th>
            <th className="py-1 pr-3 font-normal">Pace</th>
            <th className="py-1 pr-3 font-normal">HR</th>
            <th className="py-1 font-normal">Rest</th>
          </tr>
        </thead>
        <tbody className="text-gray-400">
          {set.reps.map((r) => (
            <tr key={r.index} className="border-t border-gray-800">
              <td className="py-1 pr-3 tabular-nums">{r.index}</td>
              <td className="py-1 pr-3 tabular-nums">{r.meters} m</td>
              <td className="py-1 pr-3 tabular-nums">{formatSecondsAsClock(r.seconds)}</td>
              <td className="py-1 pr-3 tabular-nums text-gray-200">
                {paceLabel(r.paceSecPerKm)}
              </td>
              <td className="py-1 pr-3 tabular-nums">{r.avgHr?.toFixed(0) ?? "—"}</td>
              <td className="py-1 tabular-nums">
                {r.recoverySeconds ? formatSecondsAsClock(r.recoverySeconds) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
