import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { analyzeLimiter, createLogger, TRAINING_HISTORY_WEEKS } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";

const log = createLogger("api:analyze");
import { getActivityDetail, getRecentActivities } from "@/lib/strava";
import {
  buildActivityAnalysisRequest,
  buildTrainingContext,
  COACH_SYSTEM_PROMPT,
} from "@/lib/coach";
import { saveAnalysis } from "@/lib/analyses";
import { updatePersonalBests } from "@/lib/personal-bests";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const { userId } = auth;
  const limited = await withLimit(analyzeLimiter(), userId);
  if (limited) return limited;

  const body = await request.json();
  const activityId = Number(body.activityId);
  if (!Number.isInteger(activityId) || activityId <= 0) {
    return new Response(JSON.stringify({ error: "Invalid activity id" }), {
      status: 400,
    });
  }

  log.info("analyze start", { userId, activityId });
  const [activities, detail] = await Promise.all([
    getRecentActivities(TRAINING_HISTORY_WEEKS),
    getActivityDetail(activityId),
  ]);
  await updatePersonalBests(userId, detail);
  const trainingContext = await buildTrainingContext(userId, activities);

  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 1200,
    system: [
      { type: "text", text: COACH_SYSTEM_PROMPT },
      {
        type: "text",
        text: trainingContext,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: buildActivityAnalysisRequest(detail) }],
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        let fullText = "";
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            fullText += event.delta.text;
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        if (fullText.length > 0) {
          await saveAnalysis(userId, activityId, fullText);
          log.info("analysis saved", { userId, activityId, length: fullText.length });
        }
        controller.close();
      } catch (err) {
        log.error("analysis stream failed", err);
        controller.error(err);
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
