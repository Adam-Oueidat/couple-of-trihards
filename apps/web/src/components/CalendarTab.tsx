"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { StravaActivity } from "@trihards/core";
import { getDiscipline } from "@trihards/core";
import {
  plan,
  applyPlanOverrides,
  type PlannedSession,
  type SessionType,
} from "@trihards/core";
import type { PlanOverrideMap } from "@trihards/core";
import type { CustomWorkout } from "@/lib/workouts";
import { DisciplineGlyph } from "./DisciplineGlyph";

interface Props {
  activities: StravaActivity[];
}

const DISCIPLINE_PILL: Record<string, string> = {
  run: "bg-green-500/15 text-green-400 border-green-500/30",
  ride: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  swim: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
};

const DRAG_MIME = "application/x-trihard";

type DragPayload =
  | { kind: "plan"; sessionId: string; originalDate: string; currentDate: string }
  | { kind: "custom"; id: string; currentDate: string };

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthGrid(year: number, month: number): Date[][] {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  const day = start.getDay();
  start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));

  const weeks: Date[][] = [];
  const cursor = new Date(start);
  while (cursor <= new Date(year, month + 1, 0) || weeks.length === 0) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

interface AddFormState {
  date: string;
  discipline: "swim" | "ride" | "run";
  name: string;
  distanceKm: string;
  durationMin: string;
}

interface EditWorkoutFormState {
  id: string;
  date: string;
  discipline: "swim" | "ride" | "run";
  name: string;
  distanceKm: string;
  durationMin: string;
  notes?: string;
  addedBy: "athlete" | "coach";
}

interface EditSessionFormState {
  sessionId: string;
  originalDate: string;
  date: string;
  name: string;
  type: SessionType;
  km: number;
}

export function CalendarTab({ activities }: Props) {
  const [viewDate, setViewDate] = useState(() => new Date());
  const [workouts, setWorkouts] = useState<CustomWorkout[]>([]);
  const [overrides, setOverrides] = useState<PlanOverrideMap>({});
  const [form, setForm] = useState<AddFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOverDate, setDragOverDate] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [editWorkoutForm, setEditWorkoutForm] = useState<EditWorkoutFormState | null>(null);
  const [editWorkoutSaving, setEditWorkoutSaving] = useState(false);
  const [editWorkoutError, setEditWorkoutError] = useState<string | null>(null);
  const [editSessionForm, setEditSessionForm] = useState<EditSessionFormState | null>(null);
  const [editSessionSaving, setEditSessionSaving] = useState(false);
  const [editSessionError, setEditSessionError] = useState<string | null>(null);

  const loadWorkouts = useCallback(async () => {
    try {
      const res = await fetch("/api/workouts");
      if (res.ok) setWorkouts(await res.json());
    } catch {
      // non-fatal
    }
  }, []);

  const loadOverrides = useCallback(async () => {
    try {
      const res = await fetch("/api/plan-overrides");
      if (res.ok) setOverrides(await res.json());
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.all([loadWorkouts(), loadOverrides()]);
    })();
  }, [loadWorkouts, loadOverrides]);

  // Close any open modal on Escape.
  useEffect(() => {
    if (!form && !editWorkoutForm && !editSessionForm) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setForm(null);
        setEditWorkoutForm(null);
        setEditSessionForm(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [form, editWorkoutForm, editSessionForm]);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const weeks = monthGrid(year, month);
  const today = toDateStr(new Date());

  // Apply overrides to plan sessions to get current scheduled dates
  const planSessions = useMemo(
    () => applyPlanOverrides(plan.sessions, overrides),
    [overrides]
  );

  const planByDate = new Map<string, PlannedSession[]>();
  for (const s of planSessions) {
    if (s.hidden) continue;
    const list = planByDate.get(s.date) ?? [];
    list.push(s);
    planByDate.set(s.date, list);
  }

  const workoutsByDate = new Map<string, CustomWorkout[]>();
  for (const w of workouts) {
    const list = workoutsByDate.get(w.date) ?? [];
    list.push(w);
    workoutsByDate.set(w.date, list);
  }

  const doneByDate = new Map<string, Set<string>>();
  for (const act of activities) {
    const day = act.start_date_local.split("T")[0];
    const set = doneByDate.get(day) ?? new Set();
    set.add(getDiscipline(act));
    doneByDate.set(day, set);
  }

  async function submitWorkout() {
    if (!form || !form.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/workouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: form.date,
          discipline: form.discipline,
          name: form.name.trim(),
          distanceKm: form.distanceKm ? Number(form.distanceKm) : undefined,
          durationMin: form.durationMin ? Number(form.durationMin) : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to save");
      }
      setForm(null);
      await loadWorkouts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function removeWorkout(id: string) {
    await fetch(`/api/workouts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadWorkouts();
  }

  // Drag-and-drop: rescheduling sessions and custom workouts
  function onDragStart(e: React.DragEvent, payload: DragPayload) {
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "move";
    setDraggingId(
      payload.kind === "plan" ? `plan:${payload.sessionId}` : `custom:${payload.id}`
    );
  }

  function onDragEnd() {
    setDraggingId(null);
    setDragOverDate(null);
  }

  function onDayDragOver(e: React.DragEvent, dateStr: string) {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverDate !== dateStr) setDragOverDate(dateStr);
  }

  function onDayDragLeave(dateStr: string) {
    if (dragOverDate === dateStr) setDragOverDate(null);
  }

  async function onDayDrop(e: React.DragEvent, dateStr: string) {
    e.preventDefault();
    setDragOverDate(null);
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    let payload: DragPayload;
    try {
      payload = JSON.parse(raw) as DragPayload;
    } catch {
      return;
    }
    if (payload.kind === "plan") {
      if (payload.currentDate === dateStr) return;
      // Optimistic update
      setOverrides((prev) => ({
        ...prev,
        [payload.sessionId]: {
          sessionId: payload.sessionId,
          originalDate: payload.originalDate,
          newDate: dateStr,
          movedAt: new Date().toISOString(),
        },
      }));
      try {
        await fetch("/api/plan-overrides", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: payload.sessionId,
            originalDate: payload.originalDate,
            newDate: dateStr,
          }),
        });
        await loadOverrides();
      } catch {
        await loadOverrides();
      }
    } else if (payload.kind === "custom") {
      if (payload.currentDate === dateStr) return;
      // Optimistic update
      setWorkouts((prev) =>
        prev.map((w) => (w.id === payload.id ? { ...w, date: dateStr } : w))
      );
      try {
        await fetch("/api/workouts", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: payload.id, date: dateStr }),
        });
        await loadWorkouts();
      } catch {
        await loadWorkouts();
      }
    }
  }

  async function resetMove(sessionId: string) {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    await fetch(`/api/plan-overrides?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    await loadOverrides();
  }

  // Custom workout edit modal
  function openWorkoutEditor(w: CustomWorkout) {
    setEditWorkoutForm({
      id: w.id,
      date: w.date,
      discipline: w.discipline,
      name: w.name,
      distanceKm: w.distanceKm != null ? String(w.distanceKm) : "",
      durationMin: w.durationMin != null ? String(w.durationMin) : "",
      notes: w.notes ?? undefined,
      addedBy: w.addedBy,
    });
    setEditWorkoutError(null);
  }

  async function saveWorkoutEdit() {
    if (!editWorkoutForm || !editWorkoutForm.name.trim()) return;
    setEditWorkoutSaving(true);
    setEditWorkoutError(null);
    try {
      const res = await fetch("/api/workouts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editWorkoutForm.id,
          discipline: editWorkoutForm.discipline,
          name: editWorkoutForm.name.trim(),
          distanceKm: editWorkoutForm.distanceKm ? Number(editWorkoutForm.distanceKm) : null,
          durationMin: editWorkoutForm.durationMin ? Number(editWorkoutForm.durationMin) : null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to save");
      }
      setEditWorkoutForm(null);
      await loadWorkouts();
    } catch (err) {
      setEditWorkoutError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setEditWorkoutSaving(false);
    }
  }

  async function deleteWorkoutEdit() {
    if (!editWorkoutForm) return;
    setEditWorkoutSaving(true);
    try {
      await removeWorkout(editWorkoutForm.id);
      setEditWorkoutForm(null);
    } finally {
      setEditWorkoutSaving(false);
    }
  }

  // Plan session edit modal
  function openSessionEditor(s: PlannedSession) {
    setEditSessionForm({
      sessionId: s.id,
      originalDate: s.originalDate,
      date: s.date,
      name: s.name,
      type: s.type,
      km: s.km,
    });
    setEditSessionError(null);
  }

  async function saveSessionDate() {
    if (!editSessionForm) return;
    setEditSessionSaving(true);
    setEditSessionError(null);
    try {
      const res = await fetch("/api/plan-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: editSessionForm.sessionId,
          originalDate: editSessionForm.originalDate,
          newDate: editSessionForm.date,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to save");
      }
      setEditSessionForm(null);
      await loadOverrides();
    } catch (err) {
      setEditSessionError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setEditSessionSaving(false);
    }
  }

  async function hideSession() {
    if (!editSessionForm) return;
    setEditSessionSaving(true);
    setEditSessionError(null);
    try {
      const res = await fetch("/api/plan-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: editSessionForm.sessionId,
          originalDate: editSessionForm.originalDate,
          newDate: editSessionForm.date,
          hidden: true,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to remove");
      }
      setEditSessionForm(null);
      await loadOverrides();
    } catch (err) {
      setEditSessionError(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setEditSessionSaving(false);
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Training Calendar
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setViewDate(new Date(year, month - 1, 1))}
            className="px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 text-sm transition-colors cursor-pointer"
          >
            ←
          </button>
          <span className="text-white font-semibold text-sm w-36 text-center">
            {viewDate.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </span>
          <button
            type="button"
            onClick={() => setViewDate(new Date(year, month + 1, 1))}
            className="px-3 py-1.5 rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 text-sm transition-colors cursor-pointer"
          >
            →
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px text-center text-xs text-gray-500 mb-1">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="py-1">
            {d}
          </div>
        ))}
      </div>

      <div className="space-y-px">
        {weeks.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7 gap-px">
            {week.map((day) => {
              const dateStr = toDateStr(day);
              const inMonth = day.getMonth() === month;
              const isToday = dateStr === today;
              const isDropTarget = dragOverDate === dateStr;
              const sessions = planByDate.get(dateStr) ?? [];
              const custom = workoutsByDate.get(dateStr) ?? [];
              const done = doneByDate.get(dateStr);

              return (
                <div
                  key={dateStr}
                  onDragOver={(e) => onDayDragOver(e, dateStr)}
                  onDragLeave={() => onDayDragLeave(dateStr)}
                  onDrop={(e) => onDayDrop(e, dateStr)}
                  className={`min-h-24 p-1.5 rounded-md border group transition-colors ${
                    isDropTarget
                      ? "border-orange-500 bg-orange-500/10"
                      : isToday
                        ? "border-orange-500/60 bg-orange-500/5"
                        : "border-gray-800 bg-gray-950/40"
                  } ${inMonth ? "" : "opacity-40"}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span
                      className={`text-xs ${
                        isToday ? "text-orange-400 font-bold" : "text-gray-500"
                      }`}
                    >
                      {day.getDate()}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setForm({
                          date: dateStr,
                          discipline: "swim",
                          name: "",
                          distanceKm: "",
                          durationMin: "",
                        })
                      }
                      title="Add workout"
                      className="text-gray-600 hover:text-orange-400 text-xs opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer px-1"
                    >
                      +
                    </button>
                  </div>

                  <div className="space-y-1">
                    {sessions.map((s) => {
                      const moved = s.movedFrom !== undefined;
                      const dragId = `plan:${s.id}`;
                      return (
                        <div
                          key={s.id}
                          draggable
                          role="button"
                          tabIndex={0}
                          onClick={() => openSessionEditor(s)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              openSessionEditor(s);
                            }
                          }}
                          onDragStart={(e) =>
                            onDragStart(e, {
                              kind: "plan",
                              sessionId: s.id,
                              originalDate: s.originalDate,
                              currentDate: s.date,
                            })
                          }
                          onDragEnd={onDragEnd}
                          title={
                            `${s.name} (${s.km}km, ${s.type})` +
                            (moved ? ` — moved from ${s.movedFrom}` : "") +
                            "\nClick to edit · Drag to reschedule"
                          }
                          className={`px-1.5 py-0.5 rounded border text-[10px] leading-tight flex items-center gap-1 cursor-pointer ${
                            DISCIPLINE_PILL.run
                          } ${
                            done?.has("run") && s.date <= today
                              ? ""
                              : s.date < today
                                ? "opacity-50 line-through"
                                : ""
                          } ${draggingId === dragId ? "opacity-30" : ""} ${
                            moved ? "ring-1 ring-orange-500/40" : ""
                          }`}
                        >
                          <DisciplineGlyph discipline="run" size={10} className="flex-shrink-0 opacity-80" />
                          <span className="truncate flex-1">
                            {s.km}km {s.name}
                          </span>
                          {moved && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                resetMove(s.id);
                              }}
                              title={`Reset to ${s.movedFrom}`}
                              className="opacity-0 group-hover:opacity-100 hover:text-white transition-opacity cursor-pointer flex-shrink-0"
                            >
                              ↺
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {custom.map((w) => {
                      const dragId = `custom:${w.id}`;
                      return (
                        <div
                          key={w.id}
                          draggable
                          role="button"
                          tabIndex={0}
                          onClick={() => openWorkoutEditor(w)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              openWorkoutEditor(w);
                            }
                          }}
                          onDragStart={(e) =>
                            onDragStart(e, {
                              kind: "custom",
                              id: w.id,
                              currentDate: w.date,
                            })
                          }
                          onDragEnd={onDragEnd}
                          title={`${w.name}${w.notes ? ` — ${w.notes}` : ""} (added by ${w.addedBy})\nClick to edit · Drag to reschedule`}
                          className={`px-1.5 py-0.5 rounded border text-[10px] leading-tight flex items-center gap-1 cursor-pointer ${
                            DISCIPLINE_PILL[w.discipline]
                          } ${draggingId === dragId ? "opacity-30" : ""}`}
                        >
                          <DisciplineGlyph discipline={w.discipline} size={10} className="flex-shrink-0 opacity-80" />
                          <span className="truncate flex-1">
                            {w.distanceKm
                              ? `${w.distanceKm}km `
                              : w.durationMin
                                ? `${w.durationMin}min `
                                : ""}
                            {w.name}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeWorkout(w.id);
                            }}
                            title="Remove"
                            className="opacity-0 group-hover:opacity-100 hover:text-white transition-opacity cursor-pointer flex-shrink-0"
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <p className="text-gray-600 text-xs mt-3">
        Drag any session to a different day to reschedule. Moved sessions get an
        orange ring; hover and click ↺ to reset to the original plan date. The
        coach sees every move so it can adapt advice.
      </p>

      {form && (
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
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
                />
                <input
                  value={form.durationMin}
                  onChange={(e) => setForm({ ...form, durationMin: e.target.value })}
                  aria-label="Duration in minutes"
                  placeholder="Duration (min)"
                  type="number"
                  min="0"
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
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
                  onClick={submitWorkout}
                  disabled={saving || !form.name.trim()}
                  className="flex-1 py-2 rounded-lg bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors cursor-pointer"
                >
                  {saving ? "Saving..." : "Add"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editWorkoutForm && (
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
                  onClick={deleteWorkoutEdit}
                  disabled={editWorkoutSaving}
                  className="text-sm font-medium text-red-400 hover:text-red-300 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={saveWorkoutEdit}
                  disabled={editWorkoutSaving || !editWorkoutForm.name.trim()}
                  className="px-8 py-2.5 rounded-lg bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors cursor-pointer"
                >
                  {editWorkoutSaving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editSessionForm && (
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
              Prescribed by the training plan — name, type, and distance are fixed.
            </p>

            <div className="space-y-4">
              <div className="flex items-center gap-2 bg-gray-950/60 border border-gray-800 rounded-lg px-3 py-2">
                <DisciplineGlyph discipline="run" size={14} className="text-green-400 flex-shrink-0" />
                <span className="text-sm text-white flex-1 truncate">
                  {editSessionForm.km}km {editSessionForm.name}
                </span>
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide flex-shrink-0 ${DISCIPLINE_PILL.run}`}
                >
                  {editSessionForm.type.replace("_", " ")}
                </span>
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

              {editSessionError && <p className="text-red-400 text-xs">{editSessionError}</p>}

              <div className="flex items-center justify-between pt-3">
                <button
                  type="button"
                  onClick={hideSession}
                  disabled={editSessionSaving}
                  className="text-sm font-medium text-red-400 hover:text-red-300 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Remove
                </button>
                <button
                  type="button"
                  onClick={saveSessionDate}
                  disabled={editSessionSaving}
                  className="px-8 py-2.5 rounded-lg bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors cursor-pointer"
                >
                  {editSessionSaving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
