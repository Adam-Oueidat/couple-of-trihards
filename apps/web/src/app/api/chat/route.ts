import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { chatLimiter, createLogger } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";

const log = createLogger("api:chat");
import { getRecentActivities } from "@/lib/strava";
import { buildTrainingContext, COACH_SYSTEM_PROMPT } from "@/lib/coach";
import { addWorkout, validateWorkoutInput } from "@/lib/workouts";
import {
  getConversationMessages,
  getOrCreateConversation,
  saveMessage,
} from "@/lib/chat";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TOOLS: Anthropic.Tool[] = [
  {
    name: "add_workout",
    description:
      "Add a swim, ride, or run workout to the athlete's training calendar. Only call this after you have assessed that the workout is compatible with the surrounding plan sessions and training load, and the athlete has clearly expressed they want it added. The workout will appear on their calendar immediately.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format" },
        discipline: { type: "string", enum: ["swim", "ride", "run"] },
        name: {
          type: "string",
          description: "Short workout name, e.g. 'Easy swim - technique focus'",
        },
        distance_km: { type: "number", description: "Planned distance in km (optional)" },
        duration_min: { type: "number", description: "Planned duration in minutes (optional)" },
        notes: {
          type: "string",
          description: "Brief coaching notes: intent, intensity, what to watch for (optional)",
        },
      },
      required: ["date", "discipline", "name"],
    },
  },
];

interface ClientMessage {
  role: "user" | "assistant";
  content: string;
}

function isValidMessages(value: unknown): value is ClientMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 50 &&
    value.every(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.length > 0 &&
        m.content.length <= 8000,
    )
  );
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const { userId } = auth;
  const limited = await withLimit(chatLimiter(), userId);
  if (limited) return limited;

  const body = await request.json();
  if (!isValidMessages(body.messages)) {
    return new Response(JSON.stringify({ error: "Invalid messages" }), {
      status: 400,
    });
  }

  const conversationId = await getOrCreateConversation(
    userId,
    typeof body.conversationId === "string" ? body.conversationId : undefined,
  );
  log.info("chat turn", {
    userId,
    conversationId,
    newConversation: typeof body.conversationId !== "string",
    messageLen: body.messages[body.messages.length - 1].content.length,
  });

  const activities = await getRecentActivities(12);
  // The browser sends its local date so the coach reasons in the athlete's
  // timezone rather than the server's UTC clock.
  const clientToday =
    typeof body.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.today)
      ? body.today
      : undefined;
  const trainingContext = await buildTrainingContext(
    userId,
    activities,
    clientToday,
  );

  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: COACH_SYSTEM_PROMPT },
    {
      type: "text",
      text: trainingContext,
      cache_control: { type: "ephemeral" },
    },
  ];

  // Pull the latest user turn — that's the one we'll persist.
  const newUserMessage = body.messages[body.messages.length - 1];

  // Load prior persisted history (oldest → newest) and convert to Anthropic
  // MessageParam shape, then append the just-arrived turn.
  const history = await getConversationMessages(userId, conversationId, 20);
  const persistedTurns: Anthropic.MessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const conversation: Anthropic.MessageParam[] = [
    ...persistedTurns,
    { role: "user", content: newUserMessage.content },
  ];

  await saveMessage(userId, conversationId, "user", newUserMessage.content);

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for (let round = 0; round < 5; round++) {
          const stream = anthropic.messages.stream({
            model: "claude-sonnet-4-6",
            max_tokens: 1500,
            system,
            tools: TOOLS,
            messages: conversation,
          });

          for await (const event of stream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              controller.enqueue(encoder.encode(event.delta.text));
            }
          }

          const final = await stream.finalMessage();
          // Persist the full assistant turn (text + tool_use blocks).
          await saveMessage(userId, conversationId, "assistant", final.content);

          if (final.stop_reason !== "tool_use") break;

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of final.content) {
            if (block.type !== "tool_use") continue;
            let result: string;
            if (block.name === "add_workout") {
              try {
                const input = validateWorkoutInput(block.input);
                const workout = await addWorkout(userId, input, "coach");
                log.info("coach added workout", {
                  userId,
                  workoutId: workout.id,
                  date: workout.date,
                  discipline: workout.discipline,
                });
                result = `Added to calendar: ${workout.name} (${workout.discipline}) on ${workout.date}`;
              } catch (err) {
                log.warn("add_workout tool failed", {
                  userId,
                  error: err instanceof Error ? err.message : String(err),
                });
                result = `Failed to add workout: ${err instanceof Error ? err.message : "unknown error"}`;
              }
            } else {
              log.warn("unknown tool requested", { userId, name: block.name });
              result = `Unknown tool: ${block.name}`;
            }
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: result,
            });
          }

          // Persist the tool_result turn so the next request can replay it.
          await saveMessage(userId, conversationId, "user", toolResults);

          conversation.push({ role: "assistant", content: final.content });
          conversation.push({ role: "user", content: toolResults });
          controller.enqueue(encoder.encode("\n\n"));
        }
        controller.close();
      } catch (err) {
        log.error("chat stream failed", err);
        controller.error(err);
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Conversation-Id": conversationId,
    },
  });
}
