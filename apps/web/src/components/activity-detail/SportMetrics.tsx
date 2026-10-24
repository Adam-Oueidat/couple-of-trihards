"use client";

import { formatDuration, type ActivityMetrics, type RideMetrics } from "@trihards/core";
import { SummaryStats, type SummaryStat } from "./SummaryStats";
import { formatPaceValue } from "./format";

function rideStats(m: RideMetrics): SummaryStat[] {
  const est = m.powerSource === "estimated" ? " (est.)" : "";
  return [
    ...(m.avgPower != null
      ? [
          {
            label: m.normalizedPower != null ? "Avg / NP" : "Avg power",
            value:
              m.normalizedPower != null
                ? `${m.avgPower} / ${m.normalizedPower} W${est}`
                : `${m.avgPower} W${est}`,
          },
        ]
      : []),
    ...(m.maxPower ? [{ label: "Max power", value: `${m.maxPower} W` }] : []),
    ...(m.intensityFactor != null
      ? [{ label: "IF / TSS", value: `${m.intensityFactor.toFixed(2)} / ${m.tss ?? "-"}` }]
      : []),
    ...(m.wattsPerKg != null ? [{ label: "W/kg", value: m.wattsPerKg.toFixed(2) }] : []),
    ...(m.workKj != null ? [{ label: "Work", value: `${m.workKj} kJ` }] : []),
    ...(m.variabilityIndex != null
      ? [{ label: "Variability", value: m.variabilityIndex.toFixed(2) }]
      : []),
    ...(m.avgCadence != null ? [{ label: "Cadence", value: `${m.avgCadence} rpm` }] : []),
    ...(m.coastingPct != null ? [{ label: "Coasting", value: `${m.coastingPct}%` }] : []),
    ...(m.decouplingPct != null ? [{ label: "Pw:HR drift", value: `${m.decouplingPct}%` }] : []),
  ];
}

function runStats(m: Extract<ActivityMetrics, { kind: "run" }>): SummaryStat[] {
  return [
    ...(m.avgCadence != null ? [{ label: "Cadence", value: `${m.avgCadence} spm` }] : []),
    ...(m.gradeAdjustedSpeed
      ? [{ label: "Grade-adj. pace", value: `${formatPaceValue(1000 / m.gradeAdjustedSpeed / 60)}/km` }]
      : []),
    // Below ~5 m/km a run is flat enough that climbing says nothing.
    ...(m.climbPerKm != null && m.climbPerKm >= 5
      ? [{ label: "Climbing", value: `${m.climbPerKm} m/km` }]
      : []),
    ...(m.avgPower != null ? [{ label: "Run power", value: `${m.avgPower} W` }] : []),
    ...(m.decouplingPct != null ? [{ label: "Pa:HR drift", value: `${m.decouplingPct}%` }] : []),
  ];
}

/** Coggan zone colours, easy to hard. */
const POWER_ZONE_COLORS = [
  "#6b7280",
  "#3b82f6",
  "#22c55e",
  "#eab308",
  "#f97316",
  "#ef4444",
  "#a855f7",
];

function PowerZones({ zones }: { zones: NonNullable<RideMetrics["powerZones"]> }) {
  const total = zones.reduce((a, z) => a + z.seconds, 0);
  if (total === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
        Time in power zones
      </h3>
      <div className="flex h-2.5 rounded-full overflow-hidden bg-gray-800">
        {zones.map((z) =>
          z.seconds > 0 ? (
            <div
              key={z.zone}
              style={{ width: `${(z.seconds / total) * 100}%`, background: POWER_ZONE_COLORS[z.zone - 1] }}
              title={`Z${z.zone} ${z.name}`}
            />
          ) : null,
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {zones
          .filter((z) => z.seconds > 0)
          .map((z) => (
            <span
              key={z.zone}
              className="px-2.5 py-1 rounded-full border border-gray-700 bg-gray-950/60 text-xs"
            >
              <span style={{ color: POWER_ZONE_COLORS[z.zone - 1] }}>
                Z{z.zone} {z.name}
              </span>{" "}
              <span className="text-white font-semibold">
                {formatDuration(Math.round(z.seconds / 60))}
              </span>
            </span>
          ))}
      </div>
    </div>
  );
}

/**
 * The numbers a ride or a run is actually judged by: power and pedalling for
 * the bike, cadence and grade-adjusted pace for the run.
 */
export function SportMetrics({ metrics }: { metrics: ActivityMetrics }) {
  const stats = metrics.kind === "ride" ? rideStats(metrics) : runStats(metrics);
  const peaks = metrics.kind === "ride" ? metrics.peakPower : [];
  const zones = metrics.kind === "ride" ? metrics.powerZones : null;
  if (stats.length === 0 && peaks.length === 0) return null;

  return (
    <div className="space-y-4">
      {stats.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            {metrics.kind === "ride" ? "Power & pedalling" : "Running form"}
          </h3>
          <SummaryStats stats={stats} />
        </div>
      )}
      {peaks.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Peak power
          </h3>
          <div className="flex flex-wrap gap-2">
            {peaks.map((p) => (
              <span
                key={p.label}
                className="px-3 py-1.5 rounded-full border border-gray-700 bg-gray-950/60 text-xs"
              >
                <span className="text-gray-400">{p.label}</span>{" "}
                <span className="text-white font-semibold">{p.watts} W</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {zones && <PowerZones zones={zones} />}
    </div>
  );
}
