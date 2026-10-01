import {
  buildBlockAnalysis,
  calcTrainingLoad,
  createLogger,
  formatBlockAnalysis,
  observedMaxHr,
  resolveBlockWindows,
  resolveZoneModel,
  type AthleteNote,
  type StravaActivity,
} from "@trihards/core";
import { getAthleteZones, type StravaIdentity } from "./strava";
import { getQualityProfiles } from "./quality-scan";
import { getOverrides } from "./plan-overrides";
import { getActiveTrainingPlan } from "./training-plans";

const log = createLogger("block-analysis");

export interface BlockAnalysisRequest {
  blocks?: { from: string; to: string }[];
  weeks?: number;
  count?: number;
}

/** Shape-check model-generated tool input; anything unusable is dropped. */
export function parseBlockAnalysisRequest(input: unknown): BlockAnalysisRequest {
  const o = (input ?? {}) as Record<string, unknown>;
  const req: BlockAnalysisRequest = {};
  if (Array.isArray(o.blocks)) {
    req.blocks = o.blocks.map((b) => {
      const r = (b ?? {}) as Record<string, unknown>;
      return { from: String(r.from ?? ""), to: String(r.to ?? "") };
    });
  }
  if (typeof o.block_weeks === "number") req.weeks = o.block_weeks;
  if (typeof o.block_count === "number") req.count = o.block_count;
  return req;
}

/**
 * The coach's block comparison, rendered as text for a tool result.
 *
 * Skip reasons ride along as athlete notes because they are the one cause the
 * data cannot measure: a slow block with "calf niggle" against three skipped
 * runs reads very differently from the same block without it.
 */
export async function analyzeTrainingBlocks(
  identity: StravaIdentity,
  activities: StravaActivity[],
  today: string,
  req: BlockAnalysisRequest,
): Promise<string> {
  const { userId } = identity;
  const earliest =
    activities.reduce<string | null>((min, a) => {
      const d = a.start_date_local.split("T")[0];
      return min === null || d < min ? d : min;
    }, null) ?? today;
  const blocks = resolveBlockWindows(req, today, earliest);

  const [zones, profiles, overrides, activePlan] = await Promise.all([
    getAthleteZones(identity).catch((err) => {
      log.warn("HR zones unavailable", { reason: String(err) });
      return null;
    }),
    getQualityProfiles(userId, blocks[0]?.from),
    getOverrides(userId),
    getActiveTrainingPlan(userId),
  ]);

  const plan = activePlan?.plan ?? null;
  const notes: AthleteNote[] = Object.values(overrides)
    .filter((o) => o.skipped && !o.hidden)
    .map((o) => {
      const name = plan?.sessions.find((s) => s.id === o.sessionId)?.name ?? "a session";
      return { date: o.newDate, text: `skipped ${name}: ${o.skipReason ?? "no reason given"}` };
    });

  const analysis = buildBlockAnalysis({
    activities,
    model: resolveZoneModel(zones, observedMaxHr(activities)),
    profiles,
    load: calcTrainingLoad(activities, today),
    blocks,
    notes,
  });
  return formatBlockAnalysis(analysis);
}
