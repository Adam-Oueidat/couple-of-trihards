"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { PlanOverrideMap } from "@trihards/core";
import type { CustomWorkout } from "@/lib/workouts";

/**
 * The athlete's edits on top of their plan: moved/hidden plan sessions
 * (overrides) and the workouts they added themselves.
 *
 * Both the calendar and the plan tab render from these, and both tabs unmount
 * when the athlete switches away. Owning the state here — in a hook the
 * dashboard shell holds, seeded from the server render — keeps the data alive
 * across tab switches, so a tab that remounts paints its final layout on the
 * first frame instead of drawing the un-moved plan and snapping once a fetch
 * lands.
 */
export interface PlanEdits {
  overrides: PlanOverrideMap;
  workouts: CustomWorkout[];
  setOverrides: Dispatch<SetStateAction<PlanOverrideMap>>;
  setWorkouts: Dispatch<SetStateAction<CustomWorkout[]>>;
  /** Re-read from the server; used after a mutation to settle optimistic state. */
  reloadOverrides: () => Promise<void>;
  reloadWorkouts: () => Promise<void>;
}

export interface PlanEditsSeed {
  overrides: PlanOverrideMap;
  workouts: CustomWorkout[];
}

/**
 * `seed` comes from the server component, so the first paint is already
 * correct. `revalidateKey` is refetch bait: change it (on a tab switch, on a
 * Sync) to pull anything written elsewhere — the coach adds workouts straight
 * to the database from chat, and those only surface on a re-read. The refetch
 * replaces equal data with equal data, so it is invisible; only a genuine
 * change moves anything on screen.
 */
export function usePlanEdits(seed: PlanEditsSeed, revalidateKey: unknown): PlanEdits {
  const [overrides, setOverrides] = useState<PlanOverrideMap>(seed.overrides);
  const [workouts, setWorkouts] = useState<CustomWorkout[]>(seed.workouts);

  const reloadOverrides = useCallback(async () => {
    try {
      const res = await fetch("/api/plan-overrides");
      if (res.ok) setOverrides(await res.json());
    } catch {
      // non-fatal: keep what we have
    }
  }, []);

  const reloadWorkouts = useCallback(async () => {
    try {
      const res = await fetch("/api/workouts");
      if (res.ok) setWorkouts(await res.json());
    } catch {
      // non-fatal: keep what we have
    }
  }, []);

  // Skips the mount pass: the seed is this same data, fetched moments ago by
  // the server render, so re-reading it immediately would be a wasted round
  // trip.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    void Promise.all([reloadOverrides(), reloadWorkouts()]);
  }, [revalidateKey, reloadOverrides, reloadWorkouts]);

  return {
    overrides,
    workouts,
    setOverrides,
    setWorkouts,
    reloadOverrides,
    reloadWorkouts,
  };
}
