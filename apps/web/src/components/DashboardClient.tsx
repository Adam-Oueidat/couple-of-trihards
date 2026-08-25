"use client";

import { useEffect, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { refreshDashboard } from "@/app/dashboard/actions";
import { StravaActivity, WeeklyVolume } from "@trihards/core";
import { TrainingLoadPoint, type TrainingPlan } from "@trihards/core";
import type { PlanSummary } from "@/lib/training-plans";
import type { PlanOverrideMap } from "@trihards/core";
import type { CustomWorkout } from "@/lib/workouts";
import { mutate } from "swr";
import { usePlanEdits } from "./usePlanEdits";

// recharts pulls in d3-scale/d3-shape/victory-vendor and roughly doubles the
// dashboard's first-load JS. Loading it on demand keeps it out of the initial
// bundle. ssr: false because ResponsiveContainer measures a real DOM node —
// server-rendering it produces a zero-width chart and a hydration mismatch.
// The placeholders match each chart's ResponsiveContainer height (240px) so
// deferring the load costs no layout shift.
const ChartFallback = () => (
  <div className="h-[240px] w-full animate-pulse rounded-lg bg-black/5 dark:bg-white/5" />
);

const WeeklyVolumeChart = dynamic(
  () => import("./WeeklyVolumeChart").then((m) => m.WeeklyVolumeChart),
  { ssr: false, loading: ChartFallback },
);
const TrainingLoadChart = dynamic(
  () => import("./TrainingLoadChart").then((m) => m.TrainingLoadChart),
  { ssr: false, loading: ChartFallback },
);
import { ActivityList } from "./ActivityList";
import { OverviewHero } from "./OverviewHero";
import { SectionLabel } from "./SectionLabel";
import { LogoutButton } from "./LogoutButton";
import { CoachChat } from "./CoachChat";
// Only ever rendered on the plan tab, so athletes who stay on Overview never
// download it at all.
const PlannedVsActual = dynamic(
  () => import("./PlannedVsActual").then((m) => m.PlannedVsActual),
  { ssr: false, loading: ChartFallback },
);
import { CalendarTab } from "./CalendarTab";
import { PlanSourceCard } from "./PlanSourceCard";
import { GoalsCard, GOALS_KEY } from "./GoalsCard";
import { FitnessProfile, FITNESS_KEY } from "./FitnessProfile";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  athlete: { firstname: string; lastname: string; profile: string };
  activities: StravaActivity[];
  weeklyVolume: WeeklyVolume[];
  /** Current calendar week (resets Monday); zero-filled until trained in. */
  currentWeek: WeeklyVolume;
  trainingLoad: TrainingLoadPoint[];
  /** Unix-millis of the last real Strava sync; null before any data is cached. */
  syncedAt: number | null;
  /** This athlete's active plan, or null when they have not uploaded one. */
  trainingPlan: TrainingPlan | null;
  planSummary: PlanSummary | null;
  /** Moved/hidden plan sessions, keyed by session id. Seeds the client state. */
  planOverrides: PlanOverrideMap;
  /** Workouts the athlete (or the coach) added outside the plan. */
  customWorkouts: CustomWorkout[];
  isAdmin: boolean;
}

type Tab = "overview" | "plan" | "calendar" | "activities";

// "Synced …" label from a real sync timestamp (Unix millis). Only ever called
// from async callbacks (never during render), so Date.now() stays out of the
// render path. Goes up to days because the timestamp is the persisted last sync,
// which can be arbitrarily old across plain refreshes.
function formatAgo(syncedAt: number): string {
  const secs = Math.max(0, Math.round((Date.now() - syncedAt) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function DashboardClient({ athlete, activities, weeklyVolume, currentWeek, trainingLoad, syncedAt, trainingPlan, planSummary, planOverrides, customWorkouts, isAdmin }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [coachOpen, setCoachOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pending, startTransition] = useTransition();

  // Seeded from the server render, then swapped in place when the athlete
  // uploads or removes a plan, so the plan and calendar tabs update without a
  // round trip through the server component. Both are null when this athlete
  // has no plan of their own.
  const [plan, setPlan] = useState<{
    plan: TrainingPlan | null;
    summary: PlanSummary | null;
  }>(() => ({ plan: trainingPlan, summary: planSummary }));

  // Session moves and custom workouts live here rather than inside the tabs
  // that render them. Both tabs unmount when the athlete switches away, so
  // tab-local state was refetched from scratch on every visit — the calendar
  // remounted with no overrides, painted the plan on its original dates, then
  // jumped everything into place when the fetch landed. Held here (and seeded
  // by the server render) the data is already there on the first frame.
  // Revalidated when the athlete opens a tab that shows it, or hits Sync, so
  // workouts the coach wrote from chat still appear without a page reload.
  const edits = usePlanEdits(
    { overrides: planOverrides, workouts: customWorkouts },
    tab === "calendar" || tab === "plan" ? `${tab}:${refreshKey}` : null,
  );

  // Client-only "Synced …" clock, driven by the real last-sync timestamp
  // (syncedAt) rather than mount time — so a plain refresh keeps counting up
  // from the actual sync, and only a real Sync (which changes syncedAt) resets
  // it to "just now". Renders empty on the server / first paint (no hydration
  // mismatch); setState is only called from timer callbacks, never synchronously
  // in the effect body.
  const [agoLabel, setAgoLabel] = useState("");
  useEffect(() => {
    // No cached row yet → leave the label empty (its initial state); the strip
    // renders nothing until a real sync exists.
    if (syncedAt == null) return;
    const update = () => setAgoLabel(formatAgo(syncedAt));
    const soon = setTimeout(update, 0);
    const tick = setInterval(update, 60_000);
    return () => {
      clearTimeout(soon);
      clearInterval(tick);
    };
  }, [syncedAt]);

  function refresh() {
    startTransition(async () => {
      try {
        await refreshDashboard();
        // Server Component data updates via revalidatePath. The client-fetched
        // cards revalidate through SWR's cache instead of a counter threaded
        // down as a prop: Goals and Fitness own their own keys, and bumping
        // refreshKey still re-keys the plan-edits hook.
        await Promise.all([mutate(GOALS_KEY), mutate(FITNESS_KEY)]);
        setRefreshKey((k) => k + 1);
      } catch {
        // Refresh failed (e.g. expired session); keep the current data rather
        // than throwing an unhandled rejection out of the transition.
      }
    });
  }

  // Phone-only overflow menu. The four tabs stay on screen — they are the
  // primary navigation and hiding them behind a tap would be a downgrade —
  // but Admin, the theme toggle and Sign out together take ~190px of a
  // 428px-wide row, squeezing the tabs until their labels overflow. They
  // live in here instead. Never opens above `sm`: the trigger is `sm:hidden`.
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const recentWeeks = weeklyVolume.slice(-8);
  const recentLoad = trainingLoad.slice(-60);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between max-sm:flex-wrap max-sm:gap-y-3">
          <div className="flex items-center gap-3">
            {athlete.profile && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={athlete.profile}
                alt={athlete.firstname}
                className="w-9 h-9 rounded-full border-2 border-orange-500"
              />
            )}
            <div>
              <Link
                href="/dashboard"
                aria-label="TriLog — go to dashboard"
                className="inline-block cursor-pointer transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 rounded"
              >
                <h1 className="font-display font-bold text-xl text-white leading-none uppercase tracking-wide">
                  Tri<span className="text-orange-500">Log</span>
                </h1>
              </Link>
              <p className="text-gray-400 text-xs">
                {athlete.firstname} {athlete.lastname}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className="sm:hidden flex flex-col items-center justify-center gap-[3px] w-10 h-10 -mr-1 rounded-lg border border-gray-800 cursor-pointer"
          >
            <span
              className={`block w-4 h-px bg-gray-300 transition-transform ${
                menuOpen ? "translate-y-[4px] rotate-45" : ""
              }`}
            />
            <span
              className={`block w-4 h-px bg-gray-300 transition-opacity ${
                menuOpen ? "opacity-0" : ""
              }`}
            />
            <span
              className={`block w-4 h-px bg-gray-300 transition-transform ${
                menuOpen ? "-translate-y-[4px] -rotate-45" : ""
              }`}
            />
          </button>

          <div className="flex items-center gap-4 max-sm:w-full max-sm:gap-2">
            <nav className="flex gap-1 bg-gray-800 rounded-lg p-1 max-sm:flex-1">
              {(["overview", "plan", "calendar", "activities"] as Tab[]).map((t) => (
                <button
                  type="button"
                  key={t}
                  onClick={() => {
                    setTab(t);
                    setMenuOpen(false);
                  }}
                  className={`px-4 py-1.5 rounded-md text-sm font-medium capitalize transition-colors max-sm:flex-1 max-sm:px-2 max-sm:py-2.5 max-sm:text-xs ${
                    tab === t
                      ? "bg-orange-500 text-white"
                      : "text-gray-400 hover:text-white"
                  }`}
                >
                  {t}
                </button>
              ))}
            </nav>
            {isAdmin && (
              <Link
                href="/admin/licenses"
                className="px-3 py-1.5 rounded-md border border-orange-500/40 bg-orange-500/10 text-orange-300 hover:bg-orange-500/20 hover:border-orange-500 text-sm font-medium transition-colors cursor-pointer max-sm:hidden"
              >
                Admin
              </Link>
            )}
            <div className="max-sm:hidden sm:contents">
              <ThemeToggle />
              <LogoutButton />
            </div>
          </div>

          {menuOpen && (
            <div
              id="mobile-menu"
              className="sm:hidden w-full flex items-center justify-end gap-3 pt-3 border-t border-gray-800"
            >
              {isAdmin && (
                <Link
                  href="/admin/licenses"
                  onClick={() => setMenuOpen(false)}
                  className="mr-auto px-3 py-2 rounded-md border border-orange-500/40 bg-orange-500/10 text-orange-300 text-sm font-medium cursor-pointer"
                >
                  Admin
                </Link>
              )}
              <ThemeToggle />
              <LogoutButton />
            </div>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {/* Sync-status strip: keeps data freshness next to the data it governs,
            instead of crowding the global header. */}
        <div className="mb-5 flex items-center justify-end gap-3 text-xs">
          {agoLabel && (
            <span className="inline-flex items-center gap-2 uppercase tracking-wider text-gray-500">
              <span
                className={`h-1.5 w-1.5 rounded-full bg-orange-500 ${pending ? "animate-pulse" : ""}`}
                aria-hidden="true"
              />
              Synced {agoLabel}
            </span>
          )}
          <button
            type="button"
            onClick={refresh}
            disabled={pending}
            aria-label="Sync data from Strava"
            className="group inline-flex items-center gap-1.5 rounded-full border border-gray-800 px-3 py-1.5 font-medium uppercase tracking-wider text-gray-400 transition-colors hover:border-gray-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`h-3.5 w-3.5 transition-transform duration-500 motion-reduce:transition-none ${
                pending ? "animate-spin motion-reduce:animate-none" : "group-hover:-rotate-180"
              }`}
              aria-hidden="true"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
            {pending ? "Syncing…" : "Sync"}
          </button>
        </div>

        {tab === "overview" ? (
          <div className="space-y-6">
            <OverviewHero currentWeek={currentWeek} trainingLoad={recentLoad} />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
                <SectionLabel>Weekly Volume</SectionLabel>
                <WeeklyVolumeChart data={recentWeeks} />
              </div>

              <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
                <SectionLabel>Training Load · ATL / CTL / TSB</SectionLabel>
                <TrainingLoadChart data={recentLoad} />
              </div>
            </div>

            <GoalsCard />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 bg-gray-900 border border-gray-800 rounded-2xl p-5">
                <SectionLabel>Recent Activities</SectionLabel>
                <ActivityList activities={activities.slice(0, 5)} />
              </div>
              <FitnessProfile />
            </div>
          </div>
        ) : tab === "plan" ? (
          <div className="space-y-6">
            <PlanSourceCard
              plan={plan.plan}
              summary={plan.summary}
              onPlanChange={(next, summary) => setPlan({ plan: next, summary })}
            />

            <PlannedVsActual activities={activities} plan={plan.plan} edits={edits} />
          </div>
        ) : tab === "calendar" ? (
          <CalendarTab activities={activities} plan={plan.plan} edits={edits} />
        ) : (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">
              All Activities (last 12 weeks)
            </h2>
            <ActivityList activities={activities} sortable />
          </div>
        )}
      </main>

      {/* Coach panel: always mounted so the conversation survives tab
          switches and panel toggles; only its visibility changes. */}
      <div
        className={`fixed inset-y-0 right-0 z-40 w-full sm:w-[420px] p-4 pl-0 pb-20 ${
          coachOpen ? "" : "hidden"
        }`}
      >
        <div className="h-full shadow-2xl shadow-black/60">
          <CoachChat />
        </div>
      </div>

      <button
        type="button"
        onClick={() => setCoachOpen((o) => !o)}
        className={`fixed bottom-5 right-5 z-50 px-5 py-3 rounded-full text-sm font-bold shadow-xl transition-colors cursor-pointer ${
          coachOpen
            ? "bg-gray-700 hover:bg-gray-600 text-white"
            : "bg-orange-500 hover:bg-orange-400 text-white"
        }`}
      >
        {coachOpen ? "Close coach" : "Coach"}
      </button>
    </div>
  );
}
