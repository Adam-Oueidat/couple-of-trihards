"use client";

import { useState } from "react";
import useSWR, { mutate } from "swr";
import { formatDuration, type TrainingPlan } from "@trihards/core";
import { fetcher } from "@/lib/fetcher";
import type { AdjustmentView } from "@/lib/plan-adjustments";
import type { PlanSummary } from "@/lib/training-plans";
import { DisciplineGlyph } from "../DisciplineGlyph";

const KEY = "/api/plan/adjustments";

const EXAMPLES = [
  "My knee is sore — go lighter on running for two weeks",
  "I'm travelling next week with no bike",
  "I can't train on Tuesdays any more",
];

const DATE_FMT = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmt = (iso: string) => DATE_FMT.format(new Date(`${iso}T12:00:00`));

type SessionLike = { name: string; discipline?: "swim" | "ride" | "run" | "strength"; km: number; durationMin?: number };

function label(s: SessionLike): string {
  const measure = s.km > 0 ? `${s.km} km` : s.durationMin ? formatDuration(s.durationMin) : "";
  return measure ? `${s.name} · ${measure}` : s.name;
}

function Session({ s, struck = false }: { s: SessionLike; struck?: boolean }) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${struck ? "text-gray-500 line-through" : "text-white"}`}>
      {s.discipline && <DisciplineGlyph discipline={s.discipline} size={12} className="shrink-0" />}
      <span className="truncate">{label(s)}</span>
    </span>
  );
}

/**
 * "Adjust with coach": tell the coach what changed, see exactly which
 * sessions would change, then apply or not. Sessions the athlete has edited
 * are theirs and show as kept.
 */
export function AdjustPanel({ onPlanChange }: { onPlanChange: (plan: TrainingPlan | null, summary: PlanSummary | null) => void }) {
  const { data: adj } = useSWR<AdjustmentView | null>(KEY, fetcher, {
    revalidateOnFocus: false,
    refreshInterval: (d) => (d?.status === "pending" ? 4000 : 0),
  });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(request: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(KEY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not ask the coach.");
      setText("");
      await mutate(KEY, data as AdjustmentView, { revalidate: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not ask the coach.");
    } finally {
      setBusy(false);
    }
  }

  async function act(action: "apply" | "discard" | "undo" | "dismiss") {
    if (!adj) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${KEY}/${adj.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      if (action === "apply" || action === "undo") onPlanChange(data.plan ?? null, data.summary ?? null);
      await mutate(KEY);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const asking = !adj || adj.status === "failed";
  const checked = adj?.result?.checked;

  return (
    <section className="rounded-[14px] border border-gray-800 bg-gray-900 p-5 sm:p-6" aria-live="polite">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg font-bold uppercase tracking-wide text-white">Adjust with coach</h2>
        {adj?.status === "ready" && checked && (
          <span className="font-data text-[11px] text-gray-500">
            {checked.changes.length} change{checked.changes.length === 1 ? "" : "s"}
            {checked.kept.length ? ` · ${checked.kept.length} kept` : ""}
          </span>
        )}
      </div>

      {adj?.status === "applied" && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[var(--ok)]/30 bg-[var(--ok)]/5 px-4 py-3 text-sm">
          <span className="text-gray-200">
            Applied {adj.result?.checked.changes.length ?? 0} change{adj.result?.checked.changes.length === 1 ? "" : "s"} for &ldquo;{adj.request}&rdquo;.
          </span>
          <span className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => act("undo")} className="cursor-pointer rounded-[8px] border border-gray-700 px-3 py-1 text-[13px] text-gray-300 hover:border-gray-600 disabled:opacity-50">Undo</button>
            <button type="button" disabled={busy} onClick={() => act("dismiss")} className="cursor-pointer rounded-[8px] px-2 py-1 text-[13px] text-gray-500 hover:text-white disabled:opacity-50">Dismiss</button>
          </span>
        </div>
      )}

      {adj && adj.status !== "applied" && (
        <div className="mt-4 flex flex-col gap-3">
          <p className="max-w-[80%] self-end rounded-[14px] rounded-br-[4px] bg-orange-500 px-3.5 py-2.5 text-sm font-medium text-[var(--accent-fg)]">{adj.request}</p>
          {adj.status === "pending" && <p className="animate-pulse self-start text-sm text-gray-500">Your coach is looking at your plan…</p>}
          {adj.status === "failed" && <p className="self-start text-sm text-[var(--err)]">{adj.error}</p>}
          {adj.status === "ready" && adj.result && (
            <>
              <p className="max-w-[88%] self-start rounded-[14px] rounded-bl-[4px] bg-gray-800 px-3.5 py-2.5 text-sm leading-relaxed text-gray-100">{adj.result.message}</p>
              {checked && (checked.changes.length > 0 || checked.kept.length > 0) ? (
                <div className="overflow-hidden rounded-[10px] border border-gray-800">
                  {checked.changes.map((c, i) => (
                    <div key={i} className="grid grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 border-t border-gray-800 px-3.5 py-2.5 text-[13px] first:border-t-0 max-sm:grid-cols-[minmax(0,1fr)] max-sm:gap-1">
                      <span className="font-data text-[12px] text-gray-500">{fmt((c.after ?? c.before)!.date)}</span>
                      <span className="min-w-0">{c.before ? <Session s={c.before} struck /> : <span className="font-data text-[11px] uppercase tracking-wider text-gray-500">New</span>}</span>
                      <span className="min-w-0">
                        {c.after ? <Session s={c.after} /> : <span className="text-gray-400">Removed</span>}
                        {c.why && <span className="block text-[12px] text-gray-500">{c.why}</span>}
                      </span>
                    </div>
                  ))}
                  {checked.kept.map((k, i) => (
                    <div key={`kept-${i}`} className="grid grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 border-t border-gray-800 px-3.5 py-2.5 text-[13px] max-sm:grid-cols-[minmax(0,1fr)] max-sm:gap-1">
                      <span className="font-data text-[12px] text-gray-500">{fmt(k.before.date)}</span>
                      <Session s={k.before} />
                      <span className="font-data text-[11px] text-gray-500">kept: you changed this one</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-500">No sessions would change.</p>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" disabled={busy} onClick={() => act("discard")} className="cursor-pointer rounded-[10px] border border-gray-700 px-4 py-2 text-sm font-semibold text-gray-300 hover:border-gray-600 disabled:opacity-50">Discard</button>
                <button type="button" disabled={busy || !checked?.changes.length} onClick={() => act("apply")} className="cursor-pointer rounded-[10px] bg-orange-500 px-4 py-2 text-sm font-semibold text-[var(--accent-fg)] hover:bg-orange-400 disabled:opacity-50">Apply changes</button>
              </div>
            </>
          )}
        </div>
      )}

      {(asking || adj?.status === "ready" || adj?.status === "applied") && (
        <form
          className="mt-4 flex items-center gap-2 rounded-[14px] border border-gray-800 bg-gray-950/60 py-1.5 pl-4 pr-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            if (!t) return;
            // A reply refines the open proposal: the coach sees both requests.
            void ask(adj?.status === "ready" ? `${adj.request}\nFollow-up: ${t}` : t);
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            // The request (with any follow-up) is capped at 600 characters.
            maxLength={adj?.status === "ready" ? Math.max(0, 600 - adj.request.length - 12) : 600}
            aria-label={adj?.status === "ready" ? "Reply to refine the proposal" : "What should change?"}
            placeholder={adj?.status === "ready" ? 'Reply to refine, e.g. "keep one short run with strides"' : "What's changed? The coach will propose updates to your upcoming sessions."}
            className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none"
          />
          <button type="submit" disabled={busy || !text.trim()} className="cursor-pointer rounded-[10px] bg-orange-500 px-4 py-2 text-sm font-semibold text-[var(--accent-fg)] hover:bg-orange-400 disabled:cursor-default disabled:opacity-50">
            {adj?.status === "ready" ? "Send" : "Ask"}
          </button>
        </form>
      )}
      {asking && (
        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button key={e} type="button" onClick={() => setText(e)} className="cursor-pointer rounded-full border border-gray-800 px-3 py-1 text-[12px] text-gray-400 hover:border-gray-700 hover:text-white">
              {e}
            </button>
          ))}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-[var(--err)]" role="alert">{error}</p>}
    </section>
  );
}
