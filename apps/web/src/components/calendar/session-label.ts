import { formatDuration, type PlannedSession } from "@trihards/core";

/**
 * What a calendar chip calls a plan session: its distance when it has one, its
 * duration when it prescribes only time, and just its name otherwise (a
 * strength session). A plain module rather than a component file so React
 * Fast Refresh keeps working on the components that import it.
 */
export function sessionLabel(s: Pick<PlannedSession, "km" | "durationMin" | "name">): string {
  if (s.km > 0) return `${s.km}km ${s.name}`;
  if (s.durationMin) return `${formatDuration(s.durationMin)} ${s.name}`;
  return s.name;
}
