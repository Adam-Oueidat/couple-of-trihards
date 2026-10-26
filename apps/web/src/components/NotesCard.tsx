"use client";

import { useState } from "react";
import useSWR from "swr";
import type { AthleteNote, NoteKind } from "@/lib/brain-notes";
import { fetcher } from "@/lib/fetcher";
import { SectionLabel } from "./SectionLabel";

export const NOTES_KEY = "/api/notes";

// Kept here rather than imported: brain-notes.ts is server code.
const KIND_LABEL: Record<NoteKind, string> = {
  health: "Health",
  availability: "Availability",
  preference: "Preference",
  equipment: "Equipment",
  background: "Background",
  agreement: "Agreement",
};

const SAID_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * The coach's standing notes: what the athlete has said that it keeps in mind
 * for every chat, analysis and plan. The coach writes them; the athlete can
 * read them and remove one that is wrong or no longer true.
 */
export function NotesCard() {
  const { data, mutate } = useSWR<AthleteNote[]>(NOTES_KEY, fetcher, {
    revalidateOnFocus: false,
  });
  const notes = data ?? [];
  const [removing, setRemoving] = useState<string | null>(null);

  async function remove(id: string) {
    setRemoving(id);
    try {
      await fetch(`${NOTES_KEY}?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await mutate(notes.filter((n) => n.id !== id), { revalidate: true });
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-[14px] p-5">
      <SectionLabel className="mb-1">What your coach remembers</SectionLabel>
      <p className="text-gray-600 text-xs mb-4 pl-[14px]">
        Things you have told the coach that it keeps in mind for every chat, analysis and plan.
        Remove one that is wrong, or tell the coach what has changed.
      </p>

      {data && notes.length === 0 && (
        <p className="pl-[14px] text-sm text-gray-500">
          Nothing yet. Mention an injury, the days you can train or the kit you have, and the
          coach will remember it.
        </p>
      )}

      {notes.length > 0 && (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li
              key={n.id}
              className="group flex items-start gap-3 rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm text-gray-200">{n.text}</p>
                <p className="font-data text-[11px] text-gray-600">
                  {KIND_LABEL[n.kind]} · said {SAID_FMT.format(new Date(`${n.notedOn}T00:00:00Z`))}
                  {n.rulesOut.length > 0 &&
                    ` · no ${n.rulesOut.join(", ")}${n.until ? ` until ${n.until}` : ""}`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => remove(n.id)}
                disabled={removing === n.id}
                title="Forget this"
                aria-label={`Forget: ${n.text}`}
                className="flex-shrink-0 cursor-pointer text-sm text-gray-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100 group-focus-within:opacity-100 disabled:opacity-40 [@media(hover:none)]:opacity-100"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
