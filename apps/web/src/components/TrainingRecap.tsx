"use client";

import { useState } from "react";
import { BLOCK_WEEKS, type BlockRecap, type PlanRecap } from "@trihards/core";
import { BlockPanel } from "./recap/BlockPanel";
import { PlanRecapPanel } from "./recap/PlanRecapPanel";

const RANGE_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
});

interface Props {
  block: BlockRecap;
  /** The athlete's most recently finished plan, or null when they have none. */
  plan: PlanRecap | null;
}

type View = "block" | "plan";

/**
 * The recap card: what the last six weeks amounted to, and how the last plan
 * went.
 *
 * Six weeks is not a round number chosen for tidiness. CTL — the "Fitness"
 * figure this dashboard already shows — is a 42-day exponential average, so a
 * six-week window is exactly the training that produced the fitness the athlete
 * is carrying today. Shorter reads as noise; longer averages across two
 * different training phases and stops describing either.
 *
 * Both views are built server-side from the athlete's own history and plan, so
 * this component does no arithmetic — it renders a reading that the numbers
 * beside it can be checked against.
 */
export function TrainingRecap({ block, plan }: Props) {
  const [view, setView] = useState<View>("block");
  const active = plan ? view : "block";

  const range = `${RANGE_FMT.format(new Date(`${block.start}T12:00:00`))} – ${RANGE_FMT.format(
    new Date(`${block.end}T12:00:00`),
  )}`;

  return (
    <section className="relative overflow-hidden rounded-2xl border border-gray-800 bg-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-gray-800 px-6 py-4 sm:px-7">
        <div className="flex items-baseline gap-3">
          <span
            className="h-3.5 w-[3px] flex-shrink-0 self-center rounded-full"
            style={{ background: "var(--accent)" }}
            aria-hidden
          />
          <h2 className="font-display text-[13px] uppercase leading-none tracking-[0.2em] text-gray-400">
            {active === "block" ? `The last ${BLOCK_WEEKS} weeks` : "Your last plan"}
          </h2>
          <span className="font-data text-[11px] text-gray-600 max-sm:hidden">
            {active === "block" ? range : plan?.raceName}
          </span>
        </div>

        {plan && (
          <div
            className="flex gap-1 rounded-lg bg-gray-800 p-1"
            role="tablist"
            aria-label="Recap view"
          >
            {(
              [
                ["block", "This block"],
                ["plan", "Last plan"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active === key}
                onClick={() => setView(key)}
                className={`cursor-pointer rounded-md px-3 py-1 font-display text-[12px] uppercase tracking-wider transition-colors ${
                  active === key
                    ? "bg-orange-500 text-[var(--accent-fg)]"
                    : "text-gray-500 hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {active === "plan" && plan ? (
        <PlanRecapPanel recap={plan} />
      ) : (
        <BlockPanel recap={block} />
      )}
    </section>
  );
}
