"use client";

import type { PlannedSession } from "@trihards/core";
import type { CustomWorkout } from "@/lib/workouts";
import { DisciplineGlyph } from "../DisciplineGlyph";
import { DISCIPLINE_PILL } from "../discipline-pill";
import type { CalendarDayActions } from "./types";

// Built once at module scope rather than per render: constructing an
// Intl formatter is the expensive part, and these options never vary.
// The locale stays pinned to en-US, so this is not a behaviour change.
const AGENDA_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
});

export interface AgendaDay {
  date: Date;
  dateStr: string;
  sessions: PlannedSession[];
  custom: CustomWorkout[];
  done: Set<string> | undefined;
}

interface Props extends CalendarDayActions {
  agendaDays: AgendaDay[];
  /** Athlete-local today, for the "Today" marker. */
  today: string;
  /** Seed date for the add button when the month on screen is not this one. */
  agendaDefaultDate: string;
}

/**
 * The phone view. The grid above is unusable below `sm`: cells are ~48px wide
 * and both affordances are pointer-only, so this lists the same data with
 * explicit tap targets routed through the same editors.
 */
export function MobileAgenda({
  agendaDays,
  today,
  agendaDefaultDate,
  planDiscipline,
  setForm,
  openSessionEditor,
  openWorkoutEditor,
  removeWorkout,
  resetMove,
}: Props) {
  return (
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
  );
}
