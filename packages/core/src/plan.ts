import planData from "./data/runna-plan.json" with { type: "json" };
import { StravaActivity } from "./types/strava";
import { activityDay, getDiscipline, getWeekStart, localToday } from "./training";

export type SessionType =
  | "easy"
  | "intervals"
  | "tempo"
  | "long"
  | "time_trial"
  | "race";

export interface PlannedSession {
  id: string;
  date: string;
  originalDate: string;
  name: string;
  type: SessionType;
  km: number;
  movedFrom?: string;
  moveReason?: string;
}

export interface TrainingPlan {
  name: string;
  source: string;
  discipline: string;
  startDate: string;
  raceDate: string;
  raceName: string;
  sessions: PlannedSession[];
}

export interface PlanOverride {
  sessionId: string;
  originalDate: string;
  newDate: string;
  movedAt: string;
  reason?: string;
}

export type PlanOverrideMap = Record<string, PlanOverride>;

interface RawSession {
  date: string;
  name: string;
  type: SessionType;
  km: number;
}

function sessionSlug(date: string, name: string): string {
  return `${date}-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

const rawPlan = planData as Omit<TrainingPlan, "sessions"> & {
  sessions: RawSession[];
};

export const plan: TrainingPlan = {
  ...rawPlan,
  sessions: rawPlan.sessions.map((s) => ({
    id: sessionSlug(s.date, s.name),
    date: s.date,
    originalDate: s.date,
    name: s.name,
    type: s.type,
    km: s.km,
  })),
};

export function applyPlanOverrides(
  sessions: PlannedSession[],
  overrides?: PlanOverrideMap,
): PlannedSession[] {
  if (!overrides) return sessions;
  return sessions.map((s) => {
    const override = overrides[s.id];
    if (!override) return s;
    return {
      ...s,
      date: override.newDate,
      movedFrom: s.originalDate,
      moveReason: override.reason,
    };
  });
}

export type SessionStatus =
  | "completed"
  | "partial"
  | "missed"
  | "upcoming"
  | "today";

export interface SessionWithStatus extends PlannedSession {
  status: SessionStatus;
  actualKm?: number;
  matchedActivity?: string;
}

// `today` is an athlete-local ISO date (YYYY-MM-DD). It defaults to the local
// date, which is correct when these run client-side (PlannedVsActual); server
// callers (the coach) must pass the athlete's resolved local date so they don't
// fall back to the server's UTC clock and drift a day ahead.
export function matchSessions(
  activities: StravaActivity[],
  overrides?: PlanOverrideMap,
  today: string = localToday(),
): SessionWithStatus[] {
  const sessions = applyPlanOverrides(plan.sessions, overrides);

  const runsByDate = new Map<string, StravaActivity[]>();
  for (const act of activities) {
    if (getDiscipline(act) !== "run") continue;
    const day = act.start_date_local.split("T")[0];
    const list = runsByDate.get(day) ?? [];
    list.push(act);
    runsByDate.set(day, list);
  }

  return sessions.map((session) => {
    const runs = runsByDate.get(session.date) ?? [];
    const actualKm = runs.reduce((sum, r) => sum + r.distance / 1000, 0);

    if (runs.length > 0) {
      return {
        ...session,
        status:
          actualKm >= session.km * 0.8
            ? ("completed" as const)
            : ("partial" as const),
        actualKm: Math.round(actualKm * 10) / 10,
        matchedActivity: runs[0].name,
      };
    }
    if (session.date === today) return { ...session, status: "today" as const };
    if (session.date > today) return { ...session, status: "upcoming" as const };
    return { ...session, status: "missed" as const };
  });
}

export interface PlannedVsActualWeek {
  weekStart: string;
  plannedKm: number;
  actualKm: number;
  isCurrentWeek: boolean;
  isFuture: boolean;
}

export function plannedVsActualByWeek(
  activities: StravaActivity[],
  overrides?: PlanOverrideMap,
  today: string = localToday(),
): PlannedVsActualWeek[] {
  const sessions = applyPlanOverrides(plan.sessions, overrides);

  const plannedByWeek = new Map<string, number>();
  for (const s of sessions) {
    const week = getWeekStart(new Date(s.date + "T12:00:00"));
    plannedByWeek.set(week, (plannedByWeek.get(week) ?? 0) + s.km);
  }

  const actualByWeek = new Map<string, number>();
  for (const act of activities) {
    if (getDiscipline(act) !== "run") continue;
    const week = getWeekStart(activityDay(act.start_date_local));
    actualByWeek.set(week, (actualByWeek.get(week) ?? 0) + act.distance / 1000);
  }

  const currentWeek = getWeekStart(new Date(today + "T12:00:00"));

  return Array.from(plannedByWeek.keys())
    .sort()
    .map((weekStart) => ({
      weekStart,
      plannedKm: Math.round((plannedByWeek.get(weekStart) ?? 0) * 10) / 10,
      actualKm: Math.round((actualByWeek.get(weekStart) ?? 0) * 10) / 10,
      isCurrentWeek: weekStart === currentWeek,
      isFuture: weekStart > currentWeek,
    }));
}

export function getCurrentWeekSessions(
  activities: StravaActivity[],
  overrides?: PlanOverrideMap,
  today: string = localToday(),
): SessionWithStatus[] {
  const currentWeek = getWeekStart(new Date(today + "T12:00:00"));
  return matchSessions(activities, overrides, today).filter(
    (s) => getWeekStart(new Date(s.date + "T12:00:00")) === currentWeek,
  );
}

export function daysUntilRace(today: string = localToday()): number {
  const race = new Date(plan.raceDate + "T12:00:00");
  const now = new Date(today + "T12:00:00");
  return Math.max(0, Math.ceil((race.getTime() - now.getTime()) / 86400000));
}
