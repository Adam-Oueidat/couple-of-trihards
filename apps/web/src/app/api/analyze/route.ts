import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { analyzeLimiter, createLogger, TRAINING_HISTORY_WEEKS } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";

const log = createLogger("api:analyze");
import { getActivityDetail, getRecentActivities } from "@/lib/strava";
import { ownsActivityIn } from "@/lib/activity-access";
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
  // The caller's own activity list doubles as the authorization check: an id
  // that isn't in it isn't theirs to analyze. Checking before fetching the
  // detail also avoids spending a Strava read on a request we will reject.
  // 404 rather than 403 — a 403 would confirm the activity exists.
  const activities = await getRecentActivities(auth, TRAINING_HISTORY_WEEKS);
  if (!ownsActivityIn(activities, activityId)) {
    log.warn("rejected activity not owned by caller", { userId, activityId });
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }

  const detail = await getActivityDetail(auth, activityId);
  await updatePersonalBests(userId, detail);
  const { identity, context: trainingContext } = await buildTrainingContext(
    auth,
    activities,
  );

  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-6",
    max_tokens: 1200,
    // Stable → volatile, with the breakpoints on the two repeating blocks.
    // See the same construction in app/api/chat/route.ts for the reasoning.
    system: [
      {
        type: "text",
        text: COACH_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: identity,
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: trainingContext },
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
