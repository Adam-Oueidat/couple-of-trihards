"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { StravaActivity } from "@trihards/core";
import { getDiscipline } from "@trihards/core";
import {
  applyPlanOverrides,
  SESSION_TYPES,
  type PlannedSession,
  type SessionType,
  type TrainingPlan,
} from "@trihards/core";
import type { CustomWorkout } from "@/lib/workouts";
import type { PlanEdits } from "./usePlanEdits";
import { DisciplineGlyph } from "./DisciplineGlyph";
import { DISCIPLINE_PILL } from "./discipline-pill";

// Built once at module scope rather than per render: constructing an
// Intl formatter is the expensive part, and these options never vary.
// The locale stays pinned to en-US, so this is not a behaviour change.
const MONTH_TITLE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
});

const AGENDA_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
});

interface Props {
  activities: StravaActivity[];
  /**
   * The athlete's own plan, or null when they have not uploaded one. With no
   * plan the calendar shows only the workouts they added themselves — it never
   * borrows a plan from anywhere else.
   */
  plan: TrainingPlan | null;
  /**
   * Moved/hidden sessions and custom workouts, owned by the dashboard shell so
   * they outlive this component — the calendar unmounts on every tab switch,
   * and fetching them here on mount meant each visit painted the plan on its
   * original dates before snapping the moved sessions into place.
   */
  edits: PlanEdits;
}

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
  // What the plan itself prescribes, before any override. Kept so save can send
  // only the fields the athlete actually changed: storing a value identical to
  // the plan's would pin it, and a later re-upload that legitimately revises
  // that session would silently have no effect.
  base: { name: string; type: SessionType; km: number } | null;
}

export function CalendarTab({ activities, plan, edits }: Props) {
  const {
    overrides,
    workouts,
    setOverrides,
    setWorkouts,
    reloadOverrides: loadOverrides,
    reloadWorkouts: loadWorkouts,
  } = edits;
  const [viewDate, setViewDate] = useState(() => new Date());
  const [form, setForm] = useState<AddFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOverDate, setDragOverDate] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [editWorkoutForm, setEditWorkoutForm] = useState<EditWorkoutFormState | null>(null);
  const [editWorkoutSaving, setEditWorkoutSaving] = useState(false);
  const [editWorkoutError, setEditWorkoutError] = useState<string | null>(null);
  const [editSessionForm, setEditSessionForm] = useState<EditSessionFormState | null>(null);
  const [editSessionSaving, setEditSessionSaving] = useState(false);
  const [editSessionError, setEditSessionError] = useState<string | null>(null);

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

  // The plan prescribes a single discipline, so plan chips and their
  // completion check follow it rather than assuming every plan is a run plan.
  const planDiscipline: "swim" | "ride" | "run" =
    plan?.discipline === "ride" || plan?.discipline === "swim"
      ? plan.discipline
      : "run";

  // Apply overrides to plan sessions to get current scheduled dates
  const planSessions = useMemo(
    () => applyPlanOverrides(plan?.sessions ?? [], overrides),
    [plan, overrides]
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

  // Mobile agenda source: the viewed month's days that are worth listing —
  // anything with a planned session or a custom workout, plus today so there
  // is always somewhere to add one. Below `sm` this replaces the 7-column
  // grid, which gives each day ~48px on a phone.
  const agendaDays = weeks
    .flat()
    .filter((d) => d.getMonth() === month)
    .map((d) => {
      const dateStr = toDateStr(d);
      return {
        date: d,
        dateStr,
        sessions: planByDate.get(dateStr) ?? [],
        custom: workoutsByDate.get(dateStr) ?? [],
        done: doneByDate.get(dateStr),
      };
    })
    .filter(
      (d) => d.sessions.length > 0 || d.custom.length > 0 || d.dateStr === today
    );

  // Seed date for the mobile "add workout" button: today when it falls in the
  // month on screen, otherwise the first of that month.
  const agendaDefaultDate =
    new Date().getFullYear() === year && new Date().getMonth() === month
      ? today
      : toDateStr(new Date(year, month, 1));

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
    const id =
      payload.kind === "plan" ? `plan:${payload.sessionId}` : `custom:${payload.id}`;
    // Fade the source chip on the next tick rather than right now. `dragstart`
    // is a discrete event, so React flushes this update synchronously inside
    // the event dispatch — which finishes before the browser snapshots the
    // element to build the drag image. Setting `opacity-30` here bakes the
    // fade into that snapshot, so the chip under the cursor is greyed out for
    // the whole drag and stays greyed through the browser's drop animation.
    // A timeout (not requestAnimationFrame — browsers throttle rAF while a
    // native drag holds the main thread) runs after the snapshot is taken, so
    // the chip you drag stays solid and only the one left behind fades.
    dragFadeTimer.current = setTimeout(() => {
      dragFadeTimer.current = null;
      setDraggingId(id);
    }, 0);
  }

  function endDrag() {
    if (dragFadeTimer.current !== null) {
      clearTimeout(dragFadeTimer.current);
      dragFadeTimer.current = null;
    }
    setDraggingId(null);
    setDragOverDate(null);
  }

  // Safety net for the fade: a successful drop re-renders the chip into a
  // different day cell, unmounting the node being dragged, and browsers never
  // fire `dragend` on a node that has left the DOM. Watching the window clears
  // the drag state however the drag ended — including drags whose chip
  // disappears for reasons this component did not initiate.
  useEffect(() => {
    if (!draggingId) return;
    const clear = () => endDrag();
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [draggingId]);

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
    // Clear the drag state here rather than leaving it to onDragEnd: a
    // successful drop re-renders the chip into a different day cell, which
    // unmounts the element being dragged, and the browser never fires
    // `dragend` on a node that has left the DOM. Without this the chip stayed
    // stuck at opacity-30 — looking greyed out — until a later drag that
    // ended without a move let `dragend` through again.
    endDrag();
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
          date: editWorkoutForm.date,
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

  // "Reset to plan" only means something when an override row exists for this
  // session — otherwise it is already exactly what the plan prescribes.
  const hasSessionEdits =
    editSessionForm !== null && overrides[editSessionForm.sessionId] !== undefined;

  // Plan session edit modal
  function openSessionEditor(s: PlannedSession) {
    // plan.sessions is the plan as stored, before applyPlanOverrides, so this
    // is the prescription rather than the athlete's current view of it.
    const planned = plan?.sessions.find((p) => p.id === s.id) ?? null;
    setEditSessionForm({
      sessionId: s.id,
      originalDate: s.originalDate,
      date: s.date,
      name: s.name,
      type: s.type,
      km: s.km,
      base: planned
        ? { name: planned.name, type: planned.type, km: planned.km }
        : null,
    });
    setEditSessionError(null);
  }

  async function saveSessionEdits() {
    if (!editSessionForm) return;
    const form = editSessionForm;
    const name = form.name.trim();
    if (name.length === 0) {
      setEditSessionError("Name cannot be empty.");
      return;
    }
    if (!Number.isFinite(form.km) || form.km < 0) {
      setEditSessionError("Distance must be a non-negative number.");
      return;
    }

    setEditSessionSaving(true);
    setEditSessionError(null);
    try {
      // Only send a field when it differs from the plan. Omitting it leaves the
      // column null, which means "follow the plan".
      const base = form.base;
      const res = await fetch("/api/plan-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: form.sessionId,
          originalDate: form.originalDate,
          newDate: form.date,
          name: base && name === base.name ? undefined : name,
          type: base && form.type === base.type ? undefined : form.type,
          km: base && form.km === base.km ? undefined : form.km,
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

  // Drops the whole override row, returning the session to exactly what the
  // plan prescribes — date, name, type and distance together.
  async function resetSessionToPlan() {
    if (!editSessionForm) return;
    setEditSessionSaving(true);
    try {
      await resetMove(editSessionForm.sessionId);
      setEditSessionForm(null);
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
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 max-sm:p-3.5">
      <div className="flex items-center justify-between mb-4 max-sm:flex-wrap max-sm:gap-y-2">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Training Calendar
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setViewDate(new Date(year, month - 1, 1))}
            aria-label="Previous month"
            className="px-3 py-1.5 max-sm:py-2.5 rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 text-sm transition-colors cursor-pointer"
          >
            ←
          </button>
          <span className="text-white font-semibold text-sm w-36 max-sm:w-auto max-sm:flex-1 text-center">
            {MONTH_TITLE_FMT.format(viewDate)}
          </span>
          <button
            type="button"
            onClick={() => setViewDate(new Date(year, month + 1, 1))}
            aria-label="Next month"
            className="px-3 py-1.5 max-sm:py-2.5 rounded-lg border border-gray-700 hover:border-gray-500 text-gray-300 text-sm transition-colors cursor-pointer"
          >
            →
          </button>
        </div>
      </div>

      {/* Month grid — desktop only. Left exactly as it was; below `sm` it is
          display:none and the agenda further down takes over. */}
      <div className="hidden sm:block">
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
                      className="text-gray-600 hover:text-orange-400 text-xs opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity cursor-pointer px-1"
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
                          onDragEnd={endDrag}
                          title={
                            `${s.name} (${s.km}km, ${s.type})` +
                            (moved ? ` — moved from ${s.movedFrom}` : "") +
                            "\nClick to edit · Drag to reschedule"
                          }
                          className={`px-1.5 py-0.5 rounded border text-[10px] leading-tight flex items-center gap-1 cursor-pointer ${
                            DISCIPLINE_PILL[planDiscipline]
                          } ${
                            done?.has(planDiscipline) && s.date <= today
                              ? ""
                              : s.date < today
                                ? "opacity-50 line-through"
                                : ""
                          } ${draggingId === dragId ? "opacity-30" : ""} ${
                            moved ? "ring-1 ring-orange-500/40" : ""
                          }`}
                        >
                          <DisciplineGlyph discipline={planDiscipline} size={10} className="flex-shrink-0 opacity-80" />
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
                              className="opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 hover:text-white transition-opacity cursor-pointer flex-shrink-0"
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
                          onDragEnd={endDrag}
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
                            className="opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 hover:text-white transition-opacity cursor-pointer flex-shrink-0"
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
      </div>

      {/* Mobile agenda -----------------------------------------------------
          Two things make the grid above unusable on a phone: each cell is
          ~48px wide, and both of its affordances are pointer-only — HTML5
          drag events have no touch equivalent, and Tailwind v4 gates `hover:`
          behind `@media (hover: hover)`, so the hover-revealed add/remove
          buttons never appear. This list shows the same data with explicit
          tap targets, and every action routes through the same editors. */}
      <div className="sm:hidden">
        <button
          type="button"
          onClick={() =>
            setForm({
              date: agendaDefaultDate,
              discipline: "swim",
              name: "",
              distanceKm: "",
              durationMin: "",
            })
          }
          className="w-full mb-2 py-2.5 rounded-lg border border-dashed border-gray-700 text-gray-400 text-xs font-semibold uppercase tracking-wider cursor-pointer"
        >
          + Add workout
        </button>

        {agendaDays.length === 0 ? (
          <p className="text-gray-500 text-sm text-center py-8">
            Nothing scheduled this month.
          </p>
        ) : (
          <ul className="space-y-2">
            {agendaDays.map(({ date, dateStr, sessions, custom, done }) => {
              const isToday = dateStr === today;
              return (
                <li
                  key={dateStr}
                  className={`rounded-lg border p-3 ${
                    isToday
                      ? "border-orange-500/60 bg-orange-500/5"
                      : "border-gray-800 bg-gray-950/40"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span
                      className={`text-xs font-semibold uppercase tracking-wider ${
                        isToday ? "text-orange-400" : "text-gray-500"
                      }`}
                    >
                      {AGENDA_DATE_FMT.format(date)}
                      {isToday ? " · Today" : ""}
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
                      className="text-orange-400 text-xs font-semibold px-2 py-1.5 -mr-1 rounded-md cursor-pointer"
                    >
                      + Add
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    {sessions.map((s) => {
                      const moved = s.movedFrom !== undefined;
                      return (
                        <div key={s.id} className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openSessionEditor(s)}
                            className={`flex-1 min-w-0 px-2.5 py-2 rounded-lg border text-xs leading-tight flex items-center gap-2 text-left cursor-pointer ${
                              DISCIPLINE_PILL[planDiscipline]
                            } ${
                              done?.has(planDiscipline) && s.date <= today
                                ? ""
                                : s.date < today
                                  ? "opacity-50 line-through"
                                  : ""
                            } ${moved ? "ring-1 ring-orange-500/40" : ""}`}
                          >
                            <DisciplineGlyph
                              discipline={planDiscipline}
                              size={12}
                              className="flex-shrink-0 opacity-80"
                            />
                            <span className="truncate flex-1">
                              {s.km}km {s.name}
                            </span>
                          </button>
                          {moved && (
                            <button
                              type="button"
                              onClick={() => resetMove(s.id)}
                              aria-label={`Reset to ${s.movedFrom}`}
                              className="flex-shrink-0 px-2.5 py-2 rounded-lg border border-gray-800 text-gray-400 text-xs cursor-pointer"
                            >
                              ↺
                            </button>
                          )}
                        </div>
                      );
                    })}

                    {custom.map((w) => (
                      <div key={w.id} className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => openWorkoutEditor(w)}
                          className={`flex-1 min-w-0 px-2.5 py-2 rounded-lg border text-xs leading-tight flex items-center gap-2 text-left cursor-pointer ${
                            DISCIPLINE_PILL[w.discipline]
                          }`}
                        >
                          <DisciplineGlyph
                            discipline={w.discipline}
                            size={12}
                            className="flex-shrink-0 opacity-80"
                          />
                          <span className="truncate flex-1">
                            {w.distanceKm
                              ? `${w.distanceKm}km `
                              : w.durationMin
                                ? `${w.durationMin}min `
                                : ""}
                            {w.name}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => removeWorkout(w.id)}
                          aria-label={`Remove ${w.name}`}
                          className="flex-shrink-0 px-2.5 py-2 rounded-lg border border-gray-800 text-gray-400 text-xs cursor-pointer"
                        >
                          ×
                        </button>
                      </div>
                    ))}

                    {sessions.length === 0 && custom.length === 0 && (
                      <p className="text-gray-600 text-xs">Rest day</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="text-gray-600 text-xs mt-3 hidden sm:block">
        Drag any session to a different day to reschedule. Moved sessions get an
        orange ring; hover and click ↺ to reset to the original plan date. The
        coach sees every move so it can adapt advice.
      </p>
      <p className="text-gray-600 text-xs mt-3 sm:hidden">
        Tap a session to edit it or move it to another day. Moved sessions get an
        orange ring; tap ↺ to reset to the original plan date. The coach sees
        every move so it can adapt advice.
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

              {editSessionError && <p className="text-red-400 text-xs">{editSessionError}</p>}

              <div className="flex items-center justify-between gap-3 pt-3">
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={hideSession}
                    disabled={editSessionSaving}
                    className="text-sm font-medium text-red-400 hover:text-red-300 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Remove
                  </button>
                  {hasSessionEdits && (
                    <button
                      type="button"
                      onClick={resetSessionToPlan}
                      disabled={editSessionSaving}
                      className="text-sm font-medium text-gray-400 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Reset to plan
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={saveSessionEdits}
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
