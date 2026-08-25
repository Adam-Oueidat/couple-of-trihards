"use client";

import type { Dispatch, SetStateAction } from "react";
import { DisciplineGlyph } from "../DisciplineGlyph";
import { DISCIPLINE_PILL } from "../discipline-pill";

export interface EditWorkoutFormState {
  id: string;
  date: string;
  discipline: "swim" | "ride" | "run";
  name: string;
  distanceKm: string;
  durationMin: string;
  notes?: string;
  addedBy: "athlete" | "coach";
}

interface Props {
  editWorkoutForm: EditWorkoutFormState;
  setEditWorkoutForm: Dispatch<SetStateAction<EditWorkoutFormState | null>>;
  editWorkoutSaving: boolean;
  editWorkoutError: string | null;
  onSave: () => void;
  onDelete: () => void;
}

/** "Edit workout" dialog. State and requests stay with the parent. */
export function EditWorkoutModal({
  editWorkoutForm,
  setEditWorkoutForm,
  editWorkoutSaving,
  editWorkoutError,
  onSave,
  onDelete,
}: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={() => setEditWorkoutForm(null)}
        className="absolute inset-0 bg-black/70 cursor-default"
      />
      <div className="relative bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md p-7">
        <button
          type="button"
          aria-label="Close"
          onClick={() => setEditWorkoutForm(null)}
          className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:text-white hover:bg-gray-800 text-xl leading-none transition-colors cursor-pointer"
        >
          ×
        </button>
        <h3 className="text-white font-bold mb-4 pr-8">
          Edit workout ·{" "}
          {new Date(editWorkoutForm.date + "T12:00:00").toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}
        </h3>

        <div className="space-y-4">
          {editWorkoutForm.notes && (
            <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-400 mb-1">
                {editWorkoutForm.addedBy === "coach" ? "Coach note" : "Note"}
              </p>
              <p className="text-sm text-gray-200 leading-snug whitespace-pre-line">
                {editWorkoutForm.notes}
              </p>
            </div>
          )}

          <div className="flex gap-2">
            {(["swim", "ride", "run"] as const).map((d) => (
              <button
                type="button"
                key={d}
                onClick={() => setEditWorkoutForm({ ...editWorkoutForm, discipline: d })}
                className={`flex-1 py-1.5 rounded-full text-xs font-semibold border capitalize transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5 ${
                  editWorkoutForm.discipline === d
                    ? DISCIPLINE_PILL[d]
                    : "border-gray-700 text-gray-500"
                }`}
              >
                <DisciplineGlyph discipline={d} size={12} />
                {d}
              </button>
            ))}
          </div>

          {/* Rescheduling a custom workout is a drag on desktop, and drag
              events never fire on touch — so phones get the date field
              instead. Hidden at `sm` and up, where the drag still works. */}
          <div className="sm:hidden">
            <label htmlFor="workout-date" className="block text-xs text-gray-500 mb-1">
              Date
            </label>
            <input
              id="workout-date"
              value={editWorkoutForm.date}
              onChange={(e) =>
                setEditWorkoutForm({ ...editWorkoutForm, date: e.target.value })
              }
              type="date"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500 [color-scheme:dark]"
            />
          </div>

          <input
            value={editWorkoutForm.name}
            onChange={(e) => setEditWorkoutForm({ ...editWorkoutForm, name: e.target.value })}
            aria-label="Workout name"
            placeholder="Workout name"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
          />

          <div className="flex gap-2">
            <input
              value={editWorkoutForm.distanceKm}
              onChange={(e) =>
                setEditWorkoutForm({ ...editWorkoutForm, distanceKm: e.target.value })
              }
              aria-label="Distance in kilometers"
              placeholder="Distance (km)"
              type="number"
              min="0"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
            />
            <input
              value={editWorkoutForm.durationMin}
              onChange={(e) =>
                setEditWorkoutForm({ ...editWorkoutForm, durationMin: e.target.value })
              }
              aria-label="Duration in minutes"
              placeholder="Duration (min)"
              type="number"
              min="0"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
            />
          </div>

          {editWorkoutError && <p className="text-red-400 text-xs">{editWorkoutError}</p>}

          <div className="flex items-center justify-between pt-3">
            <button
              type="button"
              onClick={onDelete}
              disabled={editWorkoutSaving}
              className="text-sm font-medium text-red-400 hover:text-red-300 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={editWorkoutSaving || !editWorkoutForm.name.trim()}
              className="px-8 py-2.5 rounded-lg bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors cursor-pointer"
            >
              {editWorkoutSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
