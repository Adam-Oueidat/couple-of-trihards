"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { refreshDashboard } from "@/app/dashboard/actions";
import { StravaActivity, WeeklyVolume } from "@trihards/core";
import { TrainingLoadPoint } from "@trihards/core";
import { WeeklyVolumeChart } from "./WeeklyVolumeChart";
import { TrainingLoadChart } from "./TrainingLoadChart";
import { ActivityList } from "./ActivityList";
import { OverviewHero } from "./OverviewHero";
import { SectionLabel } from "./SectionLabel";
import { LogoutButton } from "./LogoutButton";
import { CoachChat } from "./CoachChat";
import { PlannedVsActual } from "./PlannedVsActual";
import { CalendarTab } from "./CalendarTab";
import { GoalsCard } from "./GoalsCard";
import { FitnessProfile } from "./FitnessProfile";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  athlete: { firstname: string; lastname: string; profile: string };
  activities: StravaActivity[];
  weeklyVolume: WeeklyVolume[];
  trainingLoad: TrainingLoadPoint[];
  isAdmin: boolean;
}

type Tab = "overview" | "plan" | "calendar" | "activities";

// "Updated …" label from a load timestamp. Only ever called from async
// callbacks (never during render), so Date.now() stays out of the render path.
function formatAgo(loadedAt: number): string {
  const secs = Math.max(0, Math.round((Date.now() - loadedAt) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return `${hours}h ago`;
}

export function DashboardClient({ athlete, activities, weeklyVolume, trainingLoad, isAdmin }: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [coachOpen, setCoachOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pending, startTransition] = useTransition();

  // Client-only "Updated …" clock. Keyed on refreshKey so it resets to "just
  // now" after each refresh. Renders empty on the server / first paint (no
  // hydration mismatch); setState is only called from timer callbacks, never
  // synchronously in the effect body.
  const [agoLabel, setAgoLabel] = useState("");
  useEffect(() => {
    const loadedAt = Date.now();
    const update = () => setAgoLabel(formatAgo(loadedAt));
    const soon = setTimeout(update, 0);
    const tick = setInterval(update, 60_000);
    return () => {
      clearTimeout(soon);
      clearInterval(tick);
    };
  }, [refreshKey]);

  function refresh() {
    startTransition(async () => {
      try {
        await refreshDashboard();
        // Server Component data updates via revalidatePath; bump the key so the
        // client-fetched cards (Goals, Fitness) refetch too.
        setRefreshKey((k) => k + 1);
      } catch {
        // Refresh failed (e.g. expired session); keep the current data rather
        // than throwing an unhandled rejection out of the transition.
      }
    });
  }

  const recentWeeks = weeklyVolume.slice(-8);
  const currentWeek = weeklyVolume[weeklyVolume.length - 1];
  const recentLoad = trainingLoad.slice(-60);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
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

          <div className="flex items-center gap-4">
            <nav className="flex gap-1 bg-gray-800 rounded-lg p-1">
              {(["overview", "plan", "calendar", "activities"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-4 py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${
                    tab === t
                      ? "bg-orange-500 text-white"
                      : "text-gray-400 hover:text-white"
                  }`}
                >
                  {t}
                </button>
              ))}
            </nav>
            <div className="flex items-center gap-2">
              {agoLabel && (
                <span className="hidden sm:inline text-xs text-gray-500">Updated {agoLabel}</span>
              )}
              <button
                type="button"
                onClick={refresh}
                disabled={pending}
                aria-label="Refresh data from Strava"
                className="flex items-center gap-1.5 rounded-md border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-300 transition-colors hover:border-gray-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`h-4 w-4 ${pending ? "animate-spin" : ""}`}
                  aria-hidden="true"
                >
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <path d="M21 3v6h-6" />
                </svg>
                {pending ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            {isAdmin && (
              <Link
                href="/admin/licenses"
                className="px-3 py-1.5 rounded-md border border-orange-500/40 bg-orange-500/10 text-orange-300 hover:bg-orange-500/20 hover:border-orange-500 text-sm font-medium transition-colors cursor-pointer"
              >
                Admin
              </Link>
            )}
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
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

            <GoalsCard refreshKey={refreshKey} />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 bg-gray-900 border border-gray-800 rounded-2xl p-5">
                <SectionLabel>Recent Activities</SectionLabel>
                <ActivityList activities={activities.slice(0, 5)} />
              </div>
              <FitnessProfile refreshKey={refreshKey} />
            </div>
          </div>
        ) : tab === "plan" ? (
          <PlannedVsActual activities={activities} />
        ) : tab === "calendar" ? (
          <CalendarTab activities={activities} />
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
