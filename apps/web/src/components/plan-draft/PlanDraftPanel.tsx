"use client";

import { useMemo, useState } from "react";
import useSWR, { mutate } from "swr";
import {
  buildTrainingPlan,
  formatDuration,
  type DraftWeekStats,
  type PlannedSession,
  type TrainingDiscipline,
  type TrainingPlan,
} from "@trihards/core";
import { fetcher } from "@/lib/fetcher";
import type { DraftView } from "@/lib/plan-drafts";
import type { PlanSummary } from "@/lib/training-plans";
import { DisciplineGlyph } from "../DisciplineGlyph";
import { DISCIPLINE_PILL } from "../discipline-pill";
import { sessionLabel } from "../calendar/session-label";
import { DRAFTS_KEY } from "./CreatePlanDialog";

/** Fixed order, so a sport keeps its place and colour whatever the plan holds. */
const SPORTS: TrainingDiscipline[] = ["swim", "ride", "run", "strength"];
const SPORT_LABEL: Record<TrainingDiscipline, string> = { swim: "Swim", ride: "Ride", run: "Run", strength: "Strength" };
const SPORT_COLOR: Record<TrainingDiscipline, string> = {
  swim: "var(--swim)",
  ride: "var(--ride)",
  run: "var(--run)",
  strength: "var(--strength)",
};

const DAY_FMT = new Intl.DateTimeFormat("en-GB", { weekday: "short" });
const DATE_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const LONG_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const fmt = (iso: string, f = DATE_FMT) => f.format(new Date(`${iso}T12:00:00`));

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The coach's draft, from "building" to a preview the athlete saves or throws
 * away. Polls while the plan is being written, since that runs in the
 * background and can take a few minutes.
 */
export function PlanDraftPanel({
  onPlanChange,
  onStartOver,
}: {
  onPlanChange: (plan: TrainingPlan | null, summary: PlanSummary | null) => void;
  onStartOver: () => void;
}) {
  const { data: draft } = useSWR<DraftView | null>(DRAFTS_KEY, fetcher, {
    revalidateOnFocus: false,
    refreshInterval: (d) => (d?.status === "pending" ? 5000 : 0),
  });
  const [busy, setBusy] = useState<"save" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!draft) return null;

  async function act(action: "save" | "discard") {
    if (!draft) return;
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`${DRAFTS_KEY}/${draft.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      if (action === "save") onPlanChange(data.plan ?? null, data.summary ?? null);
      await mutate(DRAFTS_KEY, null, { revalidate: false });
      if (action === "discard") onStartOver();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  if (draft.status === "pending") {
    return (
      <section className="rounded-[14px] border border-orange-500/25 bg-gray-900 p-6" aria-live="polite">
        <p className="font-data text-[11px] uppercase tracking-[0.14em] text-orange-500">Draft · being written</p>
        <p className="mt-2 font-display text-2xl font-bold uppercase leading-tight tracking-wide text-white">
          &ldquo;{draft.request.prompt}&rdquo;
        </p>
        <p className="mt-2 text-sm text-gray-400">
          Your coach is building this from your training. A long plan takes a few minutes; you can leave this page and
          come back.
        </p>
        <div className="mt-4 h-1.5 overflow-hidden rounded-[3px] bg-gray-800">
          <div className="h-full w-1/3 animate-pulse rounded-[3px] bg-orange-500/70" />
        </div>
      </section>
    );
  }

  if (draft.status === "failed" || !draft.result) {
    return (
      <section className="rounded-[14px] border border-[var(--err)]/40 bg-gray-900 p-6" role="alert">
        <p className="font-data text-[11px] uppercase tracking-[0.14em] text-[var(--err)]">Draft · not built</p>
        <p className="mt-2 text-sm text-gray-300">{draft.error ?? "The coach couldn't build this plan."}</p>
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={() => act("discard")} disabled={busy !== null} className="cursor-pointer rounded-[10px] bg-orange-500 px-4 py-2 text-sm font-semibold text-[var(--accent-fg)] hover:bg-orange-400 disabled:opacity-50">
            Try again
          </button>
        </div>
      </section>
    );
  }

  return <DraftPreview draft={draft} busy={busy} error={error} onSave={() => act("save")} onDiscard={() => act("discard")} />;
}

function DraftPreview({
  draft,
  busy,
  error,
  onSave,
  onDiscard,
}: {
  draft: DraftView;
  busy: "save" | "discard" | null;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const result = draft.result!;
  const { plan: raw, stats, phases, why, assumptions, weekFocus } = result;
  const plan = useMemo(() => buildTrainingPlan(raw), [raw]);
  const [weekIdx, setWeekIdx] = useState(0);
  const hasRace = raw.raceName !== "";
  const total = phases.reduce((s, p) => s + p.weeks, 0);

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-data text-[11px] uppercase tracking-[0.14em] text-orange-500">Draft · not saved</p>
          <h2 className="mt-1.5 font-display text-4xl font-bold uppercase leading-none tracking-wide text-white">{raw.name}</h2>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onDiscard} disabled={busy !== null} className="cursor-pointer rounded-[10px] border border-gray-700 px-4 py-2 text-sm font-semibold text-gray-300 hover:border-gray-600 disabled:opacity-50">
            {busy === "discard" ? "…" : "Start over"}
          </button>
          <button type="button" onClick={onSave} disabled={busy !== null} className="cursor-pointer rounded-[10px] bg-orange-500 px-4 py-2 text-sm font-semibold text-[var(--accent-fg)] hover:bg-orange-400 disabled:opacity-50">
            {busy === "save" ? "Saving…" : "Save as my plan"}
          </button>
        </div>
      </div>
      {error && <p className="text-sm text-[var(--err)]" role="alert">{error}</p>}

      <div className="grid overflow-hidden rounded-[14px] border border-gray-800 bg-gray-900 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 p-5 sm:p-6">
          <p className="font-data text-[11px] uppercase tracking-[0.14em] text-gray-500">
            {stats.weeks.length} weeks · {fmt(raw.startDate, LONG_FMT)} → {fmt(raw.raceDate, LONG_FMT)}
            {hasRace ? ` · ${raw.raceName}` : " · no race"}
          </p>
          <dl className="mt-4 flex flex-wrap gap-x-7 gap-y-3">
            <Stat label="Fitness (CTL)" value={`${stats.ctlStart} → ${stats.ctlPeak}`} />
            <Stat label="Weekly hours" value={`${stats.hoursMin} → ${stats.hoursMax}`} />
            <Stat label={hasRace ? "Form on race day" : "Form at the end"} value={`${stats.formEnd > 0 ? "+" : ""}${stats.formEnd}`} />
            <Stat label="Recovery weeks" value={`${stats.recoveryWeeks}`} />
          </dl>
          <div className="mt-5 flex gap-[3px]" aria-label="Phases">
            {phases.map((p, i) => (
              <div
                key={`${p.name}-${i}`}
                className="min-w-0 truncate rounded-[6px] px-2 py-1.5 font-display text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--accent-fg)]"
                style={{ flex: p.weeks, background: `color-mix(in srgb, var(--accent) ${40 + Math.round((i / Math.max(phases.length - 1, 1)) * 60)}%, var(--card))` }}
                title={`${p.name}: ${p.weeks} week${p.weeks === 1 ? "" : "s"} from ${fmt(p.startDate)}`}
              >
                {p.name}
                {p.weeks / total > 0.12 ? ` · ${p.weeks} wks` : ""}
              </div>
            ))}
          </div>
          <WeeklyHoursChart weeks={stats.weeks} selected={weekIdx} onSelect={setWeekIdx} />
          <FitnessChart points={stats.ctl} />
        </div>
        <div className="flex flex-col gap-3 border-t border-gray-800 bg-gray-950/60 p-5 sm:p-6 lg:border-l lg:border-t-0">
          <p className="font-data text-[11px] uppercase tracking-[0.14em] text-orange-500">Why this plan</p>
          <p className="text-[15px] leading-relaxed text-gray-200">{why}</p>
          {assumptions.length > 0 && (
            <>
              <p className="mt-2 font-data text-[11px] uppercase tracking-[0.14em] text-gray-500">Assumptions to check</p>
              <ul className="list-disc space-y-1.5 pl-5 text-[13px] text-gray-300">
                {assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </>
          )}
          {draft.result!.dropped > 0 && (
            <p className="text-[12px] text-gray-500">
              {draft.result!.dropped} session{draft.result!.dropped === 1 ? "" : "s"} fell on days you can&apos;t train or outside the plan&apos;s dates and were left out.
            </p>
          )}
        </div>
      </div>

      <WeekBrowser plan={plan} weeks={stats.weeks} focus={weekFocus} index={weekIdx} onIndex={setWeekIdx} />
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dd className="font-data text-xl text-white">{value}</dd>
      <dt className="font-data text-[10px] uppercase tracking-[0.12em] text-gray-500">{label}</dt>
    </div>
  );
}

const CHART_W = 700;
const HOURS_H = 150;

/** Weekly planned hours, stacked by sport. Click a week to open it below. */
function WeeklyHoursChart({
  weeks,
  selected,
  onSelect,
}: {
  weeks: DraftWeekStats[];
  selected: number;
  onSelect: (i: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const maxH = Math.max(1, ...weeks.map((w) => w.totalMin / 60));
  const top = Math.ceil(maxH / 2) * 2;
  const slot = CHART_W / weeks.length;
  const bar = Math.max(3, slot - 3);
  const y = (h: number) => HOURS_H - (h / top) * HOURS_H;
  const shown = hover ?? null;

  return (
    <figure className="relative mt-5">
      <figcaption className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span className="font-data text-[11px] uppercase tracking-[0.12em] text-gray-500">Weekly hours</span>
        <span className="flex flex-wrap gap-3 font-data text-[11px] text-gray-400">
          {SPORTS.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: SPORT_COLOR[s] }} aria-hidden />
              {SPORT_LABEL[s]}
            </span>
          ))}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${CHART_W} ${HOURS_H + 16}`} className="w-full" role="img" aria-label={`Weekly planned hours, ${weeks.length} weeks, peaking at ${maxH.toFixed(1)} hours`} onMouseLeave={() => setHover(null)}>
        {[0, top / 2, top].map((h) => (
          <g key={h}>
            <line x1={0} x2={CHART_W} y1={y(h)} y2={y(h)} stroke="var(--chart-grid)" strokeWidth={1} strokeDasharray={h === 0 ? undefined : "3 4"} />
            {h > 0 && <text x={2} y={y(h) - 3} fontSize={10} fill="var(--text-muted)" fontFamily="var(--font-geist-mono)">{h}h</text>}
          </g>
        ))}
        {weeks.map((w, i) => {
          const x = i * slot + (slot - bar) / 2;
          let base = 0;
          const active = i === selected || i === hover;
          return (
            <g key={w.weekStart} opacity={hover === null || active ? 1 : 0.55}>
              {SPORTS.map((s) => {
                const h = w.minutes[s] / 60;
                if (h <= 0) return null;
                const y0 = y(base + h);
                const height = Math.max(0, (h / top) * HOURS_H - 2); // 2px surface gap
                base += h;
                return <rect key={s} x={x} y={y0} width={bar} height={height} rx={1.5} fill={SPORT_COLOR[s]} />;
              })}
              {i === selected && <rect x={x - 1} y={HOURS_H + 4} width={bar + 2} height={3} rx={1.5} fill="var(--accent)" />}
              {/* Hit target: the whole column, taller and wider than the bars. */}
              <rect
                x={i * slot}
                y={0}
                width={slot}
                height={HOURS_H + 16}
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => setHover(i)}
                onClick={() => onSelect(i)}
              >
                <title>{`Week ${i + 1}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      {shown !== null && weeks[shown] && (
        <div
          className="pointer-events-none absolute top-6 z-10 w-44 -translate-x-1/2 rounded-[10px] border border-gray-700 bg-gray-900 p-2.5 font-data text-[11px] shadow-xl"
          style={{ left: `${Math.min(88, Math.max(12, ((shown + 0.5) / weeks.length) * 100))}%` }}
        >
          <p className="text-gray-400">
            Week {shown + 1} · {weeks[shown].phase}
          </p>
          <p className="mb-1 text-white">{formatDuration(weeks[shown].totalMin)}{weeks[shown].recovery ? " · recovery" : ""}</p>
          {SPORTS.filter((s) => weeks[shown].minutes[s] > 0).map((s) => (
            <p key={s} className="flex justify-between text-gray-300">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-[2px]" style={{ background: SPORT_COLOR[s] }} aria-hidden />
                {SPORT_LABEL[s]}
              </span>
              {formatDuration(weeks[shown].minutes[s])}
            </p>
          ))}
        </div>
      )}
    </figure>
  );
}

const FIT_H = 70;

/** Projected fitness if the plan is trained as written. Its own chart: a second scale never shares an axis. */
function FitnessChart({ points }: { points: { date: string; ctl: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return null;
  const max = Math.max(...points.map((p) => p.ctl));
  const min = Math.min(...points.map((p) => p.ctl));
  const pad = Math.max(5, (max - min) * 0.15);
  const lo = Math.max(0, min - pad);
  const hi = max + pad;
  const x = (i: number) => (i / (points.length - 1)) * CHART_W;
  const y = (v: number) => FIT_H - ((v - lo) / (hi - lo)) * FIT_H;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.ctl).toFixed(1)}`).join(" ");
  const h = hover !== null ? points[hover] : null;

  return (
    <figure className="relative mt-4">
      <figcaption className="mb-1 font-data text-[11px] uppercase tracking-[0.12em] text-gray-500">Projected fitness (CTL)</figcaption>
      <svg
        viewBox={`0 0 ${CHART_W} ${FIT_H}`}
        className="w-full"
        role="img"
        aria-label={`Projected fitness from ${Math.round(points[0].ctl)} to a peak of ${Math.round(max)}`}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.round(((e.clientX - r.left) / r.width) * (points.length - 1)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <line x1={0} x2={CHART_W} y1={FIT_H - 0.5} y2={FIT_H - 0.5} stroke="var(--chart-grid)" />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={0} y2={FIT_H} stroke="var(--text-faint)" strokeWidth={1} />
            <circle cx={x(hover)} cy={y(points[hover].ctl)} r={4} fill="var(--accent)" stroke="var(--card)" strokeWidth={2} />
          </>
        )}
      </svg>
      {h && hover !== null && (
        <div
          className="pointer-events-none absolute -top-1 rounded-[8px] border border-gray-700 bg-gray-900 px-2 py-1 font-data text-[11px] text-gray-200 shadow-xl"
          style={{ left: `${Math.min(85, Math.max(0, (hover / (points.length - 1)) * 100 - 6))}%` }}
        >
          {fmt(h.date)} · CTL {Math.round(h.ctl)}
        </div>
      )}
    </figure>
  );
}

/** One plan week, a row per day with that day's sessions side by side. */
function WeekBrowser({
  plan,
  weeks,
  focus,
  index,
  onIndex,
}: {
  plan: TrainingPlan;
  weeks: DraftWeekStats[];
  focus: string[];
  index: number;
  onIndex: (i: number) => void;
}) {
  const week = weeks[index];
  if (!week) return null;
  const byDay = new Map<string, PlannedSession[]>();
  for (const s of plan.sessions) {
    if (s.date < week.weekStart || s.date > addDays(week.weekStart, 6)) continue;
    byDay.set(s.date, [...(byDay.get(s.date) ?? []), s]);
  }
  const days = Array.from({ length: 7 }, (_, d) => addDays(week.weekStart, d));

  return (
    <section className="rounded-[14px] border border-gray-800 bg-gray-900 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-data text-[11px] uppercase tracking-[0.14em] text-gray-500">
            Week {index + 1} of {weeks.length} · {week.phase}
            {week.recovery ? " · recovery" : ""}
          </p>
          <p className="mt-1 font-display text-xl font-bold uppercase tracking-wide text-white">
            {fmt(week.weekStart)}–{fmt(addDays(week.weekStart, 6))} · {formatDuration(week.totalMin)}
          </p>
          {focus[index] && <p className="mt-1 text-sm text-gray-400">{focus[index]}</p>}
        </div>
        <div className="flex gap-1.5">
          <button type="button" aria-label="Previous week" disabled={index === 0} onClick={() => onIndex(index - 1)} className="cursor-pointer rounded-[8px] border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:border-gray-600 disabled:cursor-default disabled:opacity-30">←</button>
          <button type="button" aria-label="Next week" disabled={index === weeks.length - 1} onClick={() => onIndex(index + 1)} className="cursor-pointer rounded-[8px] border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:border-gray-600 disabled:cursor-default disabled:opacity-30">→</button>
        </div>
      </div>
      <div className="mt-4 overflow-hidden rounded-[10px] border border-gray-800">
        {days.map((day) => {
          const sessions = byDay.get(day) ?? [];
          const minutes = sessions.reduce((s, x) => s + (x.durationMin ?? 0), 0);
          return (
            <div key={day} className="grid grid-cols-[56px_minmax(0,1fr)_64px] items-center gap-3 border-t border-gray-800 px-3 py-2.5 first:border-t-0">
              <span className="font-data text-[12px] uppercase tracking-[0.08em] text-gray-500">{DAY_FMT.format(new Date(`${day}T12:00:00`))}</span>
              <div className="flex flex-wrap gap-1.5">
                {sessions.length === 0 ? (
                  <span className="text-[13px] text-gray-600">Rest</span>
                ) : (
                  sessions.map((s) => (
                    <span key={s.id} title={s.notes} className={`inline-flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1 text-[12px] ${DISCIPLINE_PILL[s.discipline]}`}>
                      <DisciplineGlyph discipline={s.discipline} size={11} />
                      <span className="font-semibold">{sessionLabel(s)}</span>
                    </span>
                  ))
                )}
              </div>
              <span className="text-right font-data text-[12px] text-gray-500">{minutes ? formatDuration(minutes) : "—"}</span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[12px] text-gray-500">Once saved, every session is on your calendar, where you can move, edit or skip it.</p>
    </section>
  );
}
