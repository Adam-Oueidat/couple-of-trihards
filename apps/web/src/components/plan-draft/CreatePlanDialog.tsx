"use client";

import { useEffect, useState } from "react";
import useSWR, { mutate } from "swr";
import { formatDuration, formatSecondsAsClock, WEEKDAYS, type Weekday } from "@trihards/core";
import { fetcher } from "@/lib/fetcher";
import type { DraftView, StartingPointView } from "@/lib/plan-drafts";

export const DRAFTS_KEY = "/api/plan/drafts";

const DAY_LABEL: Record<Weekday, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};

/** Next Monday, the natural first day of a plan. */
function nextMonday(): string {
  const d = new Date();
  d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, "0")}`;
}

const DATE_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const fmtDate = (iso: string) => DATE_FMT.format(new Date(`${iso}T12:00:00`));

const INPUT =
  "w-full rounded-[10px] border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none";

/**
 * "Create a plan": what the athlete wants, the few facts the coach can't know,
 * and — beside it — the starting point the coach will build from. Nothing is
 * saved here: submitting starts a draft the athlete reviews first.
 */
export function CreatePlanDialog({ onClose }: { onClose: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [startDate, setStartDate] = useState(nextMonday);
  const [raceDate, setRaceDate] = useState("");
  const [raceName, setRaceName] = useState("");
  const [hours, setHours] = useState("");
  const [blocked, setBlocked] = useState<Weekday[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: point, error: pointError } = useSWR<StartingPointView>(
    startDate ? `/api/plan/starting-point?start=${startDate}` : null,
    fetcher,
    { revalidateOnFocus: false, keepPreviousData: true },
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !submitting && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, submitting]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(DRAFTS_KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          startDate,
          raceDate: raceDate || undefined,
          raceName: raceName || undefined,
          maxHoursPerWeek: hours || undefined,
          unavailableDays: blocked,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not start the plan.");
      await mutate(DRAFTS_KEY, data as DraftView, { revalidate: false });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the plan.");
    } finally {
      setSubmitting(false);
    }
  }

  const toggleDay = (d: Weekday) =>
    setBlocked((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="create-plan-title">
      <button type="button" aria-label="Close dialog" onClick={onClose} className="fixed inset-0 cursor-default bg-black/70" />
      <div className="relative grid w-full max-w-[880px] overflow-hidden rounded-[14px] border border-gray-800 bg-gray-900 shadow-2xl md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <form
          className="flex flex-col gap-4 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h2 id="create-plan-title" className="font-display text-2xl font-bold uppercase leading-none tracking-wide text-white">
            Create a plan
          </h2>
          <label className="block">
            <span className="mb-1.5 block text-xs text-gray-500">What do you want to train for?</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder='e.g. "Create an Ironman plan for me"'
              rows={3}
              maxLength={1000}
              required
              autoFocus
              className={`${INPUT} resize-none text-[15px]`}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1.5 block text-xs text-gray-500">Plan starts</span>
              <input type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} className={INPUT} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-gray-500">Race day <span className="text-gray-600">· optional</span></span>
              <input type="date" value={raceDate} min={startDate} onChange={(e) => setRaceDate(e.target.value)} className={INPUT} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-gray-500">Most hours a week <span className="text-gray-600">· optional</span></span>
              <input type="number" min={2} max={40} step={0.5} value={hours} placeholder="—" onChange={(e) => setHours(e.target.value)} className={INPUT} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-gray-500">Race <span className="text-gray-600">· optional</span></span>
              <input value={raceName} maxLength={120} placeholder="e.g. Ironman Frankfurt" onChange={(e) => setRaceName(e.target.value)} className={INPUT} />
            </label>
          </div>
          <fieldset>
            <legend className="mb-1.5 text-xs text-gray-500">Days you can&apos;t train</legend>
            <div className="flex gap-1.5">
              {WEEKDAYS.map((d) => {
                const off = blocked.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={off}
                    onClick={() => toggleDay(d)}
                    className={`flex-1 cursor-pointer rounded-[8px] border py-2 text-xs transition-colors ${
                      off ? "border-gray-800 bg-gray-800 text-gray-600 line-through" : "border-gray-700 text-gray-300 hover:border-gray-600"
                    }`}
                  >
                    {DAY_LABEL[d]}
                  </button>
                );
              })}
            </div>
          </fieldset>
          {error && <p className="text-sm text-[var(--err)]">{error}</p>}
          <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-gray-500">Nothing is saved until you review the draft.</span>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="cursor-pointer rounded-[10px] border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:border-gray-600">
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !prompt.trim()}
                className="cursor-pointer rounded-[10px] bg-orange-500 px-4 py-2 text-sm font-semibold text-[var(--accent-fg)] transition-colors hover:bg-orange-400 disabled:cursor-default disabled:opacity-50"
              >
                {submitting ? "Starting…" : "Build draft"}
              </button>
            </div>
          </div>
        </form>

        <aside className="flex flex-col gap-3 border-t border-gray-800 bg-gray-950/60 p-6 md:border-l md:border-t-0" aria-live="polite">
          <p className="font-data text-[11px] uppercase tracking-[0.14em] text-gray-500">Starting point</p>
          <p className="text-[13px] text-gray-400">What the coach builds from, as of {fmtDate(startDate)}.</p>
          {pointError ? (
            <p className="text-sm text-gray-500">Couldn&apos;t read your training just now; the coach will still see it.</p>
          ) : !point ? (
            <p className="animate-pulse text-sm text-gray-500">Reading your training…</p>
          ) : (
            <>
              <dl className="font-data text-[13px]">
                <Row label="Fitness (CTL) today" value={`${point.ctlToday}`} />
                <Row
                  label={`Projected on ${fmtDate(point.startDate)}`}
                  value={`${point.ctlAtStart} ${point.ctlAtStart > point.ctlToday ? "↑" : point.ctlAtStart < point.ctlToday ? "↓" : "→"}`}
                />
                <Row label="Last 8 weeks" value={`${point.hoursPerWeek} h/wk`} />
                <Row
                  label="Swim · ride · run · strength"
                  value={`${point.split.swim} · ${point.split.ride} · ${point.split.run} · ${point.split.strength} %`}
                />
                {point.runThresholdSecPerKm && <Row label="Run threshold" value={`${formatSecondsAsClock(point.runThresholdSecPerKm)}/km`} />}
                {point.ftp && <Row label="FTP" value={`${point.ftp} W`} />}
                <Row label="Longest ride, 12 wks" value={point.longestRideMin ? formatDuration(point.longestRideMin) : "—"} />
              </dl>
              {point.overlap && (
                <p className="rounded-[10px] border border-orange-500/35 bg-orange-500/5 px-3.5 py-3 text-[13px] leading-relaxed text-gray-300">
                  <span className="font-semibold text-orange-500">Your current plan overlaps.</span> &ldquo;{point.overlap.name}&rdquo; runs until{" "}
                  {fmtDate(point.overlap.endDate)}. It will end when this plan starts, and its sessions until then count toward your starting fitness.
                </p>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-t border-gray-800 py-2 first:border-t-0">
      <dt className="text-gray-400">{label}</dt>
      <dd className="text-right text-white">{value}</dd>
    </div>
  );
}
