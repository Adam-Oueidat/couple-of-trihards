"use client";

import { useState } from "react";
import type { MisdatedSession } from "@trihards/core";
import type { PlanEdits } from "./usePlanEdits";

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
});

function fmt(date: string): string {
  return DATE_FMT.format(new Date(date + "T12:00:00"));
}

function offsetLabel(days: number): string {
  const n = Math.abs(days);
  const unit = n === 1 ? "day" : "days";
  return days > 0 ? `${n} ${unit} late` : `${n} ${unit} early`;
}

interface Props {
  candidates: MisdatedSession[];
  edits: PlanEdits;
}

/**
 * Offers the sessions that look like they were simply run on the wrong day,
 * one click each to correct.
 *
 * The pairing is computed by findMisdatedSessions, not by a model: on the real
 * plan only two runs in fifteen weeks are unclaimed by any session, so there is
 * nothing for a language model to discover here that a rule does not already
 * find — and a rule cannot invent a link that is not there.
 *
 * Nothing is applied automatically. Every row is a proposal the athlete accepts
 * or dismisses, because moving a session rewrites their own training record.
 */
export function MisdatedReview({ candidates, edits }: Props) {
  const { overrides, setOverrides } = edits;
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const live = candidates.filter((c) => !dismissed.has(c.session.id));
  if (live.length === 0) return null;

  const full = live.filter((c) => c.confidence === "full");
  const partial = live.filter((c) => c.confidence === "partial");

  async function accept(candidate: MisdatedSession) {
    const { session, activity } = candidate;
    setApplying(session.id);
    setError(null);

    // Carry the existing override forward rather than replacing it: a session
    // that was renamed or had its distance edited must not lose that because
    // it also turned out to be on the wrong day.
    const existing = overrides[session.id];
    const originalDate = existing?.originalDate ?? session.originalDate ?? session.date;

    setOverrides((prev) => ({
      ...prev,
      [session.id]: {
        ...existing,
        sessionId: session.id,
        originalDate,
        newDate: activity.date,
        movedAt: new Date().toISOString(),
      },
    }));

    try {
      const res = await fetch("/api/plan-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.id,
          originalDate,
          newDate: activity.date,
          reason: `Ran ${offsetLabel(candidate.offsetDays)}`,
        }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      await edits.reloadOverrides();
    } catch (err) {
      // Put the optimistic change back the way it was, so the row does not
      // silently claim a move the server never accepted.
      setOverrides((prev) => {
        const next = { ...prev };
        if (existing) next[session.id] = existing;
        else delete next[session.id];
        return next;
      });
      setError(err instanceof Error ? err.message : "Could not move the session");
    } finally {
      setApplying(null);
    }
  }

  function Row({ candidate }: { candidate: MisdatedSession }) {
    const { session, activity, offsetDays, confidence } = candidate;
    const busy = applying === session.id;
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 p-3 rounded-lg border border-gray-800 bg-gray-950/50">
        <div className="flex-1 min-w-[16rem]">
          <p className="text-sm font-medium text-white truncate">{session.name}</p>
          <p className="text-gray-500 text-xs">
            planned {fmt(session.date)} · {session.km} km
          </p>
          <p className="text-gray-400 text-xs mt-1.5">
            ran <span className="text-white">{activity.km} km</span> on{" "}
            {fmt(activity.date)}{" "}
            <span className="text-gray-600">
              — {offsetLabel(offsetDays)}
              {confidence === "partial" && `, ${Math.round((activity.km / session.km) * 100)}% of planned`}
            </span>
          </p>
          <p className="text-gray-600 text-xs truncate">&ldquo;{activity.name}&rdquo;</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => accept(candidate)}
            disabled={busy}
            className="cursor-pointer rounded-[10px] border border-green-500/40 bg-green-500/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-green-300 transition-colors hover:border-green-500/70 hover:bg-green-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? "Moving…" : "That was it"}
          </button>
          <button
            type="button"
            onClick={() =>
              setDismissed((prev) => new Set(prev).add(session.id))
            }
            disabled={busy}
            className="cursor-pointer rounded-[10px] border border-gray-700 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400 transition-colors hover:border-gray-600 hover:text-white disabled:opacity-50"
          >
            No
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h3 className="font-display uppercase tracking-[0.2em] text-[13px] leading-none text-gray-400">
            Possible matches · {live.length}
          </h3>
          <p className="text-gray-600 text-xs mt-2 max-w-lg">
            These are marked missed because the run happened on a different day.
            Nothing moves unless you say so.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="cursor-pointer rounded-[10px] border border-orange-500/40 bg-orange-500/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-orange-300 transition-colors hover:border-orange-500 hover:bg-orange-500/20"
        >
          {open ? "Hide" : `Review ${live.length} possible match${live.length === 1 ? "" : "es"}`}
        </button>
      </div>

      {open && (
        <div className="mt-5 space-y-5">
          {error && (
            <p className="text-red-400 text-xs" role="alert">
              {error}
            </p>
          )}

          {full.length > 0 && (
            <section className="space-y-2">
              {partial.length > 0 && (
                <p className="text-gray-500 text-[11px] uppercase tracking-wider">
                  Full distance
                </p>
              )}
              {full.map((c) => (
                <Row key={c.session.id} candidate={c} />
              ))}
            </section>
          )}

          {partial.length > 0 && (
            <section className="space-y-2">
              <p className="text-gray-500 text-[11px] uppercase tracking-wider">
                Shorter than planned
              </p>
              <p className="text-gray-600 text-xs">
                You trained, but cut the session short. Accepting records both —
                it will show as partial rather than done.
              </p>
              {partial.map((c) => (
                <Row key={c.session.id} candidate={c} />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
