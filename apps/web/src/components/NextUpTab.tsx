"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import {
  formatDuration,
  isHardSuggestion,
  SUGGEST_DISCIPLINE_LABEL,
  type ConflictAction,
  type ScheduleConflict,
  type Suggestion,
  type SuggestionPriority,
  type TriDiscipline,
} from "@trihards/core";
import { DisciplineGlyph } from "./DisciplineGlyph";
import { SectionLabel } from "./SectionLabel";

interface Payload {
  date: string;
  today: string;
  suggestions: Suggestion[];
}

const DISCIPLINE_COLOR: Record<TriDiscipline, string> = {
  swim: "var(--swim)",
  ride: "var(--ride)",
  run: "var(--run)",
};

/**
 * How firmly the ranking stands behind a suggestion.
 *
 * Deliberately three bands rather than a score: a number implies a precision
 * the rules do not have, and invites an athlete to compare 62 against 68 as if
 * the difference meant something.
 */
const PRIORITY: Record<SuggestionPriority, { label: string; cls: string }> = {
  "do-this": {
    label: "Do this",
    cls: "border-orange-500/50 bg-orange-500/10 text-orange-300",
  },
  "good-option": {
    label: "Good option",
    cls: "border-gray-700 bg-gray-800 text-gray-300",
  },
  optional: { label: "If you want", cls: "border-gray-800 bg-gray-950 text-gray-500" },
};

const DAY_FMT = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "short",
});

/** A hard pick waiting on the athlete's answer to what it clashes with. */
interface Pending {
  suggestionId: string;
  conflicts: ScheduleConflict[];
  choices: Record<string, ConflictAction>;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

/**
 * What to train next.
 *
 * The ranking is the product here, and the reasoning is what makes it usable —
 * an athlete who can read "you have not ridden in 12 days" is able to disagree
 * with it, where one handed a bare ordering can only obey or ignore. So every
 * card leads with the verdict and carries its evidence underneath.
 */
export function NextUpTab() {
  const [date, setDate] = useState<string | null>(null);
  const key = date ? `/api/suggestions?date=${date}` : "/api/suggestions";
  const { data, error, mutate } = useSWR<Payload>(key, fetcher, {
    revalidateOnFocus: false,
  });

  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  // What the last add actually changed, read back to the athlete. Held above
  // the list because the card that caused it can drop out of the new ranking.
  const [notice, setNotice] = useState<{ lines: string[]; error?: boolean } | null>(null);

  // A proposal was worked out for one day; it means nothing on another.
  function changeDay(next: string | null) {
    setPending(null);
    setNotice(null);
    setDate(next);
  }

  function fail(suggestionId: string, message?: string) {
    setAdded((prev) => ({ ...prev, [suggestionId]: "error" }));
    if (message) setNotice({ lines: [message], error: true });
  }

  async function accept(
    suggestion: Suggestion,
    resolutions: Record<string, ConflictAction>,
  ) {
    if (!suggestion.session || !data) return;
    setAdding(suggestion.id);
    try {
      const res = await fetch("/api/suggestions/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: data.date, session: suggestion.session, resolutions }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(suggestion.id, res.status === 409 ? body.error : undefined);
        return;
      }
      setAdded((prev) => ({ ...prev, [suggestion.id]: data.date }));
      setNotice({ lines: body.changes ?? [] });
    } catch {
      fail(suggestion.id);
    } finally {
      setPending(null);
      setAdding(null);
      void mutate();
    }
  }

  /**
   * A hard session is checked against the days around it first. If it would
   * sit back to back with another hard day, nothing is written: the clash and
   * the proposed fixes are shown, and the athlete decides.
   */
  async function addToCalendar(suggestion: Suggestion) {
    const session = suggestion.session;
    if (!session || !data) return;
    setNotice(null);

    if (isHardSuggestion(session)) {
      setAdding(suggestion.id);
      let conflicts: ScheduleConflict[];
      try {
        const res = await fetch("/api/suggestions/conflicts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: data.date, session }),
        });
        if (!res.ok) throw new Error("failed");
        conflicts = (await res.json()).conflicts;
      } catch {
        setAdding(null);
        fail(suggestion.id);
        return;
      }
      if (conflicts.length > 0) {
        setAdding(null);
        setPending({
          suggestionId: suggestion.id,
          conflicts,
          choices: Object.fromEntries(conflicts.map((c) => [c.sessionId, c.options[0].action])),
        });
        return;
      }
    }

    await accept(suggestion, {});
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6">
        <p className="text-sm text-gray-500">Could not work out what to suggest.</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-2xl border border-gray-800 bg-gray-900 p-6">
        <p className="animate-pulse text-sm text-gray-500">Reading your training…</p>
      </div>
    );
  }

  const viewing = data.date;
  const isToday = viewing === data.today;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-gray-800 px-6 py-4 sm:px-7">
          <SectionLabel className="mb-0">
            {isToday ? "What to train today" : "What to train"}
          </SectionLabel>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => changeDay(null)}
              disabled={isToday}
              className="cursor-pointer rounded-full border border-gray-700 px-3 py-1 font-display text-[12px] uppercase tracking-wider text-gray-400 transition-colors hover:border-gray-600 hover:text-white disabled:cursor-default disabled:opacity-40"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => changeDay(shiftDate(viewing, 1))}
              className="cursor-pointer rounded-full border border-gray-700 px-3 py-1 font-display text-[12px] uppercase tracking-wider text-gray-400 transition-colors hover:border-gray-600 hover:text-white"
            >
              Next day →
            </button>
          </div>
        </div>

        <div className="px-6 pt-4 sm:px-7">
          <span className="font-data text-[11px] text-gray-500">
            {DAY_FMT.format(new Date(`${viewing}T12:00:00`))}
            {isToday ? " · today" : ""}
          </span>
        </div>

        <div className="space-y-4 p-6 pt-4 sm:p-7 sm:pt-4">
          {notice && notice.lines.length > 0 && (
            <div
              className={`rounded-xl border px-5 py-3 ${
                notice.error
                  ? "border-[var(--err)]/40 bg-[var(--err)]/5"
                  : "border-gray-800 bg-gray-950/50"
              }`}
            >
              {notice.lines.map((line) => (
                <p
                  key={line}
                  className={`text-[13px] leading-snug ${notice.error ? "text-[var(--err)]" : "text-gray-300"}`}
                >
                  {line}
                </p>
              ))}
            </div>
          )}
          {data.suggestions.map((s) => {
            const badge = PRIORITY[s.priority];
            const state = added[s.id];
            const asking = pending?.suggestionId === s.id ? pending : null;
            return (
              <div
                key={s.id}
                className="rounded-xl border border-gray-800 bg-gray-950/50 p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-0.5 font-data text-[10px] uppercase tracking-wider ${badge.cls}`}
                      >
                        {badge.label}
                      </span>
                      {s.session && (
                        <span
                          className="inline-flex items-center gap-1.5 font-data text-[11px] uppercase tracking-wider"
                          style={{ color: DISCIPLINE_COLOR[s.session.discipline] }}
                        >
                          <DisciplineGlyph discipline={s.session.discipline} size={12} />
                          {SUGGEST_DISCIPLINE_LABEL[s.session.discipline]}
                        </span>
                      )}
                    </div>
                    <h3 className="mt-2 font-display text-xl leading-tight text-white">
                      {s.headline}
                    </h3>
                  </div>

                  {s.session && (
                    <div className="text-right font-data text-[11px] text-gray-500">
                      {formatDuration(s.session.durationMin)}
                      {s.session.distanceKm ? ` · ${s.session.distanceKm} km` : ""}
                    </div>
                  )}
                </div>

                {/* The evidence, always. A ranking you cannot argue with is one
                    you can only obey or ignore. */}
                <p className="mt-2 max-w-3xl text-[13px] leading-snug text-gray-500">
                  {s.why}
                </p>

                {s.session && s.session.steps.length > 0 && (
                  <div className="mt-4 space-y-1.5 border-t border-gray-800 pt-4">
                    {s.session.steps.map((step, i) => (
                      <div
                        key={i}
                        className="grid grid-cols-[130px_minmax(0,1fr)] gap-3 max-sm:grid-cols-1 max-sm:gap-0.5"
                      >
                        <span className="font-data text-[11px] uppercase tracking-wider text-gray-600">
                          {step.label}
                        </span>
                        <span className="text-[13px] text-gray-300">{step.detail}</span>
                      </div>
                    ))}
                  </div>
                )}

                {asking && (
                  <ConflictPrompt
                    pending={asking}
                    busy={adding === s.id}
                    onChoose={(sessionId, action) =>
                      setPending({ ...asking, choices: { ...asking.choices, [sessionId]: action } })
                    }
                    onConfirm={() => accept(s, asking.choices)}
                    onCancel={() => setPending(null)}
                  />
                )}

                {s.session && !asking && (
                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => addToCalendar(s)}
                      disabled={adding !== null || state === viewing}
                      className="cursor-pointer rounded-full border border-orange-500/40 bg-orange-500/10 px-4 py-1.5 font-display text-[12px] uppercase tracking-wider text-orange-300 transition-colors hover:border-orange-500 hover:bg-orange-500/20 disabled:cursor-default disabled:opacity-60"
                    >
                      {adding === s.id
                        ? "Adding…"
                        : state === viewing
                          ? "On your calendar"
                          : "Add to calendar"}
                    </button>
                    {state === "error" && (
                      <span className="font-data text-[11px] text-[var(--err)]">
                        Could not add it. Try again.
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/**
 * The clash, the proposed fixes, and nothing applied until the athlete says so.
 * The recommended fix is preselected; "Keep both" is always there, because the
 * athlete may know something the calendar does not.
 */
function ConflictPrompt({
  pending,
  busy,
  onChoose,
  onConfirm,
  onCancel,
}: {
  pending: Pending;
  busy: boolean;
  onChoose: (sessionId: string, action: ConflictAction) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const changesSomething = Object.values(pending.choices).some((a) => a !== "keep");

  return (
    <div className="mt-4 space-y-4 rounded-xl border border-orange-500/30 bg-orange-500/5 p-4">
      <SectionLabel className="mb-0">Before this goes on your calendar</SectionLabel>

      {pending.conflicts.map((c) => {
        const chosen = c.options.find((o) => o.action === pending.choices[c.sessionId]);
        return (
          <div key={c.sessionId}>
            <p className="max-w-3xl text-[13px] leading-snug text-gray-300">{c.message}</p>
            <div className="mt-2.5 flex flex-wrap gap-2" role="radiogroup">
              {c.options.map((o) => {
                const selected = o.action === chosen?.action;
                return (
                  <button
                    key={o.action}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => onChoose(c.sessionId, o.action)}
                    disabled={busy}
                    className={`cursor-pointer rounded-full border px-3 py-1 font-display text-[12px] uppercase tracking-wider transition-colors disabled:cursor-default ${
                      selected
                        ? "border-orange-500 bg-orange-500/20 text-orange-200"
                        : "border-gray-700 text-gray-400 hover:border-gray-600 hover:text-white"
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            {chosen && (
              <p className="mt-2 text-[12px] leading-snug text-gray-500">{chosen.detail}</p>
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-3 border-t border-gray-800 pt-4">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="cursor-pointer rounded-full border border-orange-500/40 bg-orange-500/10 px-4 py-1.5 font-display text-[12px] uppercase tracking-wider text-orange-300 transition-colors hover:border-orange-500 hover:bg-orange-500/20 disabled:cursor-default disabled:opacity-60"
        >
          {busy ? "Updating…" : changesSomething ? "Add and apply" : "Add anyway"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="cursor-pointer rounded-full border border-gray-700 px-4 py-1.5 font-display text-[12px] uppercase tracking-wider text-gray-400 transition-colors hover:border-gray-600 hover:text-white disabled:cursor-default"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
