"use client";

import { useEffect, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { refreshDashboard } from "@/app/dashboard/actions";
import { StravaActivity, WeeklyVolume } from "@trihards/core";
import type { SyncState } from "@/lib/strava";
import { TrainingLoadPoint, type BlockRecap, type RunThreshold, type PlanRecap, type QualityRecap, type TrainingPlan } from "@trihards/core";
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
//
// All three go through "./charts" rather than their own modules on purpose:
// same specifier, same chunk, one copy of recharts between them. Importing
// them from their own files brings a private copy of the library each. See the
// header comment in charts.tsx.
const ChartFallback = () => (
  <div className="h-[240px] w-full animate-pulse rounded-lg bg-black/5 dark:bg-white/5" />
);

const WeeklyVolumeChart = dynamic(
  () => import("./charts").then((m) => m.WeeklyVolumeChart),
  { ssr: false, loading: ChartFallback },
);
const TrainingLoadChart = dynamic(
  () => import("./charts").then((m) => m.TrainingLoadChart),
  { ssr: false, loading: ChartFallback },
);
import { ActivityList } from "./ActivityList";
import { OverviewHero } from "./OverviewHero";
import { TrainingRecap } from "./TrainingRecap";
import { FeedTab } from "./FeedTab";
import { SectionLabel } from "./SectionLabel";
// The coach panel is behind a button and nobody sees it on first paint, but it
// used to be imported statically AND mounted on every load — so its JS sat in
// the initial bundle and its history fetch (/api/chat/history) ran on every
// dashboard render for a panel that was still hidden. Deferred on both counts:
// the code arrives with the first open, and so does the request.
const CoachChat = dynamic(() => import("./CoachChat").then((m) => m.CoachChat), {
  ssr: false,
});
// Only ever rendered on the plan tab. It shares the charts chunk with the two
// above, so an athlete who has been on Overview already has it.
const PlannedVsActual = dynamic(
  () => import("./charts").then((m) => m.PlannedVsActual),
  { ssr: false, loading: ChartFallback },
);
import { CalendarTab } from "./CalendarTab";
import { PlanSourceCard } from "./PlanSourceCard";
import { GOALS_KEY } from "./GoalsCard";
import { FITNESS_KEY } from "./FitnessProfile";
import { ProfileTab } from "./ProfileTab";
import { ThemeToggle } from "./ThemeToggle";
import { pathForTab, tabFromPathname, TAB_TITLES, type Tab } from "./dashboard-tabs";

interface Props {
  athlete: { firstname: string; lastname: string; profile: string };
  activities: StravaActivity[];
  /**
   * Activities covering the whole plan, not just the display window. The plan
   * and calendar tabs grade sessions against same-day activities, so a plan
   * longer than the display window was grading its earliest weeks against
   * activities that had been sliced away — sessions the athlete really ran
   * showed as "missed".
   */
  planActivities: StravaActivity[];
  weeklyVolume: WeeklyVolume[];
  /** Current calendar week (resets Monday); zero-filled until trained in. */
  currentWeek: WeeklyVolume;
  trainingLoad: TrainingLoadPoint[];
  /**
   * The last six weeks condensed, and the athlete's last finished plan read
   * back to them. Both are computed on the server: the block compares against
   * the six weeks before it, which reach further back than the activities sent
   * down here, and the plan recap summarises the last FINISHED plan, which is
   * usually not the active one below.
   */
  blockRecap: BlockRecap;
  planRecap: PlanRecap | null;
  /** What the heart-rate and pace history say about training quality. */
  qualityRecap: QualityRecap;
  /** Unix-millis of the last real Strava sync; null before any data is cached. */
  syncedAt: number | null;
  /** How current the figures below are. "refreshing" means a sync is running
   *  after this response — normal, and not an error. "unreachable" means the
   *  last attempt failed. Either way the data shown is complete, just behind. */
  syncState: SyncState;
  /** This athlete's active plan, or null when they have not uploaded one. */
  trainingPlan: TrainingPlan | null;
  planSummary: PlanSummary | null;
  /** Moved/hidden plan sessions, keyed by session id. Seeds the client state. */
  planOverrides: PlanOverrideMap;
  /** Workouts the athlete (or the coach) added outside the plan. */
  customWorkouts: CustomWorkout[];
  isAdmin: boolean;
  /** Athlete-local YYYY-MM-DD, as the server resolved it. */
  today: string;
  /** Same estimate the coach quotes; null when nothing recent sets it. */
  runThreshold: RunThreshold | null;
  /** Saved coach analyses, keyed by Strava activity id. */
  analyses: Record<number, string>;
}


const PRIMARY: { id: Tab; label: string }[] = [
  { id: "feed", label: "Feed" },
  { id: "plan", label: "Plan" },
  { id: "calendar", label: "Calendar" },
  { id: "activities", label: "Activities" },
  { id: "recap", label: "Recap" },
];


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

export function DashboardClient({ athlete, activities, planActivities, weeklyVolume, currentWeek, trainingLoad, blockRecap, planRecap, qualityRecap, syncedAt, syncState, trainingPlan, planSummary, planOverrides, customWorkouts, isAdmin, today, runThreshold, analyses }: Props) {
  // The page comes from the address, so a refresh, a bookmark or the Back
  // button lands where the athlete was. Switching pages pushes a new address
  // without a reload; Next.js keeps usePathname in step with pushState.
  const tab = tabFromPathname(usePathname());
  // The plan-upload dialog is opened from two places — the plan card itself
  // and "Upload your next plan" on a finished plan — so the shell owns it.
  const [uploadOpen, setUploadOpen] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  // Latches on the first open and never clears: the panel still has to survive
  // tab switches and being closed again, so once mounted it stays mounted and
  // only its visibility changes — exactly as before. All that has moved is when
  // that first mount happens.
  const [coachMounted, setCoachMounted] = useState(false);
  // What was typed into the ask bar, handed to the coach panel to send.
  const [queued, setQueued] = useState<{ id: number; text: string } | null>(null);
  const [ask, setAsk] = useState("");
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

  const recentWeeks = weeklyVolume.slice(-8);
  const recentLoad = trainingLoad.slice(-60);

  function go(next: Tab) {
    if (next === tab) return;
    window.history.pushState(null, "", pathForTab(next));
    window.scrollTo(0, 0);
  }

  // The server sets the title for the page it rendered; this keeps it right
  // after client-side switches and Back/Forward.
  useEffect(() => {
    document.title = tab === "feed" ? "TriLog" : `${TAB_TITLES[tab]} · TriLog`;
  }, [tab]);

  function openCoach(text?: string) {
    setCoachMounted(true);
    setCoachOpen(true);
    if (text) setQueued({ id: Date.now(), text });
  }

  const syncStatus = (
    <div className="flex flex-wrap items-center gap-2 font-data text-[11px] text-gray-500">
      {agoLabel && (
        <span className="inline-flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${syncState === "unreachable" ? "bg-orange-500" : "bg-[var(--ok)]"} ${pending ? "animate-pulse" : ""}`}
            aria-hidden="true"
          />
          {syncState === "unreachable" ? (
            <span title="Strava could not be reached for the last sync. These are your previous sync's activities.">
              Strava unreachable
            </span>
          ) : syncState === "refreshing" ? (
            <span title="Showing your last sync while a fresh one runs in the background. Reload in a moment to see it.">
              Syncing…
            </span>
          ) : (
            <>Synced {agoLabel}</>
          )}
        </span>
      )}
      <button
        type="button"
        onClick={refresh}
        disabled={pending}
        aria-label="Sync data from Strava"
        className="ml-auto cursor-pointer rounded-[8px] border border-gray-800 px-2.5 py-1 text-gray-400 transition-colors hover:border-gray-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Syncing…" : "Sync"}
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-950 text-white md:grid md:grid-cols-[220px_minmax(0,1fr)]">
      {/* Sidebar: md and up. */}
      <aside className="sticky top-0 hidden h-screen flex-col gap-1 border-r border-gray-800 px-3.5 py-6 md:flex">
        <Link
          href="/dashboard"
          aria-label="TriLog — go to dashboard"
          className="mb-5 cursor-pointer rounded px-2.5 transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        >
          <span className="font-display text-2xl font-bold uppercase leading-none tracking-wide text-white">
            Tri<span className="text-orange-500">Log</span>
          </span>
        </Link>

        <nav className="flex flex-col gap-1" aria-label="Main">
          {PRIMARY.map((item) => (
            <NavItem key={item.id} active={tab === item.id} onClick={() => go(item.id)}>
              {item.label}
            </NavItem>
          ))}
        </nav>

        <div className="mt-auto space-y-3">
          <div className="px-2.5">{syncStatus}</div>
          <div className="flex items-center gap-2 border-t border-gray-800 pt-3">
            {/* The athlete's own page: thresholds, fitness, goals, account. */}
            <button
              type="button"
              onClick={() => go("profile")}
              aria-current={tab === "profile" ? "page" : undefined}
              className={`flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left transition-colors ${
                tab === "profile" ? "bg-gray-800 text-white" : "text-gray-400 hover:bg-gray-900 hover:text-white"
              }`}
            >
              <Avatar athlete={athlete} size="sm" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                {athlete.firstname} {athlete.lastname?.[0] ? `${athlete.lastname[0]}.` : ""}
              </span>
            </button>
            <ThemeToggle />
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        {/* Phone header. */}
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-gray-800 bg-gray-950/95 px-4 py-3 backdrop-blur md:hidden">
          <Link href="/dashboard" aria-label="TriLog — go to dashboard" className="cursor-pointer">
            <span className="font-display text-xl font-bold uppercase leading-none tracking-wide text-white">
              Tri<span className="text-orange-500">Log</span>
            </span>
          </Link>
          <div className="min-w-0 flex-1">{syncStatus}</div>
          <button
            type="button"
            onClick={() => go("profile")}
            aria-label="Profile"
            aria-current={tab === "profile" ? "page" : undefined}
            className="shrink-0 cursor-pointer rounded-full"
          >
            <Avatar athlete={athlete} size="sm" />
          </button>
        </header>

        <main className="mx-auto max-w-[1080px] px-4 pb-44 pt-6 md:px-8 md:pb-28 md:pt-8">
          {tab !== "feed" && (
            <h1 className="mb-6 font-display text-4xl font-bold uppercase leading-none tracking-wide text-white">
              {TAB_TITLES[tab]}
            </h1>
          )}

          {tab === "feed" ? (
            <FeedTab
              activities={activities}
              weeklyVolume={weeklyVolume}
              currentWeek={currentWeek}
              trainingLoad={recentLoad}
              today={today}
              plan={plan.plan}
              runThreshold={runThreshold}
              analyses={analyses}
              onUploadPlan={() => {
                go("plan");
                setUploadOpen(true);
              }}
              onShowActivities={() => go("activities")}
            />
          ) : tab === "plan" ? (
            <div className="space-y-6">
              <PlanSourceCard
                plan={plan.plan}
                summary={plan.summary}
                onPlanChange={(next, summary) => setPlan({ plan: next, summary })}
                uploadOpen={uploadOpen}
                onUploadOpenChange={setUploadOpen}
              />
              <PlannedVsActual
                activities={planActivities}
                plan={plan.plan}
                edits={edits}
                onUploadNew={() => setUploadOpen(true)}
              />
            </div>
          ) : tab === "calendar" ? (
            <CalendarTab activities={planActivities} plan={plan.plan} edits={edits} />
          ) : tab === "activities" ? (
            <div className="rounded-[14px] border border-gray-800 bg-gray-900 p-5">
              <p className="mb-4 font-data text-[11px] uppercase tracking-[0.12em] text-gray-500">
                Last 12 weeks
              </p>
              <ActivityList activities={activities} sortable />
            </div>
          ) : tab === "recap" ? (
            <div className="space-y-6">
              <OverviewHero currentWeek={currentWeek} trainingLoad={recentLoad} />
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <div className="rounded-[14px] border border-gray-800 bg-gray-900 p-5">
                  <SectionLabel>Weekly Volume</SectionLabel>
                  <WeeklyVolumeChart data={recentWeeks} />
                </div>
                <div className="rounded-[14px] border border-gray-800 bg-gray-900 p-5">
                  <SectionLabel>Training Load · ATL / CTL / TSB</SectionLabel>
                  <TrainingLoadChart data={recentLoad} />
                </div>
              </div>
              {/* Defaults to the six-week block view: the plan view is one
                  click away, and the plan page already carries the finished
                  plan's headline adherence. */}
              <TrainingRecap block={blockRecap} plan={planRecap} quality={qualityRecap} />
            </div>
          ) : (
            <ProfileTab athlete={athlete} runThreshold={runThreshold} isAdmin={isAdmin} />
          )}
        </main>

        {/* Ask bar: the way into the coach from every page. Typing and
            sending opens the panel with the question already asked. */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const text = ask.trim();
            setAsk("");
            openCoach(text || undefined);
          }}
          className={`fixed inset-x-4 bottom-[84px] z-30 mx-auto flex max-w-[1016px] items-center gap-2 rounded-[14px] border border-gray-800 bg-gray-900 py-2 pl-4 pr-2 shadow-2xl shadow-black/40 md:bottom-5 md:left-[calc(220px+2rem)] md:right-8 ${
            coachOpen ? "hidden" : ""
          }`}
        >
          <input
            value={ask}
            onChange={(e) => setAsk(e.target.value)}
            aria-label="Ask your coach"
            placeholder="Ask your coach anything…"
            className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none"
          />
          <button
            type="submit"
            className="cursor-pointer rounded-[10px] bg-orange-500 px-4 py-2 text-sm font-semibold text-[var(--accent-fg)] transition-colors hover:bg-orange-400"
          >
            Ask
          </button>
        </form>
      </div>

      {/* Phone tab bar. */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 flex justify-around border-t border-gray-800 bg-gray-950/95 px-2 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-2 backdrop-blur md:hidden"
      >
        {PRIMARY.map((item) => (
          <TabButton key={item.id} active={tab === item.id} onClick={() => go(item.id)}>
            {item.label}
          </TabButton>
        ))}
      </nav>

      {/* Coach panel: mounted on the first open and kept mounted after, so the
          conversation survives page switches and closing the panel. */}
      {coachMounted && (
        <div
          className={`fixed inset-y-0 right-0 z-50 w-full p-4 sm:w-[420px] sm:pl-0 ${
            coachOpen ? "" : "hidden"
          }`}
        >
          <div className="h-full shadow-2xl shadow-black/60">
            <CoachChat queued={queued} onClose={() => setCoachOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}

function NavItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-sm font-medium transition-colors ${
        active ? "bg-gray-800 text-white" : "text-gray-400 hover:bg-gray-900 hover:text-white"
      }`}
    >
      {active && <span className="-ml-1.5 h-4 w-[3px] rounded-sm bg-orange-500" aria-hidden />}
      {children}
    </button>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex cursor-pointer flex-col items-center gap-1 px-2 py-1 text-[11px] font-semibold ${
        active ? "text-white" : "text-gray-500"
      }`}
    >
      <span className={`h-1 w-6 rounded-sm ${active ? "bg-orange-500" : "bg-gray-800"}`} aria-hidden />
      {children}
    </button>
  );
}

/** The athlete's Strava photo, or their initial when Strava has none. */
function Avatar({
  athlete,
  size,
}: {
  athlete: { firstname: string; profile: string };
  size: "sm";
}) {
  const box = size === "sm" ? "h-7 w-7 text-[13px]" : "";
  if (athlete.profile) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={athlete.profile} alt="" className={`${box} rounded-full border-2 border-orange-500`} />;
  }
  return (
    <span
      className={`${box} flex shrink-0 items-center justify-center rounded-full border-2 border-orange-500 font-display font-bold uppercase text-white`}
      aria-hidden
    >
      {athlete.firstname[0]}
    </span>
  );
}
