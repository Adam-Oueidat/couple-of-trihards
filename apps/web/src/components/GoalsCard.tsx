"use client";

import { useCallback, useEffect, useState } from "react";
import type { Goal } from "@/lib/goals";

export function GoalsCard() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/goals");
      if (res.ok) setGoals(await res.json());
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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

  async function remove(id: string) {
    await fetch(`/api/goals?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-1">
        Goals
      </h2>
      <p className="text-gray-600 text-xs mb-4">
        Your AI coach reads these and aligns all advice and analysis with them.
      </p>

      {goals.length > 0 && (
        <ul className="space-y-2 mb-4">
          {goals.map((g) => (
            <li
              key={g.id}
              className="flex items-center gap-3 px-3 py-2 rounded-lg border border-gray-800 bg-gray-950/50 group"
            >
              <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-orange-500" />
              <span className="flex-1 text-gray-200 text-sm">{g.text}</span>
              <button
                onClick={() => remove(g.id)}
                title="Remove goal"
                className="text-gray-600 hover:text-red-400 text-sm opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer flex-shrink-0"
              >
                ×
              </button>
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
          placeholder='e.g. "Sub 1:45 at Copenhagen Half" or "Build toward a 70.3 next season"'
          maxLength={300}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
        />
        <button
          type="submit"
          disabled={saving || !input.trim()}
          className="px-4 py-2 bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors cursor-pointer"
        >
          Add
        </button>
      </form>
    </div>
  );
}
