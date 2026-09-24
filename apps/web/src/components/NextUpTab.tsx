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
import { WorkoutProfile } from "./WorkoutProfile";

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

const DAY_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const WEEKDAY_FMT = new Intl.DateTimeFormat("en-GB", { weekday: "long" });

const STEP_BTN =
  "cursor-pointer rounded-md border border-gray-800 px-2 py-0.5 font-data text-[12px] text-gray-400 transition-colors hover:border-gray-700 hover:text-white disabled:cursor-default disabled:opacity-30";

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
  // Which alternative is expanded (or `<id>:steps` for the lead's step list),
  // and whether the alternatives are shown at all.
  const [openId, setOpenId] = useState<string | null>(null);
  const [showOthers, setShowOthers] = useState(false);

  // A proposal was worked out for one day; it means nothing on another.
  function changeDay(next: string | null) {
    setPending(null);
    setNotice(null);
    setOpenId(null);
    setShowOthers(false);
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
      <div className="rounded-[14px] border border-gray-800 bg-gray-900 p-6">
        <p className="text-sm text-gray-500">Could not work out what to suggest.</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-[14px] border border-gray-800 bg-gray-900 p-6">
        <p className="animate-pulse text-sm text-gray-500">Reading your training…</p>
      </div>
    );
  }

  const viewing = data.date;
  const isToday = viewing === data.today;
  const viewingDate = new Date(`${viewing}T12:00:00`);
  const dayWord = isToday
    ? "Today"
    : viewing === shiftDate(data.today, 1)
      ? "Tomorrow"
      : WEEKDAY_FMT.format(viewingDate);

  const [lead, ...others] = data.suggestions;

  // Why, shape, and the add button; the step list only when asked for, since
  // the chart already says what the session is.
  function suggestionBody(s: Suggestion, isLead: boolean) {
    const state = added[s.id];
    const asking = pending?.suggestionId === s.id ? pending : null;
    const showSteps = openId === `${s.id}:steps` || !isLead;
    return (
      <>
        {/* The evidence, always. A ranking you cannot argue with is one
            you can only obey or ignore. */}
        <p className="mt-2 max-w-3xl text-[13px] leading-snug text-gray-500">{s.why}</p>

        {s.session && s.session.blocks.length > 0 && (
          <div className="mt-3">
            <WorkoutProfile
              blocks={s.session.blocks}
              threshold={s.session.threshold}
              name={s.session.name}
            />
          </div>
        )}

        {s.session && s.session.steps.length > 0 && showSteps && (
          <div className="mt-3 space-y-1.5">
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
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => addToCalendar(s)}
              disabled={adding !== null || state === viewing}
              className={`cursor-pointer rounded-[10px] px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-default disabled:opacity-60 ${
                isLead
                  ? "bg-orange-500 text-[var(--accent-fg)] hover:bg-orange-400"
                  : "border border-gray-700 text-gray-300 hover:border-gray-600 hover:text-white"
              }`}
            >
              {adding === s.id ? "Adding…" : state === viewing ? "On your calendar" : "Add to calendar"}
            </button>
            {isLead && s.session.steps.length > 0 && (
              <button
                type="button"
                onClick={() => setOpenId(showSteps ? null : `${s.id}:steps`)}
                aria-expanded={showSteps}
                className="cursor-pointer text-sm text-gray-500 transition-colors hover:text-white"
              >
                {showSteps ? "Hide steps" : "Show steps"}
              </button>
            )}
            {state === "error" && (
              <span className="font-data text-[11px] text-[var(--err)]">Could not add it. Try again.</span>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="space-y-4">
      {/* The feed's day divider for this section. It names the day being
          viewed, so it has to live here with the stepper that changes it. */}
      <div className="flex items-center gap-3 pt-2">
        <span className="shrink-0 font-data text-[12px] uppercase tracking-[0.1em] text-gray-500">
          {dayWord} · {DAY_FMT.format(viewingDate)}
        </span>
        <span className="h-px flex-1 bg-gray-800" aria-hidden />
        <div className="flex shrink-0 items-center gap-1">
          {/* Stops at today: a day that has gone cannot be trained, and the
              API clamps anything earlier back to today anyway. */}
          <button
            type="button"
            onClick={() => {
              const previous = shiftDate(viewing, -1);
              changeDay(previous === data.today ? null : previous);
            }}
            disabled={isToday}
            aria-label="Previous day"
            className={STEP_BTN}
          >
            ←
          </button>
          {!isToday && (
            <button type="button" onClick={() => changeDay(null)} className={STEP_BTN}>
              Today
            </button>
          )}
          <button
            type="button"
            onClick={() => changeDay(shiftDate(viewing, 1))}
            aria-label="Next day"
            className={STEP_BTN}
          >
            →
          </button>
        </div>
      </div>

      {notice && notice.lines.length > 0 && (
        <div
          className={`rounded-[10px] border px-5 py-3 ${
            notice.error
              ? "border-[var(--err)]/40 bg-[var(--err)]/5"
              : "border-gray-800 bg-gray-900"
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
          {data.suggestions.length === 0 && (
            <p className="rounded-[14px] border border-gray-800 bg-gray-900 p-5 text-sm text-gray-500">
              Nothing to suggest for this day. Ask your coach if you want something anyway.
            </p>
          )}
          {lead && (
            <div className="rounded-[14px] border border-orange-500/25 bg-gradient-to-br from-gray-800 to-gray-900 to-70% p-5">
              <SuggestionHeader s={lead} large />
              {suggestionBody(lead, true)}
            </div>
          )}

          {/* Alternatives fold into one row so the day's completed sessions,
              further down the feed, stay in view. */}
          {others.length > 0 && (
            <div className="overflow-hidden rounded-[14px] border border-gray-800 bg-gray-900">
              <button
                type="button"
                onClick={() => setShowOthers((v) => !v)}
                aria-expanded={showOthers}
                className="flex w-full cursor-pointer items-center justify-between gap-3 px-5 py-3 text-left text-sm text-gray-400 transition-colors hover:text-white"
              >
                <span>
                  {others.length} other {others.length === 1 ? "option" : "options"}
                  <span className="ml-2 text-gray-600">
                    {others.map((o) => o.headline).slice(0, 3).join(" · ")}
                  </span>
                </span>
                <span aria-hidden>{showOthers ? "−" : "+"}</span>
              </button>
              {showOthers &&
                others.map((o) => {
                  const isOpen = openId === o.id || pending?.suggestionId === o.id;
                  return (
                    <div key={o.id} className="border-t border-gray-800 px-5 py-3">
                      <button
                        type="button"
                        onClick={() => setOpenId(isOpen ? null : o.id)}
                        aria-expanded={isOpen}
                        className="w-full cursor-pointer text-left"
                      >
                        <SuggestionHeader s={o} />
                      </button>
                      {isOpen && suggestionBody(o, false)}
                    </div>
                  );
                })}
            </div>
          )}
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
    <div className="mt-4 space-y-4 rounded-[10px] border border-orange-500/30 bg-orange-500/5 p-4">
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
                    className={`cursor-pointer rounded-[8px] border px-3 py-1 font-display text-[12px] uppercase tracking-wider transition-colors disabled:cursor-default ${
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
          className="cursor-pointer rounded-[10px] border border-orange-500/40 bg-orange-500/10 px-4 py-1.5 font-display text-[12px] uppercase tracking-wider text-orange-300 transition-colors hover:border-orange-500 hover:bg-orange-500/20 disabled:cursor-default disabled:opacity-60"
        >
          {busy ? "Updating…" : changesSomething ? "Add and apply" : "Add anyway"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="cursor-pointer rounded-[10px] border border-gray-700 px-4 py-1.5 font-display text-[12px] uppercase tracking-wider text-gray-400 transition-colors hover:border-gray-600 hover:text-white disabled:cursor-default"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Priority, sport, name and length: all an alternative shows until opened. */
function SuggestionHeader({ s, large = false }: { s: Suggestion; large?: boolean }) {
  const badge = PRIORITY[s.priority];
  return (
    <div className="flex items-start justify-between gap-4">
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
        <h3
          className={`mt-2 font-display font-bold uppercase leading-none tracking-wide text-white ${
            large ? "text-2xl sm:text-3xl" : "text-lg"
          }`}
        >
          {s.headline}
        </h3>
      </div>
      {s.session && (
        <div className="shrink-0 text-right font-data text-[11px] text-gray-500">
          {formatDuration(s.session.durationMin)}
          {s.session.distanceKm ? ` · ${s.session.distanceKm} km` : ""}
        </div>
      )}
    </div>
  );
}
