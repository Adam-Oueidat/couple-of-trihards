import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { chatLimiter, createLogger, TRAINING_HISTORY_WEEKS } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";

const log = createLogger("api:chat");
import { getRecentActivities } from "@/lib/strava";
import {
  buildTrainingContext,
  COACH_SYSTEM_PROMPT,
  localDateOf,
  resolveToday,
  summarizeConversation,
} from "@/lib/coach";
import { addWorkout, validateWorkoutInput } from "@/lib/workouts";
import {
  getCarryoverSummary,
  getConversation,
  getConversationMessages,
  getLatestConversation,
  getOrCreateConversation,
  lastInteractionTs,
  messageToText,
  saveMessage,
  setConversationSummary,
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

  const activities = await getRecentActivities(auth, TRAINING_HISTORY_WEEKS);
  // The browser sends its local date so the coach reasons in the athlete's
  // timezone rather than the server's UTC clock.
  const clientToday =
    typeof body.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.today)
      ? body.today
      : undefined;
  const today = resolveToday(clientToday, activities);

  // When was the athlete last in any conversation? Read it before we touch the
  // DB so newly-logged activities can be flagged "new since we last spoke".
  const sinceTs = await lastInteractionTs(userId);

  // Resume the requested conversation only if it's from today. A prior-day
  // thread is stale (the source of date-confusion), so we open a fresh one —
  // the same backstop the client applies on mount.
  const requested =
    typeof body.conversationId === "string"
      ? await getConversation(userId, body.conversationId)
      : null;
  const isStale =
    requested !== null &&
    localDateOf(requested.lastMessageAt, activities) !== today;

  let conversationId: string;
  if (requested && !isStale) {
    conversationId = requested.id;
  } else {
    // Leaving a thread (cleared, or a new day): summarize it for memory, then
    // start fresh. Best-effort — never let summarization block the chat.
    const leaving = requested ?? (await getLatestConversation(userId));
    if (leaving && !leaving.summary) {
      try {
        const prior = await getConversationMessages(userId, leaving.id, 50);
        const text: { role: string; content: string }[] = [];
        for (const m of prior) {
          const content = messageToText(m);
          if (content !== null) text.push({ role: m.role, content });
        }
        const summary = await summarizeConversation(text);
        if (summary) await setConversationSummary(userId, leaving.id, summary);
      } catch (err) {
        log.warn("conversation summary failed", {
          userId,
          conversationId: leaving.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    conversationId = await getOrCreateConversation(userId);
  }

  // Carry the most recent prior-conversation summary into context as memory.
  const priorSummary = await getCarryoverSummary(userId, conversationId);

  log.info("chat turn", {
    userId,
    conversationId,
    newConversation: requested === null || isStale,
    messageLen: body.messages[body.messages.length - 1].content.length,
  });

  const trainingContext = await buildTrainingContext(
    auth,
    activities,
    clientToday,
    { priorSummary, sinceTs },
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

          // Each tool_use block is an independent write (addWorkout inserts a
          // distinct row), so execute them concurrently. `.map` preserves order,
          // so tool_result blocks still line up with their tool_use ids.
          const toolUses = final.content.filter(
            (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
          );
          const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
            toolUses.map(async (block) => {
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
              return {
                type: "tool_result" as const,
                tool_use_id: block.id,
                content: result,
              };
            }),
          );

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
