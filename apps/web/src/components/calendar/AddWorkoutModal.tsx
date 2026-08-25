"use client";

import type { Dispatch, SetStateAction } from "react";
import { DisciplineGlyph } from "../DisciplineGlyph";
import { DISCIPLINE_PILL } from "../discipline-pill";

export interface AddFormState {
  date: string;
  discipline: "swim" | "ride" | "run";
  name: string;
  distanceKm: string;
  durationMin: string;
}

interface Props {
  form: AddFormState;
  setForm: Dispatch<SetStateAction<AddFormState | null>>;
  saving: boolean;
  error: string | null;
  onSubmit: () => void;
}

/**
 * "Add workout" dialog. Purely presentational — the parent owns the form state
 * and the request, because the calendar re-renders from the same workouts list
 * the submit writes to.
 */
export function AddWorkoutModal({ form, setForm, saving, error, onSubmit }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={() => setForm(null)}
        className="absolute inset-0 bg-black/70 cursor-default"
      />
      <div className="relative bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-sm p-6">
        <h3 className="text-white font-bold mb-4">
          Add workout ·{" "}
          {new Date(form.date + "T12:00:00").toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}
        </h3>

        <div className="space-y-3">
          <div className="flex gap-2">
            {(["swim", "ride", "run"] as const).map((d) => (
              <button
                type="button"
                key={d}
                onClick={() => setForm({ ...form, discipline: d })}
                className={`flex-1 py-1.5 rounded-full text-xs font-semibold border capitalize transition-colors cursor-pointer inline-flex items-center justify-center gap-1.5 ${
                  form.discipline === d
                    ? DISCIPLINE_PILL[d]
                    : "border-gray-700 text-gray-500"
                }`}
              >
                <DisciplineGlyph discipline={d} size={12} />
                {d}
              </button>
            ))}
          </div>

          {/* On desktop the date comes from the day cell you clicked; the
              agenda has no cell to click for an empty day, so phones get
              the field. Hidden at `sm` and up. */}
          <div className="sm:hidden">
            <label htmlFor="add-workout-date" className="block text-xs text-gray-500 mb-1">
              Date
            </label>
            <input
              id="add-workout-date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              type="date"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500 [color-scheme:dark]"
            />
          </div>

          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            aria-label="Workout name"
            placeholder="Workout name"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
          />

          <div className="flex gap-2">
            <input
              value={form.distanceKm}
              onChange={(e) => setForm({ ...form, distanceKm: e.target.value })}
              aria-label="Distance in kilometers"
              placeholder="Distance (km)"
              type="number"
              min="0"
              step="any"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0"
            />
            <input
              value={form.durationMin}
              onChange={(e) => setForm({ ...form, durationMin: e.target.value })}
              aria-label="Duration in minutes"
              placeholder="Duration (min)"
              type="number"
              min="0"
              step="any"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0"
            />
          </div>

          {error && <p className="text-red-400 text-xs">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => setForm(null)}
              className="flex-1 py-2 rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 text-sm transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSubmit}
              disabled={saving || !form.name.trim()}
              className="flex-1 py-2 rounded-lg bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors cursor-pointer"
            >
              {saving ? "Saving..." : "Add"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
