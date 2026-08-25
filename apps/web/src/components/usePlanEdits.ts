"use client";

import { useCallback, type Dispatch, type SetStateAction } from "react";
import useSWR from "swr";
import type { PlanOverrideMap } from "@trihards/core";
import type { CustomWorkout } from "@/lib/workouts";
import { fetcher } from "@/lib/fetcher";

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

export const OVERRIDES_KEY = "/api/plan-overrides";
export const WORKOUTS_KEY = "/api/workouts";

/**
 * `seed` comes from the server component and is handed to SWR as
 * `fallbackData`, so the first paint is already correct with no request in
 * flight — the same job the old mount-skipping ref did, without the ref.
 *
 * `revalidateKey` is refetch bait: change it (on a tab switch, on a Sync) to
 * pull anything written elsewhere — the coach adds workouts straight to the
 * database from chat, and those only surface on a re-read. Passing null (the
 * athlete is on a tab that shows neither) suspends revalidation entirely.
 */
export function usePlanEdits(seed: PlanEditsSeed, revalidateKey: unknown): PlanEdits {
  // The key carries revalidateKey so a change to it is a new cache entry and
  // therefore a refetch, while `keepPreviousData` means the old values stay on
  // screen meanwhile — no flash back to the seed.
  const suffix = revalidateKey === null ? null : String(revalidateKey);

  const overridesSwr = useSWR<PlanOverrideMap>(
    suffix === null ? null : [OVERRIDES_KEY, suffix],
    ([url]: [string, string]) => fetcher<PlanOverrideMap>(url),
    {
      fallbackData: seed.overrides,
      keepPreviousData: true,
      revalidateOnFocus: false,
    },
  );

  const workoutsSwr = useSWR<CustomWorkout[]>(
    suffix === null ? null : [WORKOUTS_KEY, suffix],
    ([url]: [string, string]) => fetcher<CustomWorkout[]>(url),
    {
      fallbackData: seed.workouts,
      keepPreviousData: true,
      revalidateOnFocus: false,
    },
  );

  // Optimistic updates go through SWR's cache rather than a parallel useState,
  // so a revalidation that lands afterwards overwrites them instead of the two
  // sources disagreeing. `revalidate: false` keeps the optimistic value until
  // the caller explicitly reloads.
  const setOverrides = useCallback<Dispatch<SetStateAction<PlanOverrideMap>>>(
    (update) => {
      void overridesSwr.mutate(
        (current) =>
          typeof update === "function"
            ? (update as (p: PlanOverrideMap) => PlanOverrideMap)(current ?? {})
            : update,
        { revalidate: false },
      );
    },
    [overridesSwr],
  );

  const setWorkouts = useCallback<Dispatch<SetStateAction<CustomWorkout[]>>>(
    (update) => {
      void workoutsSwr.mutate(
        (current) =>
          typeof update === "function"
            ? (update as (p: CustomWorkout[]) => CustomWorkout[])(current ?? [])
            : update,
        { revalidate: false },
      );
    },
    [workoutsSwr],
  );

  const reloadOverrides = useCallback(async () => {
    await overridesSwr.mutate();
  }, [overridesSwr]);

  const reloadWorkouts = useCallback(async () => {
    await workoutsSwr.mutate();
  }, [workoutsSwr]);

  return {
    overrides: overridesSwr.data ?? seed.overrides,
    workouts: workoutsSwr.data ?? seed.workouts,
    setOverrides,
    setWorkouts,
    reloadOverrides,
    reloadWorkouts,
  };
}
