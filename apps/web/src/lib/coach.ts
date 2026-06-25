import Anthropic from "@anthropic-ai/sdk";
import {
  AthleteDetail,
  AthleteStats,
  AthleteZones,
  DetailedActivity,
  StravaActivity,
  createLogger,
  getDiscipline,
  groupByWeek,
  calcTrainingLoad,
  formatPace,
  plan,
  matchSessions,
  daysUntilRace,
} from "@trihards/core";
import { getWorkouts } from "./workouts";
import { getOverrides } from "./plan-overrides";
import { getGoals } from "./goals";
import { getRecentAnalyses } from "./analyses";
import { getAthleteDetail, getAthleteStats, getAthleteZones } from "./strava";
import { getPersonalBests, type PersonalBest } from "./personal-bests";
import { resolveToday } from "./coach-dates";

export { localDateOf, resolveToday } from "./coach-dates";

const log = createLogger("coach");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const COACH_SYSTEM_PROMPT = `You are a triathlon coach embedded in a training dashboard app called "TriLog". You advise the athlete based on their real Strava training data, which is provided below.

Guidelines:
- Be concise and practical. Athletes want actionable advice, not essays.
- Ground every recommendation in their actual data (volume, training load, recency).
- Align all advice with the athlete's stated goals (listed in their data). When goals and plan conflict, point it out.
- When HR zones are listed below, interpret heart rate in terms of those zones (Z1 endurance, Z2 aerobic, Z3 tempo, Z4 threshold, Z5 VO2max) rather than raw bpm — the athlete cares about effort, not numbers.
- When personal bests are listed, contextualize race-paced sessions and time trials against them. Flag genuine PB-level efforts in analyses.
- When FTP and weight are available, use W/kg for ride intensity calls.
- Pay attention to CTL (fitness), ATL (fatigue), and TSB (form). Negative TSB means accumulated fatigue; very negative (< -20) suggests overreaching. Positive TSB means freshness.
- Watch for imbalances between swim/bike/run relative to typical triathlon preparation.
- The athlete is following a structured Runna running plan (provided below) toward a goal race. Help them integrate it with their swim and bike training without overloading.
- When discussing the plan, consider adherence so far (completed/missed sessions) and how swim/bike load interacts with key run sessions.
- Flag injury-risk patterns: sudden volume spikes (>30% week over week), no rest days, high fatigue.
- If asked about topics requiring medical expertise, recommend seeing a professional.
- Use metric units.
- Never use emojis. Write in plain text only — no emoji, emoticons, or decorative symbols anywhere in your replies, including headings, lists, and summaries.
- The athlete's current local date is given as "Today is ..." at the top of their data. Treat that as the present moment for everything time-related: recency, "this week", days until the race, and whether a plan session is upcoming or already done. Compute relative dates (e.g. "in 3 days", "last Tuesday") from it, and never state a date that contradicts it.
- A short recap of earlier chats may appear under "Earlier coaching context". Use it only as background memory for continuity — it describes the past, not the present. Never read a date or current state from it; the live data sections and the "Today is ..." line are authoritative.
- When the athlete refers to "my session", "my workout", "today's effort" or similar without naming one, assume they mean the most recent / newly-synced activity (see "New since we last spoke" when present), and confirm which one if it's ambiguous.

Plan moves:
- The athlete may reschedule planned sessions in their calendar (drag-and-drop). Moved sessions show up under "Plan moves" with original → new dates. Sessions in upcoming/recent plan sessions are listed at their CURRENT dates (after the move), not their original Runna-plan dates.
- When the athlete tells you they had to move a session, acknowledge the change and adapt advice (e.g. a long run pushed by a day means the easy day around it should shift too). If they're stacking hard sessions back-to-back due to a move, flag the risk.

Adding workouts:
- You have an add_workout tool to put swim/ride/run sessions on the athlete's calendar.
- When the athlete proposes a workout (e.g. "I want to swim Thursday"), first assess compatibility: proximity to key run sessions (long runs, intervals, race), current fatigue (TSB), weekly ramp rate, and whether the day is a planned rest day. Rest-day easy swims are usually fine; hard bike sessions the day before a long run are usually not.
- Give your verdict briefly. If it's reasonable and the athlete clearly wants it added (or asks you to add it), call add_workout. If they were just exploring, offer to add it.
- If the workout is a bad idea, say so and propose a better day or a modified version.
- Default added sessions to easy/aerobic intensity unless the athlete asks otherwise.`;

function formatTotals(t: { count: number; distance: number; moving_time: number }): string {
  return `${t.count} sessions, ${(t.distance / 1000).toFixed(0)}km, ${Math.round(t.moving_time / 3600)}h`;
}

function formatHRZones(zones: AthleteZones["heart_rate"]): string {
  if (!zones?.zones?.length) return "Not configured on Strava";
  return zones.zones
    .map((z, i) => {
      const label = ["Z1 endurance", "Z2 aerobic", "Z3 tempo", "Z4 threshold", "Z5 VO2max"][i] ?? `Z${i + 1}`;
      const max = z.max === -1 ? "max" : `${z.max} bpm`;
      return `  ${label}: ${z.min}–${max}`;
    })
    .join("\n");
}

function formatPBs(pbs: PersonalBest[]): string {
  if (pbs.length === 0) {
    return "No PBs tracked yet (PBs are recorded automatically when you view or analyze an activity that contains best efforts).";
  }
  return pbs
    .map((p) => {
      const min = Math.floor(p.moving_time / 60);
      const sec = (p.moving_time % 60).toString().padStart(2, "0");
      return `  ${p.name}: ${min}:${sec} — "${p.activityName}" on ${p.activityDate}`;
    })
    .join("\n");
}

function formatFitnessProfile(
  athlete: AthleteDetail | null,
  zones: AthleteZones | null,
  stats: AthleteStats | null,
): string {
  const lines: string[] = [];
  if (athlete) {
    const parts: string[] = [];
    if (athlete.weight) parts.push(`Weight: ${athlete.weight}kg`);
    if (athlete.ftp) parts.push(`FTP: ${athlete.ftp}W`);
    if (athlete.weight && athlete.ftp)
      parts.push(`W/kg: ${(athlete.ftp / athlete.weight).toFixed(2)}`);
    if (parts.length > 0) lines.push(parts.join(" | "));
  }
  if (zones?.heart_rate) {
    lines.push("HR Zones:\n" + formatHRZones(zones.heart_rate));
  }
  if (stats) {
    lines.push(
      `Last 4 weeks: swim ${formatTotals(stats.recent_swim_totals)} | ride ${formatTotals(stats.recent_ride_totals)} | run ${formatTotals(stats.recent_run_totals)}`,
    );
    lines.push(
      `Year-to-date: swim ${formatTotals(stats.ytd_swim_totals)} | ride ${formatTotals(stats.ytd_ride_totals)} | run ${formatTotals(stats.ytd_run_totals)}`,
    );
    lines.push(
      `Biggest ride distance: ${(stats.biggest_ride_distance / 1000).toFixed(0)}km | Biggest climb: ${Math.round(stats.biggest_climb_elevation_gain)}m`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : "No fitness profile data available.";
}

// Condense a finished conversation into a few sentences for the coach's own
// future reference. Cheap model, best-effort — callers must tolerate null.
export async function summarizeConversation(
  messages: { role: string; content: string }[],
): Promise<string | null> {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "Athlete" : "Coach"}: ${m.content}`)
    .join("\n")
    .trim();
  if (!transcript) return null;
  const res = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 400,
    system:
      "You summarize a triathlon coaching conversation for the coach's own future reference. Write 3-5 sentences in plain past tense. Capture: the topics discussed, the advice or decisions given, any injuries, concerns, or goals the athlete raised, and any workouts added. Do not include specific calendar dates unless they refer to a fixed event like a race. No preamble, no headings, plain text only.",
    messages: [{ role: "user", content: transcript }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return text || null;
}

export interface TrainingContextOpts {
  // Rolling summary of prior conversations, injected as background memory.
  priorSummary?: string | null;
  // Unix seconds: activities started after this are flagged "new since we last
  // spoke" so the coach can reference them without the athlete pointing them out.
  sinceTs?: number | null;
}

export async function buildTrainingContext(
  userId: string,
  activities: StravaActivity[],
  clientToday?: string,
  opts: TrainingContextOpts = {},
): Promise<string> {
  const today = resolveToday(clientToday, activities);
  const weekly = groupByWeek(activities);
  // Use the athlete-local today so Form (TSB) decays to now, not to the last
  // logged activity.
  const load = calcTrainingLoad(activities, today);
  const latest = load[load.length - 1];

  const weeklyLines = weekly
    .slice(-8)
    .map(
      (w) =>
        `- Week of ${w.weekStart}: swim ${(w.swim / 1000).toFixed(1)}km/${Math.round(w.swimTime)}min, ` +
        `ride ${w.ride.toFixed(1)}km/${Math.round(w.rideTime)}min, ` +
        `run ${w.run.toFixed(1)}km/${Math.round(w.runTime)}min`,
    )
    .join("\n");

  const activityLine = (a: StravaActivity) => {
    const d = getDiscipline(a);
    const dist =
      d === "swim"
        ? `${a.distance.toFixed(0)}m`
        : `${(a.distance / 1000).toFixed(1)}km`;
    const hr = a.average_heartrate
      ? `, avg HR ${a.average_heartrate.toFixed(0)}`
      : "";
    return `- ${a.start_date_local.split("T")[0]} ${d}: "${a.name}" ${dist} in ${Math.round(a.moving_time / 60)}min (${formatPace(a)})${hr}`;
  };

  const recentLines = activities.slice(0, 20).map(activityLine).join("\n");

  // Activities logged since the athlete last spoke to the coach, so it can
  // discuss "my session" without being told which one.
  const sinceTs = opts.sinceTs ?? null;
  const newActivities = sinceTs
    ? activities.filter((a) => {
        const t = new Date(a.start_date).getTime();
        return !Number.isNaN(t) && t > sinceTs * 1000;
      })
    : [];
  const newSinceSection =
    newActivities.length > 0
      ? `\n## New since we last spoke
These activities were logged since your last conversation with the athlete. If they ask about "my session" or "my workout" without specifics, assume they mean the most recent of these.
${newActivities.slice(0, 10).map(activityLine).join("\n")}\n`
      : "";

  const memorySection = opts.priorSummary
    ? `\n## Earlier coaching context (memory of prior conversations — background only, not "now")
${opts.priorSummary}\n`
    : "";

  const [overrides, goals, pbs, workouts, recentAnalyses] = await Promise.all([
    getOverrides(userId),
    getGoals(userId),
    getPersonalBests(userId),
    getWorkouts(userId),
    getRecentAnalyses(userId, 3),
  ]);

  const sessions = matchSessions(activities, overrides, today);

  const pastSessions = sessions.filter((s) => s.date <= today).slice(-10);
  const upcomingSessions = sessions
    .filter((s) => s.date > today)
    .slice(0, 7);

  const sessionLine = (s: (typeof sessions)[number]) => {
    const actual =
      s.actualKm !== undefined ? ` (actual: ${s.actualKm}km)` : "";
    return `- ${s.date} [${s.status}] ${s.name} (${s.type}, ${s.km}km)${actual}`;
  };

  const [athleteResult, zonesResult, statsResult] = await Promise.allSettled([
    getAthleteDetail(),
    getAthleteZones(),
    getAthleteStats(),
  ]);
  if (athleteResult.status === "rejected")
    log.warn("athlete detail unavailable", { reason: String(athleteResult.reason) });
  if (zonesResult.status === "rejected")
    log.warn("HR zones unavailable", { reason: String(zonesResult.reason) });
  if (statsResult.status === "rejected")
    log.warn("athlete stats unavailable", { reason: String(statsResult.reason) });
  const athlete = athleteResult.status === "fulfilled" ? athleteResult.value : null;
  const zones = zonesResult.status === "fulfilled" ? zonesResult.value : null;
  const stats = statsResult.status === "fulfilled" ? statsResult.value : null;

  return `# Today is ${today} (the athlete's current local date — treat this as "now")
${memorySection}
# Athlete training data (from Strava, last 12 months)

## Fitness profile
${formatFitnessProfile(athlete, zones, stats)}

## Personal bests (running, from analyzed activities)
${formatPBs(pbs)}

## Athlete goals
${goals.map((g) => `- ${g.text}`).join("\n") || "No explicit goals set (assume: complete the goal race well)"}

## Current training load
${
  latest
    ? `CTL (fitness): ${latest.ctl} | ATL (fatigue): ${latest.atl} | TSB (form): ${latest.tsb}`
    : "No data available"
}

## Weekly volume (last 8 weeks)
${weeklyLines || "No activities"}

## Recent activities (latest 20)
${recentLines || "No activities"}
${newSinceSection}
# Running plan: ${plan.name} (${plan.source})
Goal race: ${plan.raceName} on ${plan.raceDate} (${daysUntilRace(today)} days away)
Plan span: ${plan.startDate} to ${plan.raceDate}

## Recent plan sessions (with adherence)
${pastSessions.map(sessionLine).join("\n") || "None yet"}

## Upcoming plan sessions (next 7)
${upcomingSessions.map(sessionLine).join("\n") || "None"}

## Plan moves (sessions the athlete rescheduled from their original plan dates)
${
  Object.values(overrides)
    .sort((a, b) => a.newDate.localeCompare(b.newDate))
    .map((o) => {
      const session = plan.sessions.find((s) => s.id === o.sessionId);
      const label = session ? session.name : o.sessionId;
      return `- "${label}": ${o.originalDate} → ${o.newDate}${o.reason ? ` (reason: ${o.reason})` : ""}`;
    })
    .join("\n") || "None — athlete is following original plan dates"
}

## Custom workouts on the calendar (added by athlete or you)
${
  workouts
    .flatMap((w) =>
      w.date >= today
        ? [
            `- ${w.date} ${w.discipline}: ${w.name}` +
              (w.distanceKm ? ` ${w.distanceKm}km` : "") +
              (w.durationMin ? ` ${w.durationMin}min` : "") +
              ` (added by ${w.addedBy})`,
          ]
        : [],
    )
    .join("\n") || "None"
}

## Your recent activity analyses (your own prior coaching feedback — stay consistent with it)
${
  recentAnalyses
    .map((a) => {
      const act = activities.find((x) => x.id === a.activityId);
      const label = act
        ? `"${act.name}" (${act.start_date_local.split("T")[0]})`
        : `activity ${a.activityId}`;
      return `### Analysis of ${label}\n${a.text}`;
    })
    .join("\n\n") || "None yet"
}`;
}

function formatPaceFromSpeed(metersPerSecond: number): string {
  if (metersPerSecond <= 0) return "-";
  const secPerKm = 1000 / metersPerSecond;
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${sec.toString().padStart(2, "0")}/km`;
}

export function buildActivityAnalysisRequest(detail: DetailedActivity): string {
  const discipline = getDiscipline(detail);
  const dist =
    discipline === "swim"
      ? `${detail.distance.toFixed(0)}m`
      : `${(detail.distance / 1000).toFixed(2)}km`;

  const splits = detail.splits_metric
    ?.map(
      (s) =>
        `  km${s.split}: ${formatPaceFromSpeed(s.average_speed)}` +
        (s.average_heartrate ? ` HR ${s.average_heartrate.toFixed(0)}` : "") +
        (s.elevation_difference
          ? ` (${s.elevation_difference > 0 ? "+" : ""}${Math.round(s.elevation_difference)}m)`
          : ""),
    )
    .join("\n");

  const efforts = detail.best_efforts
    ?.map((e) => `  ${e.name}: ${Math.floor(e.moving_time / 60)}:${String(e.moving_time % 60).padStart(2, "0")}`)
    .join("\n");

  return `Analyze this activity for me:

Activity: "${detail.name}" (${discipline})
Date: ${detail.start_date_local.split("T")[0]}
Distance: ${dist} | Moving time: ${Math.round(detail.moving_time / 60)}min | Pace: ${formatPace(detail)}
${detail.average_heartrate ? `Avg HR: ${detail.average_heartrate.toFixed(0)} | Max HR: ${detail.max_heartrate?.toFixed(0) ?? "-"}` : "No HR data"}
${detail.total_elevation_gain ? `Elevation gain: ${Math.round(detail.total_elevation_gain)}m` : ""}
${detail.suffer_score ? `Suffer score: ${detail.suffer_score}` : ""}
${detail.description ? `Athlete notes: ${detail.description}` : ""}
${splits ? `\nSplits:\n${splits}` : ""}
${efforts ? `\nBest efforts:\n${efforts}` : ""}

Give me:
1. **Verdict** — how this session went relative to its purpose in my plan and my goals (one short paragraph).
2. **What went well / what to improve** — grounded in the splits, HR, and pacing data above.
3. **Cross-training** — given my upcoming plan sessions and current fatigue (TSB), what swim/bike cross-training is reasonable in the next few days, or whether I should skip it.

Keep it tight and specific to my data.`;
}
