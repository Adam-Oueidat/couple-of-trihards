"use client";

import { useMemo, useState } from "react";
import {
  findMisdatedSessions,
  formatDuration,
  isPlanComplete,
  matchSessions,
  planAdherence,
  planWeeks,
  type PlanWeek,
  type SportWeek,
  type StravaActivity,
  type TrainingDiscipline,
  type TrainingPlan,
} from "@trihards/core";
import type { PlanEdits } from "./usePlanEdits";
import { DisciplineGlyph } from "./DisciplineGlyph";
import { PlanCompleteCard, type PlanDetailView } from "./PlanCompleteCard";
import { MissedSessions } from "./MissedSessions";
import { MisdatedReview } from "./MisdatedReview";
import { SessionRow } from "./SessionRow";

interface Props {
  activities: StravaActivity[];
  /**
   * The athlete's own plan, or null when they have not uploaded one. With no
   * plan the only planned work is the custom workouts they added themselves —
   * nothing is filled in from a shared default.
   */
  plan: TrainingPlan | null;
  /**
   * Moved/hidden sessions and the custom workouts added in the calendar (a
   * separate table, so they have to be merged in explicitly). Owned by the
   * dashboard shell and seeded from the server render, so the week list is
   * complete on the first paint rather than filling in after a fetch.
   */
  edits: PlanEdits;
  /** Opens the plan-upload dialog; offered on a finished plan. */
  onUploadNew?: () => void;
}

/** Fixed order, so a sport keeps its place and colour whatever the week holds. */
const SPORTS: TrainingDiscipline[] = ["swim", "ride", "run", "strength"];
const SPORT_LABEL: Record<TrainingDiscipline, string> = { swim: "Swim", ride: "Ride", run: "Run", strength: "Strength" };
const SPORT_COLOR: Record<TrainingDiscipline, string> = {
  swim: "var(--swim)",
  ride: "var(--ride)",
  run: "var(--run)",
  strength: "var(--strength)",
};

const DATE_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const fmt = (iso: string) => DATE_FMT.format(new Date(`${iso}T12:00:00`));

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * How the plan is measured. A single-sport plan is written in km and reads in
 * km, for its own sport. Anything else is compared in time: a ride's km dwarf a
 * swim's, so km summed across sports mean nothing.
 */
type Unit = { kind: "km"; sport: TrainingDiscipline } | { kind: "time" };

function unitFor(plan: TrainingPlan | null): Unit {
  const d = plan?.discipline;
  return d === "run" || d === "ride" || d === "swim" ? { kind: "km", sport: d } : { kind: "time" };
}

const planned = (t: SportWeek, u: Unit) => (u.kind === "km" ? t.plannedKm : t.plannedMin);
const due = (t: SportWeek, u: Unit) => (u.kind === "km" ? t.dueKm : t.dueMin);
const done = (t: SportWeek, u: Unit) => (u.kind === "km" ? t.doneKm : t.doneMin);
const extra = (t: SportWeek, u: Unit) => (u.kind === "km" ? t.extraKm : t.extraMin);
const amount = (v: number, u: Unit) => (u.kind === "km" ? `${v.toFixed(1)} km` : formatDuration(Math.round(v)));

/** The sports a chart or panel shows for the unit: just the plan's own in km. */
function sportsFor(week: PlanWeek, u: Unit): TrainingDiscipline[] {
  return SPORTS.filter((s) => (u.kind === "km" ? s === u.sport : true) && week.sports[s]);
}

/**
 * Planned vs actual, a week at a time. Every number comes from planWeeks, which
 * grades by the same rule as the session rows: training counts toward the plan
 * when it is the planned sport on the planned day, and anything else is shown
 * as extra rather than quietly filling the plan's bar.
 */
export function PlannedVsActual({ activities, plan, edits, onUploadNew }: Props) {
  const { overrides, workouts } = edits;

  const weeks = useMemo(
    () => planWeeks(plan, activities, overrides, undefined, workouts),
    [plan, activities, overrides, workouts]
  );
  const allSessions = useMemo(
    () => matchSessions(plan, activities, overrides, undefined, workouts),
    [plan, activities, overrides, workouts]
  );

  const complete = plan ? isPlanComplete(plan) : false;
  const adherence = useMemo(
    () => planAdherence(plan, activities, overrides, undefined, workouts),
    [plan, activities, overrides, workouts]
  );
  const misdated = useMemo(
    () => findMisdatedSessions(plan, activities, overrides, undefined, workouts),
    [plan, activities, overrides, workouts]
  );
  const [detailView, setDetailView] = useState<PlanDetailView>("none");
  const unit = unitFor(plan);

  const foundCurrent = weeks.findIndex((w) => w.isCurrentWeek);
  // Once the plan is over, "this week" is past its last week and the lookup
  // misses — which used to fall back to index 0 and open a finished plan on
  // its very first week. The last week (the race week) is the useful default.
  const currentIdx =
    foundCurrent >= 0 ? foundCurrent : complete ? Math.max(0, weeks.length - 1) : 0;

  // The selection is stored as a week start, not an index. The week list is
  // replaced wholesale when the athlete uploads a new plan, and is empty until
  // then for an athlete with no plan; an index would survive that and end up
  // pointing at the wrong week, or off the end of the list. A week that no
  // longer exists simply falls back to the current one.
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);
  const foundIdx = selectedWeek ? weeks.findIndex((w) => w.weekStart === selectedWeek) : -1;
  const selectedIdx = foundIdx >= 0 ? foundIdx : currentIdx;
  const selectWeek = (idx: number) => setSelectedWeek(weeks[idx]?.weekStart ?? null);
  const selected = weeks[selectedIdx];

  // Nothing planned at all: no uploaded plan and no custom workouts. Say so
  // rather than rendering an empty chart and a "Week 1 of 0" header.
  if (weeks.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
        <p className="text-gray-400 text-sm font-medium">Nothing planned yet</p>
        <p className="text-gray-600 text-xs mt-1">
          {plan
            ? "This plan has no sessions left to show."
            : "Upload a plan above, or add workouts on the calendar, and they will show up here."}
        </p>
      </div>
    );
  }

  // A finished plan leads with its outcome. The week chart and the session
  // rows are still one click away, but they stop being the first thing an
  // athlete sees after a race they have already run.
  if (complete && plan) {
    const card = (
      <PlanCompleteCard
        plan={plan}
        adherence={adherence}
        view={detailView}
        onViewChange={setDetailView}
        onUploadNew={onUploadNew}
      />
    );

    if (detailView === "none") return card;
    if (detailView === "notDone") {
      return (
        <div className="space-y-6">
          {card}
          <MisdatedReview candidates={misdated} edits={edits} />
          <MissedSessions sessions={allSessions} />
        </div>
      );
    }
  }

  return (
    <div className="space-y-6">
      {complete && plan && (
        <PlanCompleteCard
          plan={plan}
          adherence={adherence}
          view={detailView}
          onViewChange={setDetailView}
          onUploadNew={onUploadNew}
        />
      )}
      <section className="rounded-[14px] border border-gray-800 bg-gray-900 p-5">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-data text-[11px] uppercase tracking-[0.12em] text-gray-500">Planned vs actual</h2>
          <span className="font-data text-[11px] text-gray-500">
            {weeks.length} weeks · {unit.kind === "km" ? `${SPORT_LABEL[unit.sport].toLowerCase()} km` : "hours"}
          </span>
        </div>
        <WeekChart weeks={weeks} unit={unit} selected={selectedIdx} onSelect={selectWeek} />
        <Legend unit={unit} weeks={weeks} />
      </section>

      {selected && (
        <WeekPanel
          week={selected}
          index={selectedIdx}
          total={weeks.length}
          unit={unit}
          onPrev={() => selectWeek(Math.max(0, selectedIdx - 1))}
          onNext={() => selectWeek(Math.min(weeks.length - 1, selectedIdx + 1))}
          onToday={selected.isCurrentWeek || foundCurrent < 0 ? undefined : () => setSelectedWeek(null)}
        />
      )}
    </div>
  );
}

const CHART_W = 700;
const CHART_H = 150;

/**
 * One column per week: the plan as an outline, what was done toward it filled
 * in by sport, and extra training stacked above in a fainter tint. Future weeks
 * are the outline alone. Click a week to open it below.
 */
function WeekChart({
  weeks,
  unit,
  selected,
  onSelect,
}: {
  weeks: PlanWeek[];
  unit: Unit;
  selected: number;
  onSelect: (i: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const scale = (v: number) => (unit.kind === "km" ? v : v / 60);
  const totals = weeks.map((w) => {
    const sports = sportsFor(w, unit);
    const sum = (f: (t: SportWeek) => number) => sports.reduce((s, d) => s + f(w.sports[d]!), 0);
    return { sports, planned: sum((t) => planned(t, unit)), actual: sum((t) => done(t, unit) + extra(t, unit)) };
  });
  const max = Math.max(1, ...totals.map((t) => scale(Math.max(t.planned, t.actual))));
  const step = unit.kind === "km" ? (max > 60 ? 20 : 10) : max > 12 ? 4 : 2;
  const top = Math.ceil(max / step) * step;
  const slot = CHART_W / weeks.length;
  const bar = Math.max(3, Math.min(28, slot - 4));
  const y = (v: number) => CHART_H - (scale(v) / top) * CHART_H;
  const shown = hover ?? null;
  const tip = shown !== null ? weeks[shown] : null;

  return (
    <figure className="relative">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H + 16}`}
        className="w-full"
        role="img"
        aria-label={`Planned against done, ${weeks.length} weeks`}
        onMouseLeave={() => setHover(null)}
      >
        {[0, top / 2, top].map((h) => (
          <g key={h}>
            <line
              x1={0}
              x2={CHART_W}
              y1={CHART_H - (h / top) * CHART_H}
              y2={CHART_H - (h / top) * CHART_H}
              stroke="var(--chart-grid)"
              strokeWidth={1}
              strokeDasharray={h === 0 ? undefined : "3 4"}
            />
            {h > 0 && (
              <text x={2} y={CHART_H - (h / top) * CHART_H - 3} fontSize={10} fill="var(--text-muted)" fontFamily="var(--font-geist-mono)">
                {h}
                {unit.kind === "km" ? " km" : "h"}
              </text>
            )}
          </g>
        ))}
        {weeks.map((w, i) => {
          const x = i * slot + (slot - bar) / 2;
          const active = i === selected || i === hover;
          let base = 0;
          const segments: { key: string; v: number; color: string; faint?: boolean }[] = [];
          if (!w.isFuture) {
            for (const d of totals[i].sports) segments.push({ key: `${d}-done`, v: done(w.sports[d]!, unit), color: SPORT_COLOR[d] });
            for (const d of totals[i].sports) segments.push({ key: `${d}-extra`, v: extra(w.sports[d]!, unit), color: SPORT_COLOR[d], faint: true });
          }
          return (
            <g key={w.weekStart} opacity={hover === null || active ? 1 : 0.55}>
              {segments.map((s) => {
                if (s.v <= 0) return null;
                const y0 = y(base + s.v);
                const height = Math.max(0, (scale(s.v) / top) * CHART_H - 1.5);
                base += s.v;
                return <rect key={s.key} x={x} y={y0} width={bar} height={height} rx={1.5} fill={s.color} opacity={s.faint ? 0.35 : 1} />;
              })}
              {totals[i].planned > 0 && (
                <rect
                  x={x - 1}
                  y={y(totals[i].planned)}
                  width={bar + 2}
                  height={(scale(totals[i].planned) / top) * CHART_H}
                  rx={2}
                  fill="none"
                  stroke="var(--text-muted)"
                  strokeWidth={1}
                  strokeDasharray={w.isFuture ? "3 2" : undefined}
                />
              )}
              {i === selected && <rect x={x - 1} y={CHART_H + 5} width={bar + 2} height={3} rx={1.5} fill="var(--accent)" />}
              {w.isCurrentWeek && i !== selected && <circle cx={x + bar / 2} cy={CHART_H + 6.5} r={2} fill="var(--accent)" />}
              <rect
                x={i * slot}
                y={0}
                width={slot}
                height={CHART_H + 16}
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
      {tip && shown !== null && (
        <div
          className="pointer-events-none absolute top-2 z-10 w-48 -translate-x-1/2 rounded-[10px] border border-gray-700 bg-gray-900 p-2.5 font-data text-[11px] shadow-xl"
          style={{ left: `${Math.min(86, Math.max(14, ((shown + 0.5) / weeks.length) * 100))}%` }}
        >
          <p className="text-gray-400">
            Week {shown + 1} · {fmt(tip.weekStart)}
          </p>
          <p className="mb-1 text-white">
            {tip.isFuture
              ? `${amount(totals[shown].planned, unit)} planned`
              : `${amount(totals[shown].actual, unit)} of ${amount(totals[shown].planned, unit)}`}
          </p>
          {sportsFor(tip, unit).map((d) => {
            const t = tip.sports[d]!;
            return (
              <p key={d} className="flex justify-between gap-2 text-gray-300">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-[2px]" style={{ background: SPORT_COLOR[d] }} aria-hidden />
                  {SPORT_LABEL[d]}
                </span>
                {tip.isFuture ? amount(planned(t, unit), unit) : `${amount(done(t, unit) + extra(t, unit), unit)} / ${amount(planned(t, unit), unit)}`}
              </p>
            );
          })}
        </div>
      )}
    </figure>
  );
}

function Legend({ unit, weeks }: { unit: Unit; weeks: PlanWeek[] }) {
  const present = unit.kind === "km" ? [unit.sport] : SPORTS.filter((s) => weeks.some((w) => w.sports[s]));
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 font-data text-[11px] text-gray-400">
      {present.map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-[2px]" style={{ background: SPORT_COLOR[s] }} aria-hidden />
          {SPORT_LABEL[s]}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-2 rounded-[2px] border border-gray-500" aria-hidden />
        Planned
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-[2px] bg-gray-400 opacity-35" aria-hidden />
        Extra, not in the plan
      </span>
    </div>
  );
}

/**
 * The selected week: its sessions done and missed, each sport's progress
 * toward what the plan asks, and the sessions themselves. In the current week
 * a marker shows how much was due by today, so a Tuesday is not read as behind.
 */
function WeekPanel({
  week,
  index,
  total,
  unit,
  onPrev,
  onNext,
  onToday,
}: {
  week: PlanWeek;
  index: number;
  total: number;
  unit: Unit;
  onPrev: () => void;
  onNext: () => void;
  onToday?: () => void;
}) {
  const { counts } = week;
  const graded = counts.completed + counts.partial + counts.missed + counts.skipped;
  const summary = [
    graded > 0 && `${counts.completed} of ${graded} done${week.isCurrentWeek ? " so far" : ""}`,
    counts.partial > 0 && `${counts.partial} partial`,
    counts.missed > 0 && `${counts.missed} missed`,
    counts.skipped > 0 && `${counts.skipped} skipped`,
    counts.remaining > 0 && `${counts.remaining} to go`,
  ].filter(Boolean);
  const sports = SPORTS.filter((s) => week.sports[s]);

  return (
    <section className="rounded-[14px] border border-gray-800 bg-gray-900 p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-data text-[11px] uppercase tracking-[0.12em] text-gray-500">
            Week {index + 1} of {total}
            {week.isCurrentWeek && <span className="ml-2 normal-case tracking-normal text-orange-400">· this week</span>}
          </p>
          <p className="mt-1 font-display text-xl font-bold uppercase tracking-wide text-white">
            {fmt(week.weekStart)}–{fmt(addDays(week.weekStart, 6))}
          </p>
          {summary.length > 0 && <p className="mt-0.5 text-xs text-gray-500">{summary.join(" · ")}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onPrev}
            disabled={index === 0}
            aria-label="Previous week"
            className="cursor-pointer rounded-[8px] border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:border-gray-600 disabled:cursor-not-allowed disabled:opacity-30"
          >
            ←
          </button>
          {onToday && (
            <button
              type="button"
              onClick={onToday}
              className="cursor-pointer rounded-[8px] border border-orange-500/40 px-3 py-1.5 text-xs font-semibold text-orange-400 hover:border-orange-500"
            >
              This week
            </button>
          )}
          <button
            type="button"
            onClick={onNext}
            disabled={index === total - 1}
            aria-label="Next week"
            className="cursor-pointer rounded-[8px] border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:border-gray-600 disabled:cursor-not-allowed disabled:opacity-30"
          >
            →
          </button>
        </div>
      </div>

      {sports.length > 0 && (
        <div className="mb-5 space-y-3">
          {sports.map((d) => (
            <SportProgress key={d} sport={d} t={week.sports[d]!} week={week} unit={unit} />
          ))}
        </div>
      )}

      {week.sessions.length === 0 ? (
        <p className="text-sm text-gray-500">No planned sessions this week.</p>
      ) : (
        <div className="space-y-2">
          {week.sessions.map((s) => (
            <SessionRow key={s.id} session={s} />
          ))}
        </div>
      )}
    </section>
  );
}

/** One sport's bar: done toward the plan, extra beyond it, and (this week) where today's due line sits. */
function SportProgress({ sport, t, week, unit }: { sport: TrainingDiscipline; t: SportWeek; week: PlanWeek; unit: Unit }) {
  // A single-sport plan's other sports (custom workouts, cross-training) have no km target; they read in time.
  const u: Unit = unit.kind === "km" && unit.sport !== sport ? { kind: "time" } : unit;
  const p = planned(t, u);
  const dn = done(t, u);
  const ex = extra(t, u);
  const scaleTo = Math.max(p, dn + ex, 1e-9);
  const pct = (v: number) => `${Math.min(100, (v / scaleTo) * 100)}%`;
  // Only between the start and end of the bar: nothing due yet, or all of it, says nothing.
  const showDue = week.isCurrentWeek && due(t, u) > 0 && due(t, u) < p;
  const status = week.isFuture
    ? `${amount(p, u)} planned`
    : p > 0
      ? `${amount(dn, u)} of ${amount(p, u)}`
      : `${amount(ex, u)} · not planned`;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
        <span className="inline-flex items-center gap-2 text-gray-200">
          <DisciplineGlyph discipline={sport} size={13} />
          {SPORT_LABEL[sport]}
        </span>
        <span className="font-data text-[12px] text-gray-400">
          {status}
          {!week.isFuture && p > 0 && ex > 0 && <span className="text-gray-500"> · +{amount(ex, u)} extra</span>}
          {showDue && <span className="text-gray-500"> · {amount(due(t, u), u)} due so far</span>}
        </span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-[3px] bg-gray-800">
        {/* The plan as a lighter track; done and extra are laid over it. */}
        {p > 0 && <div className="absolute inset-y-0 left-0 rounded-[3px] bg-gray-700" style={{ width: pct(p) }} />}
        {!week.isFuture && (
          <>
            <div className="absolute inset-y-0 left-0 rounded-[3px]" style={{ width: pct(dn), background: SPORT_COLOR[sport] }} />
            <div
              className="absolute inset-y-0 rounded-[3px] opacity-35"
              style={{ left: pct(dn), width: pct(ex), background: SPORT_COLOR[sport] }}
            />
          </>
        )}
        {/* Where the plan ends, when training ran past it. */}
        {!week.isFuture && p > 0 && dn + ex > p && (
          <div className="absolute inset-y-0 w-[2px] bg-gray-200" style={{ left: `calc(${pct(p)} - 1px)` }} title="Planned" />
        )}
        {showDue && (
          <div className="absolute inset-y-[-2px] w-[2px] bg-orange-400" style={{ left: pct(due(t, u)) }} title="Due by today" />
        )}
      </div>
    </div>
  );
}
