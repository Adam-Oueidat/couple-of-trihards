import { createLogger, type StravaActivity } from "@trihards/core";
import {
  getConversationMessages,
  getLatestConversationMessages,
  getRecentConversations,
  messageToText,
  setConversationSummary,
  type ConversationMeta,
  type StoredMessage,
} from "./chat";
import { summarizeConversation } from "./coach";
import { dayOfWeekOf, daysBetween, localDateOf } from "./coach-dates";

const log = createLogger("coach-memory");

// What the coach remembers of its own chats, shared by the chat and by activity
// analysis. Before this existed the analysis was built from training data
// alone, so anything settled in chat — a rest day already taken, a reshaped
// week — was invisible to it and it kept prescribing the same thing again.

// How far back the memory reaches, and how many chats it holds at most.
const MEMORY_DAYS = 14;
const MEMORY_MAX_CONVERSATIONS = 6;
// Bounds on the verbatim transcript of a chat that is still open.
const TRANSCRIPT_ROWS = 40;
const TRANSCRIPT_MESSAGE_CHARS = 1500;
const TRANSCRIPT_TOTAL_CHARS = 6000;

export interface MemoryEntry {
  // Athlete-local date the chat took place, YYYY-MM-DD.
  date: string;
  // A finished chat is a recap; one still open today is quoted as it stands.
  kind: "recap" | "transcript";
  text: string;
}

interface TextTurn {
  role: string;
  content: string;
}

// The visible turns of a conversation; tool plumbing has no text and drops out.
function textTurns(messages: StoredMessage[]): TextTurn[] {
  const turns: TextTurn[] = [];
  for (const m of messages) {
    const content = messageToText(m);
    if (content !== null && content.trim()) turns.push({ role: m.role, content });
  }
  return turns;
}

// Shorten a long turn from the middle: what was asked sits at the start of a
// message, and what was agreed usually sits at the end of the coach's reply.
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  return `${text.slice(0, head)} [...] ${text.slice(-(max - head))}`;
}

// Render the tail of a conversation within a character budget, newest turns
// kept first since those are where a discussion ends up.
export function formatTranscript(
  turns: TextTurn[],
  totalChars = TRANSCRIPT_TOTAL_CHARS,
  messageChars = TRANSCRIPT_MESSAGE_CHARS,
): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const line = `${turns[i].role === "user" ? "Athlete" : "Coach"}: ${clip(turns[i].content.trim(), messageChars)}`;
    if (lines.length > 0 && used + line.length > totalChars) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines.join("\n");
}

function relativeDay(date: string, today: string): string {
  const days = daysBetween(date, today);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

// The body of the "Earlier coaching context" section, oldest chat first. Every
// entry carries the day it took place, so "I rested yesterday" inside one can be
// pinned to a real date instead of being read against today.
export function formatCoachingMemory(
  entries: MemoryEntry[],
  today: string,
): string | null {
  if (entries.length === 0) return null;
  return [...entries]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(
      (e) =>
        `### Chat on ${dayOfWeekOf(e.date)} ${e.date} (${relativeDay(e.date, today)}) — ${
          e.kind === "recap" ? "recap" : "still open, quoted as it stands"
        }\n${e.text}`,
    )
    .join("\n\n");
}

// Summarize a finished conversation and store the result on it. Best-effort:
// returns null rather than throwing, since memory must never block a reply.
export async function summarizeAndStore(
  userId: string,
  conversation: ConversationMeta,
  date: string,
): Promise<string | null> {
  try {
    const prior = await getConversationMessages(userId, conversation.id, 50);
    const summary = await summarizeConversation(textTurns(prior), date);
    if (summary) await setConversationSummary(userId, conversation.id, summary);
    return summary;
  } catch (err) {
    log.warn("conversation summary failed", {
      userId,
      conversationId: conversation.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// The athlete's recent chats with the coach, as prompt text, or null when there
// are none. Finished chats come back as their stored recap — written now if the
// athlete has not chatted since, because a recap is otherwise only produced by
// the next chat turn. A chat still open today has no recap yet and is quoted.
export async function getCoachingMemory(
  userId: string,
  activities: StravaActivity[],
  today: string,
  opts: { excludeConversationId?: string } = {},
): Promise<string | null> {
  const sinceTs = Math.floor(Date.now() / 1000) - MEMORY_DAYS * 86400;
  const recent = (
    await getRecentConversations(userId, sinceTs, MEMORY_MAX_CONVERSATIONS + 1)
  )
    .filter((c) => c.id !== opts.excludeConversationId)
    .slice(0, MEMORY_MAX_CONVERSATIONS);

  const entries = await Promise.all(
    recent.map(async (c): Promise<MemoryEntry | null> => {
      const date = localDateOf(c.lastMessageAt, activities);
      if (c.summary) return { date, kind: "recap", text: c.summary };
      if (date < today) {
        const summary = await summarizeAndStore(userId, c, date);
        return summary ? { date, kind: "recap", text: summary } : null;
      }
      const text = formatTranscript(
        textTurns(
          await getLatestConversationMessages(userId, c.id, TRANSCRIPT_ROWS),
        ),
      );
      return text ? { date, kind: "transcript", text } : null;
    }),
  );

  return formatCoachingMemory(
    entries.filter((e): e is MemoryEntry => e !== null),
    today,
  );
}
