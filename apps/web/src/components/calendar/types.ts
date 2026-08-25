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
