"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import useSWR from "swr";
import {
  formatDuration,
  formatPace,
  formatSecondsAsClock,
  getDiscipline,
  type Discipline,
  type RunThreshold,
  type StravaActivity,
  type TrainingLoadPoint,
  type TrainingPlan,
  type WeeklyVolume,
} from "@trihards/core";
import { fetcher } from "@/lib/fetcher";
import { NextUpTab } from "./NextUpTab";
import { GoalsCard } from "./GoalsCard";
import { FITNESS_KEY } from "./FitnessProfile";
import { readForm, TONE_VAR, gaugePercent } from "./OverviewHero";

// Opened from a feed card; carries three recharts charts, so it loads on click.
const ActivityDetailModal = dynamic(
  () => import("./ActivityDetailModal").then((m) => m.ActivityDetailModal),
  { ssr: false },
);

interface Props {
  activities: StravaActivity[];
  weeklyVolume: WeeklyVolume[];
  currentWeek: WeeklyVolume;
  trainingLoad: TrainingLoadPoint[];
  /** Athlete-local YYYY-MM-DD. */
  today: string;
  plan: TrainingPlan | null;
  runThreshold: RunThreshold | null;
  /** Saved coach analyses, keyed by activity id. */
  analyses: Record<number, string>;
  onUploadPlan: () => void;
  onShowActivities: () => void;
}

/** How far back the feed reaches. Older sessions live on the Activities page. */
const FEED_DAYS = 10;
const FEED_MAX = 8;

const DISCIPLINE: Record<Discipline, { label: string; color: string }> = {
  swim: { label: "Swim", color: "var(--swim)" },
  ride: { label: "Ride", color: "var(--ride)" },
  run: { label: "Run", color: "var(--run)" },
  strength: { label: "Strength", color: "var(--strength)" },
  other: { label: "Other", color: "var(--text-muted)" },
};

const DAY_FMT = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short" });
const WEEKDAY_FMT = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric" });

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

function isoWeek(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

function dayLabel(day: string, today: string): string {
  const d = new Date(`${day}T12:00:00`);
  if (day === today) return `Done today · ${WEEKDAY_FMT.format(d)}`;
  if (day === shiftDate(today, -1)) return `Yesterday · ${WEEKDAY_FMT.format(d)}`;
  return DAY_FMT.format(d);
}

/**
 * The analysis opens with a "**Verdict** — …" paragraph; that is the one line
 * worth reading on a card. Anything else falls back to the opening paragraph.
 */
function verdictOf(text: string): string {
  const match = text.match(/\*\*Verdict\*\*\s*[—–:-]?\s*([\s\S]*?)(?:\n\s*\n|\n\*\*|$)/);
  const raw = (match ? match[1] : text.split(/\n\s*\n/)[0]) ?? "";
  return raw.replace(/\*\*|__|`|^#+\s*/gm, "").replace(/\s+/g, " ").trim();
}

function distanceLabel(a: StravaActivity): string {
  if (getDiscipline(a) === "swim") return `${a.distance.toFixed(0)} m`;
  return `${(a.distance / 1000).toFixed(1)} km`;
}

export function FeedTab({
  activities,
  weeklyVolume,
  currentWeek,
  trainingLoad,
  today,
  plan,
  runThreshold,
  analyses,
  onUploadPlan,
  onShowActivities,
}: Props) {
  const [selected, setSelected] = useState<StravaActivity | null>(null);

  const from = shiftDate(today, -FEED_DAYS);
  const recent = activities
    .filter((a) => {
      const day = a.start_date_local.split("T")[0];
      return day >= from && day <= today;
    })
    .toSorted((a, b) => b.start_date_local.localeCompare(a.start_date_local))
    .slice(0, FEED_MAX);

  const byDay = new Map<string, StravaActivity[]>();
  for (const a of recent) {
    const day = a.start_date_local.split("T")[0];
    byDay.set(day, [...(byDay.get(day) ?? []), a]);
  }
  // Today's session is shown by the suggestion card; activities logged today
  // still appear, under their own day heading.
  const days = [...byDay.keys()];

  const planState = !plan ? "none" : plan.raceDate < today ? "finished" : "active";

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-4">
        <WeekStrip currentWeek={currentWeek} weeklyVolume={weeklyVolume} today={today} />

        <NextUpTab context={loadContext(trainingLoad)} />

        {days.map((day) => (
          <div key={day} className="space-y-4">
            <DayDivider>{dayLabel(day, today)}</DayDivider>
            {byDay.get(day)!.map((a) => (
              <ActivityCard
                key={a.id}
                activity={a}
                verdict={analyses[a.id] ? verdictOf(analyses[a.id]) : null}
                onOpen={() => setSelected(a)}
              />
            ))}
          </div>
        ))}

        {days.length === 0 && (
          <p className="px-1 text-sm text-gray-500">
            No sessions in the last {FEED_DAYS} days. Sync to pull in anything new from Strava.
          </p>
        )}

        <button
          type="button"
          onClick={onShowActivities}
          className="w-full cursor-pointer rounded-[10px] border border-gray-800 px-4 py-2.5 text-sm text-gray-400 transition-colors hover:border-gray-700 hover:text-white"
        >
          All activities →
        </button>

        {planState !== "active" && (
          <button
            type="button"
            onClick={onUploadPlan}
            className="w-full cursor-pointer rounded-[14px] border border-dashed border-orange-500/45 px-5 py-5 text-center font-semibold text-orange-500 transition-colors hover:bg-orange-500/5"
          >
            {planState === "finished"
              ? "Plan finished. Upload your next plan →"
              : "No training plan yet. Upload one →"}
          </button>
        )}
      </div>

      <aside className="space-y-4 xl:sticky xl:top-6 xl:self-start">
        <FormCard trainingLoad={trainingLoad} />
        <ThresholdsCard runThreshold={runThreshold} />
        <GoalsCard compact />
      </aside>

      {selected && (
        <ActivityDetailModal activity={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

/** "Form +12 · fatigue down 4 a day": where the athlete stands, in one line. */
function loadContext(load: TrainingLoadPoint[]): string | undefined {
  const latest = load[load.length - 1];
  if (!latest) return undefined;
  const earlier = load[load.length - 4];
  const form = `Form ${latest.tsb > 0 ? "+" : ""}${latest.tsb.toFixed(0)}`;
  if (!earlier) return form;
  const perDay = (latest.atl - earlier.atl) / 3;
  if (Math.abs(perDay) < 0.5) return `${form} · fatigue steady`;
  const rate = Math.abs(perDay).toFixed(0);
  return `${form} · fatigue ${perDay < 0 ? "down" : "up"} ${rate} a day`;
}

function DayDivider({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 pt-2 font-data text-[12px] uppercase tracking-[0.1em] text-gray-500">
      <span className="shrink-0">{children}</span>
      <span className="h-px flex-1 bg-gray-800" aria-hidden />
    </div>
  );
}

const TRIAD: Array<{
  discipline: "swim" | "ride" | "run";
  distance: (w: WeeklyVolume) => string;
  time: (w: WeeklyVolume) => number;
}> = [
  { discipline: "swim", distance: (w) => `${(w.swim / 1000).toFixed(1)} km`, time: (w) => w.swimTime },
  { discipline: "ride", distance: (w) => `${w.ride.toFixed(0)} km`, time: (w) => w.rideTime },
  { discipline: "run", distance: (w) => `${w.run.toFixed(1)} km`, time: (w) => w.runTime },
];

/**
 * This week, one segment per discipline. Each segment is as wide as that
 * discipline's share of a typical week and fills toward it: the athlete's own
 * four-week average, since the plan only prescribes a single discipline.
 */
function WeekStrip({
  currentWeek,
  weeklyVolume,
  today,
}: {
  currentWeek: WeeklyVolume;
  weeklyVolume: WeeklyVolume[];
  today: string;
}) {
  const prior = weeklyVolume.filter((w) => w.weekStart < currentWeek.weekStart).slice(-4);
  const avg = (fn: (w: WeeklyVolume) => number) =>
    prior.length ? prior.reduce((s, w) => s + fn(w), 0) / prior.length : 0;
  // Strength has no volume to fill a segment with, but it is training time.
  const total = TRIAD.reduce((s, d) => s + d.time(currentWeek), 0) + currentWeek.strengthTime;

  return (
    <section className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-4xl font-bold uppercase leading-none tracking-wide text-white">
          Week {isoWeek(today)}
        </h2>
        <span className="font-data text-[12px] text-gray-500">
          {formatDuration(total)} so far
        </span>
      </div>
      <div className="flex h-2.5 gap-[3px]" aria-hidden>
        {TRIAD.map((d) => {
          const typical = avg(d.time);
          const done = d.time(currentWeek);
          const fill = typical > 0 ? Math.min(1, done / typical) : done > 0 ? 1 : 0;
          return (
            <div
              key={d.discipline}
              className="relative overflow-hidden rounded-[3px] bg-gray-800"
              style={{ flex: Math.max(typical, 1) }}
            >
              <div
                className="absolute inset-y-0 left-0 rounded-[3px]"
                style={{ width: `${fill * 100}%`, background: DISCIPLINE[d.discipline].color }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-data text-[12px]">
        {TRIAD.map((d) => (
          <span key={d.discipline} className="inline-flex items-center gap-1.5" style={{ color: DISCIPLINE[d.discipline].color }}>
            <span className="h-2 w-2 rounded-full" style={{ background: DISCIPLINE[d.discipline].color }} />
            {d.distance(currentWeek)}
          </span>
        ))}
        {prior.length > 0 && (
          <span className="text-gray-600">bars fill toward your 4-week average</span>
        )}
      </div>
    </section>
  );
}

function ActivityCard({
  activity,
  verdict,
  onOpen,
}: {
  activity: StravaActivity;
  verdict: string | null;
  onOpen: () => void;
}) {
  const discipline = getDiscipline(activity);
  const cfg = DISCIPLINE[discipline];
  // Strava marks a run race with workout_type 1 and a ride race with 11.
  const race = activity.workout_type === 1 || activity.workout_type === 11;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`block w-full cursor-pointer rounded-[14px] border p-5 text-left transition-colors ${
        race
          ? "border-orange-500/35 bg-gradient-to-br from-orange-500/10 to-gray-900 to-70% hover:border-orange-500/60"
          : "border-gray-800 bg-gray-900 hover:border-gray-700"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Tag color={cfg.color}>{cfg.label}</Tag>
        {race && <Tag color="var(--accent)">Race</Tag>}
      </div>
      <h3 className="mt-2.5 font-display text-xl font-semibold uppercase leading-tight tracking-wide text-white">
        {activity.name}
      </h3>
      <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 font-data text-[13px] text-gray-400">
        {activity.distance > 0 && <span>{distanceLabel(activity)}</span>}
        <span>{formatDuration(activity.moving_time / 60)}</span>
        {activity.distance > 0 && <span>{formatPace(activity)}</span>}
        {activity.average_heartrate != null && <span>{activity.average_heartrate.toFixed(0)} bpm</span>}
      </div>
      {verdict && (
        <p className="mt-4 flex gap-2.5 border-t border-gray-800 pt-4 text-sm text-gray-400">
          <span className="shrink-0 font-semibold text-orange-500">Coach read</span>
          <span className="line-clamp-2">{verdict}</span>
        </p>
      )}
    </button>
  );
}

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold"
      style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}
    >
      {children}
    </span>
  );
}

function RailCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[14px] border border-gray-800 bg-gray-900 p-5">
      <h2 className="font-data text-[11px] uppercase tracking-[0.12em] text-gray-500">{label}</h2>
      {children}
    </section>
  );
}

function FormCard({ trainingLoad }: { trainingLoad: TrainingLoadPoint[] }) {
  const latest = trainingLoad[trainingLoad.length - 1];
  const prior = trainingLoad[trainingLoad.length - 8] ?? trainingLoad[0];
  if (!latest) {
    return (
      <RailCard label="Form">
        <p className="mt-2 text-sm text-gray-500">Sync activities to read your form.</p>
      </RailCard>
    );
  }
  const form = readForm(latest.tsb);
  const tone = TONE_VAR[form.tone];
  const ctlDelta = prior ? latest.ctl - prior.ctl : 0;
  const arrow = ctlDelta > 1 ? "↑" : ctlDelta < -1 ? "↓" : "→";

  return (
    <RailCard label="Form">
      <p className="mt-1.5 font-display text-4xl font-bold uppercase leading-none" style={{ color: tone }}>
        {form.word}
      </p>
      <p className="mt-1 text-[13px] text-gray-500">{form.note}</p>
      <div
        className="relative mt-4 h-2 rounded-[3px]"
        style={{ background: "linear-gradient(90deg, var(--err), var(--warn) 35%, var(--inset) 50%, var(--ok))" }}
      >
        <span
          className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px]"
          style={{ left: `${gaugePercent(latest.tsb)}%`, background: "var(--text-primary)", borderColor: tone }}
        />
      </div>
      <dl className="mt-3 font-data text-[13px]">
        <RailRow label="Form" value={`${latest.tsb > 0 ? "+" : ""}${latest.tsb.toFixed(0)}`} />
        <RailRow label="Fitness" value={`${latest.ctl.toFixed(0)} ${arrow}`} />
        <RailRow label="Fatigue" value={latest.atl.toFixed(0)} />
      </dl>
    </RailCard>
  );
}

function RailRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex justify-between border-t border-gray-800 py-2 first:border-t-0" title={title}>
      <dt className="text-gray-400">{label}</dt>
      <dd className="text-white">{value}</dd>
    </div>
  );
}

const THRESHOLD_SOURCE: Record<RunThreshold["source"], string> = {
  race: "from a race",
  "time-trial": "from a time trial",
  "steady-effort": "from a threshold-HR run",
};

export function ThresholdsCard({
  runThreshold,
  showWeight = false,
}: {
  runThreshold: RunThreshold | null;
  showWeight?: boolean;
}) {
  // Shares the Fitness page's cache entry, so this is no extra request once
  // either has loaded.
  const { data } = useSWR<{ athlete: { ftp?: number | null; weight?: number | null } | null }>(
    FITNESS_KEY,
    fetcher,
    { revalidateOnFocus: false },
  );
  const ftp = data?.athlete?.ftp ?? null;
  const weight = data?.athlete?.weight ?? null;

  return (
    <RailCard label="Thresholds">
      <dl className="mt-2 font-data text-[13px]">
        <RailRow
          label="Run"
          value={runThreshold ? `${formatSecondsAsClock(runThreshold.secPerKm)}/km` : "—"}
          title={
            runThreshold
              ? `${THRESHOLD_SOURCE[runThreshold.source]}: ${runThreshold.activityName}, ${runThreshold.date}`
              : "No race, time trial or threshold-HR run in the last 12 weeks"
          }
        />
        <RailRow label="Ride FTP" value={ftp ? `${ftp} W` : "—"} />
        {ftp && weight ? <RailRow label="W/kg" value={(ftp / weight).toFixed(2)} /> : null}
        {showWeight && weight ? <RailRow label="Weight" value={`${weight} kg`} /> : null}
      </dl>
      {runThreshold && (
        <p className="mt-1 text-[11px] text-gray-600">Run pace {THRESHOLD_SOURCE[runThreshold.source]}</p>
      )}
    </RailCard>
  );
}
