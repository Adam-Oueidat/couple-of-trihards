"use client";

import {
  type Discipline,
  type WeeklyVolume,
  type TrainingLoadPoint,
  formatDuration,
} from "@trihards/core";
import { DisciplineGlyph } from "./DisciplineGlyph";

interface Props {
  currentWeek?: WeeklyVolume;
  /** Recent training-load series; the last point is "today". */
  trainingLoad: TrainingLoadPoint[];
}

// Form (TSB) is the headline an endurance athlete reads first: are my legs
// fresh or buried? We translate the raw balance into one plain word plus a
// tone, so the verdict carries meaning rather than decoration.
type Tone = "ok" | "accent" | "warn" | "err";

function readForm(tsb: number): { word: string; note: string; tone: Tone } {
  if (tsb >= 15)
    return { word: "Tapered", note: "race-ready legs", tone: "ok" };
  if (tsb >= 5) return { word: "Fresh", note: "rested and ready", tone: "ok" };
  if (tsb >= -10)
    return { word: "Balanced", note: "holding steady", tone: "accent" };
  if (tsb >= -25)
    return { word: "Building", note: "productive fatigue", tone: "warn" };
  return { word: "Overreached", note: "ease off soon", tone: "err" };
}

const TONE_VAR: Record<Tone, string> = {
  ok: "var(--ok)",
  accent: "var(--accent)",
  warn: "var(--warn)",
  err: "var(--err)",
};

// Gauge spans fatigued (−30) ↔ fresh (+30); clamp so outliers still sit
// inside the track.
const GAUGE_MIN = -30;
const GAUGE_MAX = 30;
function gaugePercent(tsb: number): number {
  const clamped = Math.min(GAUGE_MAX, Math.max(GAUGE_MIN, tsb));
  return ((clamped - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)) * 100;
}

const TRIAD: Array<{
  discipline: Discipline;
  label: string;
  color: string;
  value: (w: WeeklyVolume) => string;
  time: (w: WeeklyVolume) => number;
}> = [
  {
    discipline: "swim",
    label: "Swim",
    color: "var(--swim)",
    value: (w) => `${(w.swim / 1000).toFixed(1)}`,
    time: (w) => w.swimTime,
  },
  {
    discipline: "ride",
    label: "Ride",
    color: "var(--ride)",
    value: (w) => `${w.ride.toFixed(0)}`,
    time: (w) => w.rideTime,
  },
  {
    discipline: "run",
    label: "Run",
    color: "var(--run)",
    value: (w) => `${w.run.toFixed(1)}`,
    time: (w) => w.runTime,
  },
];

function weekLabel(weekStart?: string): string {
  if (!weekStart) return "";
  // Parse as a local date (append time) — `new Date("YYYY-MM-DD")` is UTC
  // midnight, which renders as the previous day in negative-offset timezones.
  return new Date(`${weekStart}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function OverviewHero({ currentWeek, trainingLoad }: Props) {
  const latest = trainingLoad[trainingLoad.length - 1];
  // Compare against roughly a week ago to read the fitness trajectory.
  const prior = trainingLoad[trainingLoad.length - 8] ?? trainingLoad[0];

  const tsb = latest?.tsb ?? 0;
  const form = readForm(tsb);
  const toneColor = TONE_VAR[form.tone];
  const markerLeft = gaugePercent(tsb);

  const ctlDelta = latest && prior ? latest.ctl - prior.ctl : 0;
  const trend = ctlDelta > 1 ? "rising" : ctlDelta < -1 ? "fading" : "steady";
  const trendArrow = ctlDelta > 1 ? "↑" : ctlDelta < -1 ? "↓" : "→";

  const totalTime = currentWeek
    ? currentWeek.swimTime + currentWeek.rideTime + currentWeek.runTime
    : 0;

  return (
    <section className="hero-rise relative overflow-hidden rounded-2xl border border-gray-800 bg-gray-900">
      {/* Signature accent rule across the top edge */}
      <span
        className="absolute inset-x-0 top-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, var(--accent), transparent)",
        }}
        aria-hidden
      />

      <div className="grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* ---- Left: current form ---- */}
        <div className="p-6 sm:p-7">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-display uppercase tracking-[0.22em] text-[12px] text-gray-500">
              Current form
            </span>
            {currentWeek && (
              <span className="font-data text-[11px] text-gray-500">
                Week of {weekLabel(currentWeek.weekStart)}
              </span>
            )}
          </div>

          <div className="mt-3 flex items-end gap-4">
            <h2
              className="font-display font-semibold leading-[0.85] text-5xl sm:text-6xl tracking-tight"
              style={{ color: latest ? toneColor : "var(--text-faint)" }}
            >
              {latest ? form.word : "No data"}
            </h2>
          </div>
          <p className="mt-2 text-sm text-gray-500">
            {latest ? form.note : "Sync activities to read your form."}
          </p>

          {/* Form gauge: fatigued ↔ fresh */}
          <div className="mt-6">
            <div className="relative h-9">
              <div
                className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full"
                style={{ background: "var(--inset)" }}
              />
              {/* neutral centre tick */}
              <div
                className="absolute top-1/2 left-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2"
                style={{ background: "var(--text-faint)" }}
                aria-hidden
              />
              {latest && (
                <div
                  className="gauge-marker absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                  style={{ left: `${markerLeft}%` }}
                >
                  <div
                    className="h-5 w-5 rounded-full border-2"
                    style={{
                      background: toneColor,
                      borderColor: "var(--card)",
                      boxShadow: `0 0 0 3px ${toneColor}33`,
                    }}
                  />
                </div>
              )}
            </div>
            <div className="mt-1 flex justify-between font-data text-[10px] uppercase tracking-wider text-gray-600">
              <span>Fatigued</span>
              <span>Fresh</span>
            </div>
          </div>

          {/* Form value + fitness trend */}
          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-gray-800 pt-4">
            <Readout label="Form · TSB">
              <span style={{ color: latest ? toneColor : "var(--text-faint)" }}>
                {latest ? `${tsb > 0 ? "+" : ""}${tsb.toFixed(0)}` : "—"}
              </span>
            </Readout>
            <Readout label="Fitness · CTL">
              <span className="text-gray-200">
                {latest ? latest.ctl.toFixed(0) : "—"}
              </span>
              {latest && (
                <span className="ml-2 text-xs font-normal text-gray-500">
                  {trendArrow} {trend}
                </span>
              )}
            </Readout>
            <Readout label="Fatigue · ATL">
              <span className="text-gray-200">
                {latest ? latest.atl.toFixed(0) : "—"}
              </span>
            </Readout>
          </div>
        </div>

        {/* ---- Right: this week's three disciplines ---- */}
        <div className="flex flex-col border-t border-gray-800 p-6 sm:p-7 lg:border-l lg:border-t-0">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-display uppercase tracking-[0.22em] text-[12px] text-gray-500">
              This week
            </span>
            <span className="font-data text-[11px] text-gray-500">
              {currentWeek ? formatDuration(totalTime) : "—"} total
            </span>
          </div>

          <div className="mt-4 grid grid-cols-3 divide-x divide-gray-800">
            {TRIAD.map((d, i) => (
              <div
                key={d.label}
                className={i === 0 ? "pr-4" : "px-4 last:pr-0"}
              >
                <div
                  className="flex items-center gap-1.5 text-[12px] font-medium"
                  style={{ color: d.color }}
                >
                  <DisciplineGlyph discipline={d.discipline} size={14} />
                  <span className="font-display uppercase tracking-wider">
                    {d.label}
                  </span>
                </div>
                <div className="mt-3 flex items-baseline gap-1">
                  <span
                    className="font-display font-semibold text-4xl leading-none tabular-nums"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {currentWeek ? d.value(currentWeek) : "—"}
                  </span>
                  <span className="font-data text-xs text-gray-500">km</span>
                </div>
                <div className="mt-1.5 font-data text-[11px] text-gray-500">
                  {currentWeek ? formatDuration(d.time(currentWeek)) : ""}
                </div>
              </div>
            ))}
          </div>

          {/* Discipline balance — how this week's hours split across the
              three sports. A triathlete reads this to spot a neglected leg. */}
          <div className="mt-auto pt-7">
            <span className="font-data text-[10px] uppercase tracking-wider text-gray-600">
              Time split
            </span>
            <div
              className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full"
              style={{ background: "var(--inset)" }}
            >
              {totalTime > 0 &&
                TRIAD.map((d) => {
                  const pct = (d.time(currentWeek!) / totalTime) * 100;
                  return (
                    <div
                      key={d.label}
                      style={{ width: `${pct}%`, background: d.color }}
                    />
                  );
                })}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-data text-[11px] text-gray-500">
              {TRIAD.map((d) => (
                <span key={d.label}>
                  <span style={{ color: d.color }}>{d.label}</span>{" "}
                  {totalTime > 0
                    ? `${Math.round((d.time(currentWeek!) / totalTime) * 100)}%`
                    : "—"}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Readout({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="font-data text-[10px] uppercase tracking-wider text-gray-600">
        {label}
      </div>
      <div className="mt-0.5 font-display text-2xl font-semibold leading-none tabular-nums">
        {children}
      </div>
    </div>
  );
}
