"use client";

export interface SummaryStat {
  label: string;
  value: string;
}

/** The metric grid at the top of the activity modal. */
export function SummaryStats({ stats }: { stats: SummaryStat[] }) {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
      {stats.map((s) => (
        <div key={s.label} className="bg-gray-950/60 border border-gray-800 rounded-lg p-3">
          <p className="text-gray-500 text-xs">{s.label}</p>
          <p className="text-white text-sm font-semibold mt-0.5">{s.value}</p>
        </div>
      ))}
    </div>
  );
}
