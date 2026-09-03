"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { StravaActivity } from "@trihards/core";
import { getDiscipline } from "@trihards/core";
import {
  applyPlanOverrides,
  type PlannedSession,
  type TrainingPlan,
} from "@trihards/core";
import type { CustomWorkout } from "@/lib/workouts";
import type { PlanEdits } from "./usePlanEdits";
import {
  AddWorkoutModal,
  type AddFormState,
} from "./calendar/AddWorkoutModal";
import {
  EditWorkoutModal,
  type EditWorkoutFormState,
} from "./calendar/EditWorkoutModal";
import {
  EditSessionModal,
  type EditSessionFormState,
} from "./calendar/EditSessionModal";
import { MonthGrid, type DragPayload } from "./calendar/MonthGrid";
import { MobileAgenda } from "./calendar/MobileAgenda";

// Built once at module scope rather than per render: constructing an
// Intl formatter is the expensive part, and these options never vary.
// The locale stays pinned to en-US, so this is not a behaviour change.
const MONTH_TITLE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
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
      // The API replaces the whole override row, so a move has to re-send
      // whatever else it already recorded — a rename, an edited distance, a
      // skip and its reason. Sending only the date would quietly undo them.
      const existing = overrides[payload.sessionId];
      // Optimistic update
      setOverrides((prev) => ({
        ...prev,
        [payload.sessionId]: {
          ...existing,
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
            reason: existing?.reason,
            name: existing?.name,
            type: existing?.type,
            km: existing?.km,
            skipped: existing?.skipped,
            skipReason: existing?.skipReason,
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
      skipped: s.skipped === true,
      skipReason: s.skipReason ?? "",
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
          skipped: form.skipped,
          skipReason: form.skipped ? form.skipReason : undefined,
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
      <MonthGrid
        weeks={weeks}
        month={month}
        today={today}
        toDateStr={toDateStr}
        planByDate={planByDate}
        workoutsByDate={workoutsByDate}
        doneByDate={doneByDate}
        dragOverDate={dragOverDate}
        draggingId={draggingId}
        onDragStart={onDragStart}
        endDrag={endDrag}
        onDayDragOver={onDayDragOver}
        onDayDragLeave={onDayDragLeave}
        onDayDrop={onDayDrop}
        planDiscipline={planDiscipline}
        setForm={setForm}
        openSessionEditor={openSessionEditor}
        openWorkoutEditor={openWorkoutEditor}
        removeWorkout={removeWorkout}
        resetMove={resetMove}
      />

      {/* Mobile agenda -----------------------------------------------------
          Two things make the grid above unusable on a phone: each cell is
          ~48px wide, and both of its affordances are pointer-only — HTML5
          drag events have no touch equivalent, and Tailwind v4 gates `hover:`
          behind `@media (hover: hover)`, so the hover-revealed add/remove
          buttons never appear. This list shows the same data with explicit
          tap targets, and every action routes through the same editors. */}
      <MobileAgenda
        agendaDays={agendaDays}
        today={today}
        agendaDefaultDate={agendaDefaultDate}
        planDiscipline={planDiscipline}
        setForm={setForm}
        openSessionEditor={openSessionEditor}
        openWorkoutEditor={openWorkoutEditor}
        removeWorkout={removeWorkout}
        resetMove={resetMove}
      />

      <p className="text-gray-600 text-xs mt-3 hidden sm:block">
        Drag any session to a different day to reschedule. Moved sessions get an
        orange ring; hover and click ↺ to reset to the original plan date. Click a
        session to skip it with a reason — it stays here, marked skipped. The
        coach sees every move and every skip so it can adapt advice.
      </p>
      <p className="text-gray-600 text-xs mt-3 sm:hidden">
        Tap a session to edit it or move it to another day. Moved sessions get an
        orange ring; tap ↺ to reset to the original plan date. You can also mark a
        session skipped with a reason. The coach sees every move and every skip
        so it can adapt advice.
      </p>

      {form && (
        <AddWorkoutModal
          form={form}
          setForm={setForm}
          saving={saving}
          error={error}
          onSubmit={submitWorkout}
        />
      )}

      {editWorkoutForm && (
        <EditWorkoutModal
          editWorkoutForm={editWorkoutForm}
          setEditWorkoutForm={setEditWorkoutForm}
          editWorkoutSaving={editWorkoutSaving}
          editWorkoutError={editWorkoutError}
          onSave={saveWorkoutEdit}
          onDelete={deleteWorkoutEdit}
        />
      )}

      {editSessionForm && (
        <EditSessionModal
          editSessionForm={editSessionForm}
          setEditSessionForm={setEditSessionForm}
          editSessionSaving={editSessionSaving}
          editSessionError={editSessionError}
          planDiscipline={planDiscipline}
          hasSessionEdits={hasSessionEdits}
          onSave={saveSessionEdits}
          onRemove={hideSession}
          onResetToPlan={resetSessionToPlan}
        />
      )}
    </div>
  );
}
