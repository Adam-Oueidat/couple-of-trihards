"use client";

import type { DragEvent } from "react";
import type { PlannedSession } from "@trihards/core";
import type { CustomWorkout } from "@/lib/workouts";
import { DisciplineGlyph } from "../DisciplineGlyph";
import { DISCIPLINE_PILL } from "../discipline-pill";
import { SKIPPED_BADGE, SKIPPED_CHIP, type CalendarDayActions } from "./types";

export type DragPayload =
  | { kind: "plan"; sessionId: string; originalDate: string; currentDate: string }
  | { kind: "custom"; id: string; currentDate: string };

interface Props extends CalendarDayActions {
  weeks: Date[][];
  month: number;
  today: string;
  toDateStr: (d: Date) => string;
  planByDate: Map<string, PlannedSession[]>;
  workoutsByDate: Map<string, CustomWorkout[]>;
  doneByDate: Map<string, Set<string>>;
  dragOverDate: string | null;
  draggingId: string | null;
  onDragStart: (e: DragEvent, payload: DragPayload) => void;
  endDrag: () => void;
  onDayDragOver: (e: DragEvent, dateStr: string) => void;
  onDayDragLeave: (dateStr: string) => void;
  onDayDrop: (e: DragEvent, dateStr: string) => void;
}

/**
 * The seven-column month grid — desktop only. All drag state and handlers stay
 * with CalendarTab; this renders them.
 */
export function MonthGrid({
  weeks,
  month,
  today,
  toDateStr,
  planByDate,
  workoutsByDate,
  doneByDate,
  dragOverDate,
  draggingId,
  onDragStart,
  endDrag,
  onDayDragOver,
  onDayDragLeave,
  onDayDrop,
  planDiscipline,
  setForm,
  openSessionEditor,
  openWorkoutEditor,
  removeWorkout,
  resetMove,
}: Props) {
  return (
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
                    const skipped = s.skipped === true;
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
                          (skipped
                            ? `\nSkipped${s.skipReason ? `: ${s.skipReason}` : " (no reason given)"}`
                            : "") +
                          "\nClick to edit · Drag to reschedule"
                        }
                        className={`px-1.5 py-0.5 rounded border text-[10px] leading-tight flex items-center gap-1 cursor-pointer ${
                          skipped ? SKIPPED_CHIP : DISCIPLINE_PILL[planDiscipline]
                        } ${
                          skipped
                            ? "line-through"
                            : done?.has(planDiscipline) && s.date <= today
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
                        {skipped && (
                          <span className={`${SKIPPED_BADGE} px-1 text-[8px] no-underline`}>
                            Skipped
                          </span>
                        )}
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
  );
}
