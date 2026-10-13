import Anthropic from "@anthropic-ai/sdk";
import { createLogger, SUMMARY_MODEL, type StravaActivity } from "@trihards/core";
import { learnFromAthlete } from "./brain-notes";
import {
  getConversationMessages,
  getLatestConversationMessages,
  getRecentConversations,
  messageToText,
  setConversationSummary,
  type ConversationMeta,
  type StoredMessage,
} from "./chat";
import { dayOfWeekOf, daysBetween, localDateOf } from "./coach-dates";

const log = createLogger("coach-memory");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// What the coach remembers of its own chats: the short-term part of the brain
// (see brain.ts), which every AI surface reads. Before this existed the
// analysis was built from training data alone, so anything settled in chat — a
// rest day already taken, a reshaped week — was invisible to it and it kept
// prescribing the same thing again.

// How far back the memory reaches, and how many chats it holds at most.
const MEMORY_DAYS = 14;
const MEMORY_MAX_CONVERSATIONS = 6;
// Bounds on the verbatim transcript of a chat that is still open.
const TRANSCRIPT_ROWS = 40;
const TRANSCRIPT_MESSAGE_CHARS = 1500;
const TRANSCRIPT_TOTAL_CHARS = 6000;
// A finished chat read for standing notes gets more room than one quoted in a prompt.
const LEARN_TRANSCRIPT_CHARS = 12000;

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
export function clip(text: string, max: number): string {
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

// The week either side of a date, one "Weekday YYYY-MM-DD" per line. The
// summary model is handed this to look dates up in: asked to work out which
// date "Thursday" was, it put a rest day on the wrong one.
function calendarAround(date: string): string {
  const base = Date.parse(`${date}T00:00:00Z`);
  const lines: string[] = [];
  for (let offset = -7; offset <= 7; offset++) {
    const day = new Date(base + offset * 86400000).toISOString().slice(0, 10);
    lines.push(`${dayOfWeekOf(day)} ${day}${offset === 0 ? " (day of this conversation)" : ""}`);
  }
  return lines.join("\n");
}

// Condense a finished conversation into a few sentences for the coach's own
// future reference. Cheap model, best-effort — callers must tolerate null.
export async function summarizeConversation(
  messages: { role: string; content: string }[],
  // Athlete-local date the conversation took place (YYYY-MM-DD). It is what
  // lets "I rested yesterday" be recorded as a day rather than lost.
  date?: string,
): Promise<string | null> {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "Athlete" : "Coach"}: ${m.content}`)
    .join("\n")
    .trim();
  if (!transcript) return null;
  const res = await anthropic.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 600,
    system:
      "You summarize a triathlon coaching conversation for the coach's own future reference. Write 4-7 sentences in plain past tense. Capture: the topics discussed, any injuries, concerns, or goals the athlete raised, and any workouts added. Above all, record what was settled, since later advice has to stay consistent with it: what the athlete said they did or did not do (rest days taken, sessions done, skipped or swapped), what the coach advised, and what the two agreed for the coming days. Give every such fact its day. When the date of the conversation is provided, turn relative days (today, yesterday, Friday, tomorrow) into the weekday plus the calendar date, e.g. 'rested on Friday 2026-10-09', looking the date up in the calendar given with it rather than calculating it; when it is not, keep the athlete's own wording and do not guess a date. No preamble, no headings, plain text only.",
    messages: [
      {
        role: "user",
        content: date
          ? `This conversation took place on ${dayOfWeekOf(date)} ${date}.\nCalendar around it, to read dates from rather than work them out:\n${calendarAround(date)}\n\n${transcript}`
          : transcript,
      },
    ],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return text || null;
}

// Summarize a finished conversation and store the result on it. Best-effort:
// returns null rather than throwing, since memory must never block a reply.
export async function summarizeAndStore(
  userId: string,
  conversation: ConversationMeta,
  date: string,
): Promise<string | null> {
  try {
    const turns = textTurns(await getConversationMessages(userId, conversation.id, 50));
    // The recap is what the chat settled; the notes are what it revealed that
    // will still be true in a month. Read for both at once, since the reply
    // waits on this.
    const [summary] = await Promise.all([
      summarizeConversation(turns, date),
      learnFromAthlete(userId, {
        source: "chat",
        date,
        text: formatTranscript(turns, LEARN_TRANSCRIPT_CHARS),
      }),
    ]);
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
