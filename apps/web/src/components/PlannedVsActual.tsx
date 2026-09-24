"use client";

import { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { StravaActivity } from "@trihards/core";
import {
  plannedVsActualByWeek,
  matchSessions,
  planAdherence,
  findMisdatedSessions,
  isPlanComplete,
} from "@trihards/core";
import type { TrainingPlan } from "@trihards/core";
import { formatDuration, getWeekStart } from "@trihards/core";
import type { PlanEdits } from "./usePlanEdits";
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

function formatWeekLabel(weekStart: string): string {
  const d = new Date(weekStart);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatWeekRange(weekStart: string): string {
  const start = new Date(weekStart + "T12:00:00");
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

export function PlannedVsActual({ activities, plan, edits, onUploadNew }: Props) {
  const { overrides, workouts } = edits;

  const weeks = useMemo(
    () => plannedVsActualByWeek(plan, activities, overrides, undefined, workouts),
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

  const currentWeekStart = getWeekStart(new Date());
  const foundCurrent = weeks.findIndex((w) => w.weekStart === currentWeekStart);
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
  const foundIdx = selectedWeek
    ? weeks.findIndex((w) => w.weekStart === selectedWeek)
    : -1;
  const selectedIdx = foundIdx >= 0 ? foundIdx : currentIdx;
  const selectWeek = (idx: number) =>
    setSelectedWeek(weeks[idx]?.weekStart ?? null);
  const selected = weeks[selectedIdx];
  const planWeekNumber = selectedIdx + 1;
  const isCurrent = selected?.weekStart === currentWeekStart;

  const selectedSessions = useMemo(
    () =>
      selected
        ? allSessions.filter(
            (s) =>
              getWeekStart(new Date(s.date + "T12:00:00")) === selected.weekStart
          )
        : [],
    [allSessions, selected]
  );

  // A multi-sport plan's km do not add up to anything (a ride's dwarf a
  // swim's), so it is charted in hours; a single-sport plan keeps its km.
  const byTime = plan?.discipline === "multi";
  const hours = (min: number) => Math.round((min / 60) * 10) / 10;
  const chartData = weeks.map((w, i) => ({
    weekStart: w.weekStart,
    week: formatWeekLabel(w.weekStart),
    Planned: byTime ? hours(w.plannedMin) : w.plannedKm,
    Actual: w.isFuture ? null : byTime ? hours(w.actualMin) : w.actualKm,
    isFuture: w.isFuture,
    isSelected: i === selectedIdx,
  }));

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
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
            Planned vs actual
          </h2>
          <span className="text-xs text-gray-600">{weeks.length} weeks</span>
        </div>

        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chartData} margin={{ top: 0, right: 0, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
            <XAxis dataKey="week" tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} unit={byTime ? "h" : "km"} />
            <Tooltip
              contentStyle={{
                backgroundColor: "#1f2937",
                border: "1px solid #374151",
                borderRadius: "8px",
                fontSize: "13px",
              }}
              labelStyle={{ color: "#9ca3af" }}
              cursor={false}
            />
            <Legend
              wrapperStyle={{ paddingTop: "12px", fontSize: "12px" }}
              formatter={(value) => <span style={{ color: "#d1d5db" }}>{value}</span>}
            />
            <Bar
              dataKey="Planned"
              radius={[3, 3, 0, 0]}
              onClick={(_, i) => selectWeek(i)}
              style={{ cursor: "pointer" }}
            >
              {chartData.map((d) => (
                <Cell
                  key={d.weekStart}
                  fill={
                    d.isSelected
                      ? "#f97316"
                      : d.isFuture
                        ? "#9ca3af55"
                        : "#9ca3af"
                  }
                />
              ))}
            </Bar>
            <Bar
              dataKey="Actual"
              fill="#4ade80"
              radius={[3, 3, 0, 0]}
              onClick={(_, i) => selectWeek(i)}
              style={{ cursor: "pointer" }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
              Week {planWeekNumber} of {weeks.length}
              {isCurrent && (
                <span className="ml-2 text-orange-400 normal-case tracking-normal">
                  · this week
                </span>
              )}
            </h2>
            {selected && (
              <p className="text-gray-500 text-xs mt-0.5">
                {formatWeekRange(selected.weekStart)} ·{" "}
                {byTime ? (
                  <>
                    {formatDuration(selected.plannedMin)} planned
                    {!selected.isFuture && ` · ${formatDuration(selected.actualMin)} actual`}
                  </>
                ) : (
                  <>
                    {selected.plannedKm.toFixed(1)} km planned
                    {!selected.isFuture && ` · ${selected.actualKm.toFixed(1)} km actual`}
                  </>
                )}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => selectWeek(Math.max(0, selectedIdx - 1))}
              disabled={selectedIdx === 0}
              aria-label="Previous week"
              className="px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-500 disabled:opacity-30 disabled:cursor-not-allowed text-gray-300 text-sm transition-colors cursor-pointer"
            >
              ←
            </button>
            {!isCurrent && (
              <button
                type="button"
                onClick={() => setSelectedWeek(null)}
                className="px-3 py-1.5 rounded-lg border border-orange-500/40 hover:border-orange-500 text-orange-400 text-xs font-semibold transition-colors cursor-pointer"
              >
                Today
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                selectWeek(Math.min(weeks.length - 1, selectedIdx + 1))
              }
              disabled={selectedIdx === weeks.length - 1}
              aria-label="Next week"
              className="px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-500 disabled:opacity-30 disabled:cursor-not-allowed text-gray-300 text-sm transition-colors cursor-pointer"
            >
              →
            </button>
          </div>
        </div>

        {selectedSessions.length === 0 ? (
          <p className="text-gray-500 text-sm">No planned sessions this week.</p>
        ) : (
          <div className="space-y-2">
            {selectedSessions.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
