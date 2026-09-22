"use client";

import type { Insight, InsightTone } from "@trihards/core";

/**
 * Small pieces shared by the two recap panels.
 *
 * They live together so the block recap and the plan recap keep one visual
 * vocabulary: a reader who learns what a delta arrow or a tone stripe means on
 * one panel should not have to relearn it on the other.
 */

export const TONE_VAR: Record<InsightTone, string> = {
  ok: "var(--ok)",
  accent: "var(--accent)",
  warn: "var(--warn)",
  err: "var(--err)",
};

/**
 * A definition attached to a label, revealed on hover or keyboard focus.
 *
 * Several figures here are real sports-science measures whose names do not
 * explain themselves — "aerobic efficiency" means nothing until someone tells
 * you it is speed per heartbeat. Rather than spend a line of the card on prose
 * nobody re-reads after the first time, the explanation hides behind a marker
 * and stays one hover away.
 *
 * Focusable and described through aria, so it is reachable by keyboard and read
 * out by a screen reader instead of being a mouse-only affordance. The marker
 * is drawn type, not an icon font or an emoji.
 */
export function InfoHint({
  text,
  align = "left",
}: {
  text: string;
  /** Flip to "right" in the last column, where a left-aligned panel would
   *  overflow the card — which clips it, since the card hides overflow. */
  align?: "left" | "right";
}) {
  return (
    <span className="group relative ml-1 inline-flex align-middle">
      <span
        tabIndex={0}
        role="note"
        aria-label={text}
        className="flex h-[13px] w-[13px] cursor-help items-center justify-center rounded-full border border-gray-700 text-[9px] font-semibold leading-none text-gray-500 transition-colors hover:border-gray-500 hover:text-gray-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
      >
        i
      </span>
      <span
        aria-hidden
        className={`pointer-events-none absolute top-full z-20 mt-2 w-max max-w-[240px] rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-[12px] font-normal normal-case leading-snug tracking-normal text-gray-300 opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none ${
          align === "right" ? "right-0" : "left-0"
        }`}
      >
        {text}
      </span>
    </span>
  );
}

/** One measured figure with its label and an optional line of context. */
export function Readout({
  label,
  value,
  unit,
  note,
  tone,
  hint,
  hintAlign,
}: {
  label: string;
  value: string;
  unit?: string;
  note?: React.ReactNode;
  tone?: InsightTone;
  /** Plain-language definition, shown on hover or focus of the label. */
  hint?: string;
  hintAlign?: "left" | "right";
}) {
  return (
    <div className="min-w-0">
      <div className="font-data text-[10px] uppercase tracking-wider text-gray-600">
        {label}
        {hint && <InfoHint text={hint} align={hintAlign} />}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span
          className="font-display text-[28px] font-semibold leading-none tabular-nums truncate"
          style={{ color: tone ? TONE_VAR[tone] : "var(--text-primary)" }}
        >
          {value}
        </span>
        {unit && <span className="font-data text-xs text-gray-500">{unit}</span>}
      </div>
      {note && (
        <div className="mt-1.5 font-data text-[11px] leading-tight text-gray-500">
          {note}
        </div>
      )}
    </div>
  );
}

/**
 * A change against the previous block.
 *
 * Direction is carried by the arrow and the word, not by color alone — "down
 * 14%" is not automatically bad (it is what a recovery block looks like), so
 * painting it red would be the chart lying about what it knows.
 */
export function Delta({ pct, suffix }: { pct: number | null; suffix: string }) {
  if (pct === null) return <span className="text-gray-600">no earlier block</span>;
  if (pct === 0) return <span>level {suffix}</span>;
  return (
    <span>
      {pct > 0 ? "↑" : "↓"} {Math.abs(pct)}% {suffix}
    </span>
  );
}

/** Percentage change, or null when there is nothing to compare against. */
export function pctChange(now: number, before: number): number | null {
  if (before <= 0) return null;
  return Math.round(((now - before) / before) * 100);
}

/**
 * A horizontal proportion bar: a track with a filled portion.
 *
 * Used for "how much of what was asked for actually happened", which is the
 * same question in the type breakdown and in the adherence ribbon.
 */
export function MeterBar({
  fraction,
  color,
  title,
}: {
  fraction: number;
  color: string;
  title?: string;
}) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full"
      style={{ background: "var(--inset)" }}
      title={title}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}

/**
 * The findings, as a list.
 *
 * Each one leads with a tone stripe and a verdict, then the evidence. The
 * verdict is what gets read; the evidence is what makes it checkable against
 * the numbers directly above it, which is the whole reason these are computed
 * from rules rather than written by a model.
 */
export function Reads({ insights }: { insights: Insight[] }) {
  if (insights.length === 0) return null;
  return (
    <div className="space-y-2.5">
      {insights.map((insight) => (
        <div key={insight.id} className="flex gap-3">
          <span
            className="mt-[3px] w-[3px] flex-shrink-0 rounded-full"
            style={{ background: TONE_VAR[insight.tone] }}
            aria-hidden
          />
          <div className="min-w-0">
            <p
              className="font-display text-[15px] font-semibold leading-snug"
              style={{ color: TONE_VAR[insight.tone] }}
            >
              {insight.headline}
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-gray-500">
              {insight.detail}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

/** A hairline rule between zones of a dense card. */
export function Rule({ className = "" }: { className?: string }) {
  return <div className={`h-px bg-gray-800 ${className}`} aria-hidden />;
}
