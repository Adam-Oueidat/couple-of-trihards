"use client";

import type { Dispatch, SetStateAction } from "react";
import { SESSION_TYPES, type SessionType } from "@trihards/core";
import { DisciplineGlyph } from "../DisciplineGlyph";
import { DISCIPLINE_PILL } from "../discipline-pill";

export interface EditSessionFormState {
  sessionId: string;
  originalDate: string;
  date: string;
  name: string;
  type: SessionType;
  km: number;
  skipped: boolean;
  skipReason: string;
  base: { name: string; type: SessionType; km: number } | null;
}

interface Props {
  editSessionForm: EditSessionFormState;
  setEditSessionForm: Dispatch<SetStateAction<EditSessionFormState | null>>;
  editSessionSaving: boolean;
  editSessionError: string | null;
  planDiscipline: "swim" | "ride" | "run";
  hasSessionEdits: boolean;
  onSave: () => void;
  onRemove: () => void;
  onResetToPlan: () => void;
}

/**
 * "Plan session" dialog: move it, edit its base fields, skip it, remove it, or
 * reset it. Skip and Remove are deliberately different doors — skipping keeps
 * the session on the calendar with the athlete's reason attached, removing
 * takes it out of the plan altogether — so skip lives in the form (it is a
 * property of the session, saved with everything else) while Remove stays a
 * destructive action off to the side.
 */
export function EditSessionModal({
  editSessionForm,
  setEditSessionForm,
  editSessionSaving,
  editSessionError,
  planDiscipline,
  hasSessionEdits,
  onSave,
  onRemove,
  onResetToPlan,
}: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={() => setEditSessionForm(null)}
        className="absolute inset-0 bg-black/70 cursor-default"
      />
      <div className="relative bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md p-7">
        <button
          type="button"
          aria-label="Close"
          onClick={() => setEditSessionForm(null)}
          className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:text-white hover:bg-gray-800 text-xl leading-none transition-colors cursor-pointer"
        >
          ×
        </button>
        <h3 className="text-white font-bold mb-1 pr-8">Plan session</h3>
        <p className="text-gray-500 text-xs mb-5">
          Adjust this session to what you actually intend to do. Your changes
          layer on top of the plan, so reset puts it back.
        </p>

        <div className="space-y-4">
          <div className="flex items-center gap-2 bg-gray-950/60 border border-gray-800 rounded-lg px-3 py-2">
            <DisciplineGlyph
              discipline={planDiscipline}
              size={14}
              className="flex-shrink-0"
            />
            <span className="text-xs text-gray-500 flex-1 truncate">
              {editSessionForm.base
                ? `Plan: ${editSessionForm.base.km}km ${editSessionForm.base.name}`
                : "Plan session"}
            </span>
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide flex-shrink-0 ${DISCIPLINE_PILL[planDiscipline]}`}
            >
              {editSessionForm.type.replace("_", " ")}
            </span>
          </div>

          <div>
            <label htmlFor="session-name" className="block text-xs text-gray-500 mb-1">
              Name
            </label>
            <input
              id="session-name"
              value={editSessionForm.name}
              onChange={(e) =>
                setEditSessionForm({ ...editSessionForm, name: e.target.value })
              }
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="session-type" className="block text-xs text-gray-500 mb-1">
                Type
              </label>
              <select
                id="session-type"
                value={editSessionForm.type}
                onChange={(e) =>
                  setEditSessionForm({
                    ...editSessionForm,
                    type: e.target.value as SessionType,
                  })
                }
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500 cursor-pointer"
              >
                {SESSION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace("_", " ")}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="session-km" className="block text-xs text-gray-500 mb-1">
                Distance (km)
              </label>
              <input
                id="session-km"
                value={editSessionForm.km}
                onChange={(e) =>
                  setEditSessionForm({
                    ...editSessionForm,
                    km: e.target.value === "" ? 0 : Number(e.target.value),
                  })
                }
                type="number"
                min={0}
                step="0.1"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500"
              />
            </div>
          </div>

          <div>
            <label htmlFor="session-date" className="block text-xs text-gray-500 mb-1">
              Date
            </label>
            <input
              id="session-date"
              value={editSessionForm.date}
              onChange={(e) =>
                setEditSessionForm({ ...editSessionForm, date: e.target.value })
              }
              type="date"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-orange-500 [color-scheme:dark]"
            />
          </div>

          <div className="rounded-lg border border-dashed border-gray-700 bg-gray-950/40 p-3">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={editSessionForm.skipped}
                onChange={(e) =>
                  setEditSessionForm({
                    ...editSessionForm,
                    skipped: e.target.checked,
                  })
                }
                className="w-4 h-4 accent-orange-500 cursor-pointer"
              />
              <span className="text-sm text-gray-300">Skip this session</span>
            </label>
            <p className="text-gray-500 text-xs mt-1.5 ml-6">
              It stays on your calendar, marked as skipped. Your coach reads the
              reason and adapts the week around it.
            </p>

            {editSessionForm.skipped && (
              <div className="mt-3">
                <label
                  htmlFor="session-skip-reason"
                  className="block text-xs text-gray-500 mb-1"
                >
                  Reason (optional)
                </label>
                <textarea
                  id="session-skip-reason"
                  rows={2}
                  maxLength={300}
                  value={editSessionForm.skipReason}
                  onChange={(e) =>
                    setEditSessionForm({
                      ...editSessionForm,
                      skipReason: e.target.value,
                    })
                  }
                  placeholder="Calf was tight, swapped for a swim, work travel..."
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-orange-500 resize-none"
                />
              </div>
            )}
          </div>

          {editSessionError && <p className="text-red-400 text-xs">{editSessionError}</p>}

          <div className="flex items-center justify-between gap-3 pt-3">
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={onRemove}
                disabled={editSessionSaving}
                className="text-sm font-medium text-red-400 hover:text-red-300 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Remove
              </button>
              {hasSessionEdits && (
                <button
                  type="button"
                  onClick={onResetToPlan}
                  disabled={editSessionSaving}
                  className="text-sm font-medium text-gray-400 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Reset to plan
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={onSave}
              disabled={editSessionSaving}
              className="px-8 py-2.5 rounded-lg bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors cursor-pointer"
            >
              {editSessionSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
