"use client";

import { useEffect, useState } from "react";
import type { Discipline, TrainingPlan } from "@trihards/core";
import { daysUntilRace } from "@trihards/core";
import type { PlanSummary } from "@/lib/training-plans";
import { DISCIPLINE_PILL, DisciplineGlyph } from "./DisciplineGlyph";
import { SectionLabel } from "./SectionLabel";

interface Props {
  /** This athlete's plan, or null when they have not uploaded one. */
  plan: TrainingPlan | null;
  summary: PlanSummary | null;
  /** Called with the plan the athlete's calendar should now render. */
  onPlanChange: (plan: TrainingPlan | null, summary: PlanSummary | null) => void;
}

const ACCEPT = ".pdf,.md,.txt,application/pdf,text/markdown,text/plain";

function formatDate(date: string): string {
  return new Date(date + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function Pill({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
        className || "border-gray-700 text-gray-500"
      }`}
    >
      {children}
    </span>
  );
}

export function PlanSourceCard({ plan, summary, onPlanChange }: Props) {
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/plan/upload", { method: "POST", body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not read that plan.");
      onPlanChange(data.plan ?? null, data.summary ?? null);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that plan.");
    } finally {
      setUploading(false);
    }
  }

  async function removePlan() {
    if (!summary || removing) return;
    setRemoving(true);
    try {
      const res = await fetch(`/api/plan?id=${encodeURIComponent(summary.id)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        const data = await res.json();
        onPlanChange(data.plan ?? null, data.summary ?? null);
      }
    } finally {
      setRemoving(false);
    }
  }

  const uploadButton = (
    <button
      type="button"
      onClick={() => {
        setError(null);
        setOpen(true);
      }}
      className="px-4 py-2 rounded-lg border border-orange-500/40 bg-orange-500/10 text-orange-300 hover:bg-orange-500/20 hover:border-orange-500 text-sm font-semibold transition-colors cursor-pointer"
    >
      Upload a plan
    </button>
  );

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      {plan && summary ? (
        <>
          <SectionLabel
            trailing={
              <Pill className="border-orange-500/30 bg-orange-500/15 text-orange-400">
                Race in {daysUntilRace(plan)} days
              </Pill>
            }
          >
            Training plan
          </SectionLabel>

          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <h3 className="font-display text-xl uppercase tracking-wide text-white leading-tight truncate">
                {summary.name}
              </h3>
              <p className="text-gray-500 text-xs mt-1">
                {summary.raceName} · {formatDate(summary.raceDate)}
              </p>

              <div className="flex flex-wrap items-center gap-2 mt-3">
                <PlanDisciplinePill discipline={summary.discipline} />
                <Pill>{summary.sessionCount} sessions</Pill>
                <Pill>{summary.source}</Pill>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={removePlan}
                disabled={removing}
                className="text-sm font-medium text-gray-500 hover:text-red-400 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {removing ? "Removing…" : "Remove"}
              </button>
              {uploadButton}
            </div>
          </div>

          <p className="text-gray-600 text-xs mt-4">
            Uploading again makes the new plan your calendar. Earlier plans are
            kept — remove this one to go back to the plan before it.
          </p>
        </>
      ) : (
        <>
          <SectionLabel>Training plan</SectionLabel>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <h3 className="font-display text-xl uppercase tracking-wide text-white leading-tight">
                No plan yet
              </h3>
              <p className="text-gray-500 text-xs mt-1 max-w-md">
                Upload the plan your coach or training app gave you and every
                session lands on your calendar, dated. Until then your calendar
                shows only the workouts you add yourself, and your coach works
                from your training data alone.
              </p>
            </div>
            {uploadButton}
          </div>
        </>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close dialog"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/70 cursor-default"
          />
          <div className="relative bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md p-7">
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-md text-gray-500 hover:text-white hover:bg-gray-800 text-xl leading-none transition-colors cursor-pointer"
            >
              ×
            </button>
            <h3 className="text-white font-bold mb-1 pr-8">Upload a plan</h3>
            <p className="text-gray-500 text-xs mb-5">
              Every session in the document lands on your calendar, dated.
            </p>

            <label
              onDragOver={(e) => {
                e.preventDefault();
                if (!dragging) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file && !uploading) void upload(file);
              }}
              className={`flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition-colors ${
                uploading ? "cursor-wait" : "cursor-pointer"
              } ${
                dragging
                  ? "border-orange-500 bg-orange-500/10"
                  : "border-gray-700 bg-gray-950/50 hover:border-gray-600"
              }`}
            >
              <input
                type="file"
                accept={ACCEPT}
                disabled={uploading}
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Clear the input so re-picking the same file still fires.
                  e.target.value = "";
                  if (file) void upload(file);
                }}
              />
              {uploading ? (
                <>
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-orange-500 animate-pulse motion-reduce:animate-none"
                    aria-hidden
                  />
                  <span className="text-sm font-semibold text-white">
                    Reading your plan…
                  </span>
                  <span className="text-xs text-gray-500">
                    This takes up to a minute for a full training block.
                  </span>
                </>
              ) : (
                <>
                  <span className="text-sm font-semibold text-white">
                    Drop your plan here, or choose a file
                  </span>
                  <span className="text-xs text-gray-500">
                    PDF, Markdown, or text · up to 10 MB
                  </span>
                </>
              )}
            </label>

            {error && <p className="text-red-400 text-xs mt-4">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function PlanDisciplinePill({ discipline }: { discipline: string }) {
  const resolved: Discipline =
    discipline === "ride" || discipline === "swim" ? discipline : "run";
  return (
    <Pill className={DISCIPLINE_PILL[resolved] ?? ""}>
      <DisciplineGlyph discipline={resolved} size={11} />
      {discipline}
    </Pill>
  );
}
