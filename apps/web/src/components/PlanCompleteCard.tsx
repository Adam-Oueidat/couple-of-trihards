"use client";

import { racePhase, type PlanAdherence, type TrainingPlan } from "@trihards/core";

const DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function weeksBetween(start: string, end: string): number {
  const ms =
    new Date(end + "T12:00:00").getTime() - new Date(start + "T12:00:00").getTime();
  return Math.max(1, Math.round(ms / (7 * 24 * 3600 * 1000)));
}

/** Which of the card's detail views is open, if any. */
export type PlanDetailView = "none" | "all" | "notDone";

interface Props {
  plan: TrainingPlan;
  adherence: PlanAdherence;
  view: PlanDetailView;
  onViewChange: (view: PlanDetailView) => void;
  onUploadNew?: () => void;
}

/**
 * What the Plan tab leads with once the race has been run.
 *
 * Before this existed the tab had no notion of a plan ending: every session
 * was in the past, so nothing was "today" or "upcoming" and the week selector
 * fell back to week one — the athlete opened a finished plan and saw its
 * oldest week, all of it red, under a pill claiming the race was in 0 days.
 *
 * Leading with the outcome puts the useful summary first and makes the wall of
 * individual days opt-in rather than the default view.
 */
export function PlanCompleteCard({
  plan,
  adherence,
  view,
  onViewChange,
  onUploadNew,
}: Props) {
  const phase = racePhase(plan);
  const when =
    phase.state === "complete"
      ? phase.days === 1
        ? "Raced yesterday"
        : `Raced ${phase.days} days ago`
      : "Race day";

  // Partials count as done here on purpose: the headline answers "did I do the
  // session", and the per-session rows carry the finer grading for anyone who
  // opens them.
  const done = adherence.completed + adherence.partial;
  // Exactly what the list below renders — a miss or a deliberate skip — rather
  // than `total - done`. On a finished plan the two are equal, but only
  // because nothing is still pending; counting the same things the list counts
  // means the button cannot promise a number the list then fails to show.
  const notDone = adherence.missed + adherence.skipped;
  const weeks = weeksBetween(plan.startDate, plan.raceDate);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <span className="font-display uppercase tracking-[0.2em] text-[13px] leading-none text-gray-400">
            Plan complete
          </span>
          <h3 className="font-display text-2xl uppercase tracking-wide text-white leading-tight mt-3 truncate">
            {plan.raceName}
          </h3>
          <p className="text-gray-500 text-xs mt-1">
            {DATE_FMT.format(new Date(plan.raceDate + "T12:00:00"))} · {weeks}-week plan
          </p>
        </div>
        <span className="inline-flex items-center rounded-full border border-gray-700 bg-gray-800 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          {when}
        </span>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-6 max-w-sm">
        <div>
          <div className="font-display text-3xl text-white leading-none">
            {done}
            <span className="text-gray-600">/{adherence.total}</span>
          </div>
          <div className="text-gray-500 text-[11px] uppercase tracking-wider mt-1.5">
            Sessions done
          </div>
        </div>
        <div>
          <div className="font-display text-3xl text-white leading-none">
            {Math.round(adherence.actualKm)}
            <span className="text-gray-600">/{Math.round(adherence.plannedKm)}</span>
          </div>
          <div className="text-gray-500 text-[11px] uppercase tracking-wider mt-1.5">
            km actual / planned
          </div>
        </div>
      </div>

      {adherence.skipped > 0 && (
        <p className="text-gray-500 text-xs mt-4">
          {adherence.skipped} session{adherence.skipped === 1 ? "" : "s"} skipped
          deliberately, counted apart from missed.
        </p>
      )}

      <div className="flex items-center gap-3 mt-6 flex-wrap">
        {notDone > 0 && (
          <button
            type="button"
            onClick={() => onViewChange(view === "notDone" ? "none" : "notDone")}
            aria-expanded={view === "notDone"}
            className="cursor-pointer rounded-full border border-red-500/40 bg-red-500/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-red-300 transition-colors hover:border-red-500/70 hover:bg-red-500/20"
          >
            {view === "notDone" ? "Hide not done" : `Show ${notDone} not done`}
          </button>
        )}
        <button
          type="button"
          onClick={() => onViewChange(view === "all" ? "none" : "all")}
          aria-expanded={view === "all"}
          className="cursor-pointer rounded-full border border-gray-700 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-gray-300 transition-colors hover:border-gray-600 hover:text-white"
        >
          {view === "all" ? "Hide sessions" : `Show all ${adherence.total} sessions`}
        </button>
        {onUploadNew && (
          <button
            type="button"
            onClick={onUploadNew}
            className="cursor-pointer rounded-full border border-orange-500/40 bg-orange-500/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-orange-300 transition-colors hover:border-orange-500 hover:bg-orange-500/20"
          >
            Upload your next plan
          </button>
        )}
      </div>
    </div>
  );
}
