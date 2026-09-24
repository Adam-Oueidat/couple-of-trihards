"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import type { Goal } from "@/lib/goals";
import { fetcher } from "@/lib/fetcher";
import { SectionLabel } from "./SectionLabel";

export const GOALS_KEY = "/api/goals";

const ARCHIVED_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/**
 * `compact` is the feed's side panel: the heading and list stay, the
 * explanation goes, and the input's example shrinks to fit 300px.
 */
export function GoalsCard({ compact = false }: { compact?: boolean } = {}) {
  // No refreshKey prop any more: Sync revalidates this key directly.
  const { data, mutate } = useSWR<Goal[]>(GOALS_KEY, fetcher, {
    revalidateOnFocus: false,
  });
  const all = data ?? [];
  const goals = all.filter((g) => g.archivedAt == null);
  // Newest first: the archive reads as a history, most recent at the top.
  const archived = all
    .filter((g) => g.archivedAt != null)
    .toSorted((a, b) => b.archivedAt! - a.archivedAt!);
  const [showArchive, setShowArchive] = useState(false);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    await mutate();
  }, [mutate]);


  async function add() {
    const text = input.trim();
    if (!text || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        setInput("");
        await load();
      }
    } finally {
      setSaving(false);
    }
  }

  async function setArchived(id: string, value: boolean) {
    await fetch(`/api/goals?id=${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: value }),
    });
    await load();
  }

  async function remove(id: string) {
    await fetch(`/api/goals?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-[14px] p-5">
      {compact ? (
        <h2 className="font-data text-[11px] uppercase tracking-[0.12em] text-gray-500 mb-3">Goals</h2>
      ) : (
        <>
          <SectionLabel className="mb-1">Goals</SectionLabel>
          <p className="text-gray-600 text-xs mb-4 pl-[14px]">
            Your AI coach reads these and aligns all advice and analysis with them.
          </p>
        </>
      )}

      {goals.length > 0 && (
        <ul className="space-y-2 mb-4">
          {goals.map((g) => (
            <li
              key={g.id}
              className="flex items-center gap-3 px-3 py-2 rounded-lg border border-gray-800 bg-gray-950/50 group"
            >
              <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-orange-500" />
              <span className="flex-1 text-gray-200 text-sm">{g.text}</span>
              <span className="flex flex-shrink-0 items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                <button
                  type="button"
                  onClick={() => setArchived(g.id, true)}
                  title="Archive goal: keep it to look back on"
                  className="cursor-pointer rounded-[6px] border border-gray-700 px-2 py-0.5 text-[11px] text-gray-400 transition-colors hover:border-gray-600 hover:text-white"
                >
                  Archive
                </button>
                <button
                  type="button"
                  onClick={() => remove(g.id)}
                  title="Delete goal"
                  aria-label={`Delete goal: ${g.text}`}
                  className="cursor-pointer text-sm text-gray-600 hover:text-red-400"
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
        className="flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="New goal"
          placeholder={
            compact
              ? "Add a goal"
              : 'e.g. "Sub 1:45 at Copenhagen Half" or "Build toward a 70.3 next season"'
          }
          maxLength={300}
          className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
        />
        <button
          type="submit"
          disabled={saving || !input.trim()}
          className="px-4 py-2 bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors cursor-pointer"
        >
          Add
        </button>
      </form>

      {/* Goals the athlete is done with: achieved or dropped, kept to look
          back on. The feed's compact card leaves them out. */}
      {!compact && archived.length > 0 && (
        <div className="mt-5 border-t border-gray-800 pt-4">
          <button
            type="button"
            onClick={() => setShowArchive((v) => !v)}
            aria-expanded={showArchive}
            className="flex w-full cursor-pointer items-center justify-between text-left font-data text-[11px] uppercase tracking-[0.12em] text-gray-500 transition-colors hover:text-white"
          >
            <span>Archive · {archived.length}</span>
            <span aria-hidden>{showArchive ? "−" : "+"}</span>
          </button>
          {showArchive && (
            <ul className="mt-3 space-y-2">
              {archived.map((g) => (
                <li
                  key={g.id}
                  className="group flex items-center gap-3 rounded-lg border border-gray-800 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-400">{g.text}</p>
                    <p className="font-data text-[11px] text-gray-600">
                      Archived {ARCHIVED_FMT.format(new Date(g.archivedAt! * 1000))}
                    </p>
                  </div>
                  <span className="flex flex-shrink-0 items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                    <button
                      type="button"
                      onClick={() => setArchived(g.id, false)}
                      className="cursor-pointer rounded-[6px] border border-gray-700 px-2 py-0.5 text-[11px] text-gray-400 transition-colors hover:border-gray-600 hover:text-white"
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(g.id)}
                      title="Delete for good"
                      aria-label={`Delete archived goal: ${g.text}`}
                      className="cursor-pointer text-sm text-gray-600 hover:text-red-400"
                    >
                      ×
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
