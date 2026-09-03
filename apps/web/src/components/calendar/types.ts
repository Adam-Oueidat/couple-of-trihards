import type { Dispatch, SetStateAction } from "react";
import type { PlannedSession } from "@trihards/core";
import type { CustomWorkout } from "@/lib/workouts";
import type { AddFormState } from "./AddWorkoutModal";

/**
 * The actions a day cell can trigger, in the grid and the agenda alike.
 * Grouped into one object so the two views share a single contract instead of
 * repeating six props each.
 */
export interface CalendarDayActions {
  planDiscipline: "swim" | "ride" | "run";
  setForm: Dispatch<SetStateAction<AddFormState | null>>;
  openSessionEditor: (s: PlannedSession) => void;
  openWorkoutEditor: (w: CustomWorkout) => void;
  removeWorkout: (id: string) => void;
  resetMove: (sessionId: string) => void;
}

/**
 * A session the athlete marked skipped. It keeps its place in the calendar —
 * that is the whole point of skipping rather than removing — so it drops the
 * discipline colour and takes a dashed outline instead: still there, plainly
 * not happening. Shared by the grid and the agenda so both read the same.
 */
export const SKIPPED_CHIP =
  "bg-gray-500/10 text-gray-500 border-dashed border-gray-600";

export const SKIPPED_BADGE =
  "inline-flex items-center rounded-full border border-dashed border-gray-600 text-gray-400 uppercase tracking-wide flex-shrink-0";
