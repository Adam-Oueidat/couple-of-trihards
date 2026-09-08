"use client";

/**
 * The one and only lazily-loaded entry point for anything that draws with
 * recharts.
 *
 * Every chart used to sit behind its own `dynamic(() => import("./ThatChart"))`
 * call. Turbopack does not hoist a dependency shared by several async chunks
 * into a common one, so each of those boundaries got a private copy of
 * recharts + d3 + immer: three chunks of exactly 368,444 bytes whose first
 * 266KB were byte-identical. Two of them downloaded on the Overview tab alone,
 * because both charts on it are visible immediately — the split bought no
 * deferral, only a duplicate library and an extra round trip.
 *
 * Routing every chart through this single module means every `import("./charts")`
 * in the app names the same specifier and therefore resolves to the same chunk,
 * so recharts is downloaded, parsed and evaluated exactly once. Whichever chart
 * the athlete reaches first pays for it; the rest are free.
 *
 * The cost of the barrel is that reaching one chart pulls the code for all of
 * them. That is a few tens of KB against the ~730KB of duplicated library the
 * split was costing, so it is a trade worth making — but it does mean anything
 * added here should genuinely be a chart. Non-recharts components (LapChart
 * draws its own SVG) must stay out, or they inherit the whole library.
 */

export { WeeklyVolumeChart } from "./WeeklyVolumeChart";
export { TrainingLoadChart } from "./TrainingLoadChart";
export { PlannedVsActual } from "./PlannedVsActual";
export { StreamCharts } from "./activity-detail/StreamCharts";
