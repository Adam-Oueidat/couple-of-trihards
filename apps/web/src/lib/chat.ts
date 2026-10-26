import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gte } from "drizzle-orm";
import { chatMessages, conversations, getDb } from "@trihards/db";

export type MessageRole = "user" | "assistant";

export interface StoredMessage {
  id: string;
  role: MessageRole;
  content: string | Anthropic.ContentBlockParam[];
  createdAt: number;
}

export async function getOrCreateConversation(
  userId: string,
  conversationId?: string,
): Promise<string> {
  const db = getDb();
  if (conversationId) {
    const [existing] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.userId, userId),
        ),
      );
    if (existing) return existing.id;
  }
  const [created] = await db
    .insert(conversations)
    .values({ userId })
    .returning({ id: conversations.id });
  return created.id;
}

export interface ConversationMeta {
  id: string;
  startedAt: number;
  lastMessageAt: number;
  summary: string | null;
}

export async function getLatestConversation(
  userId: string,
): Promise<ConversationMeta | null> {
  const db = getDb();
  const [latest] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);
  if (!latest) return null;
  return {
    id: latest.id,
    startedAt: latest.startedAt,
    lastMessageAt: latest.lastMessageAt,
    summary: latest.summary,
  };
}

export async function getConversation(
  userId: string,
  conversationId: string,
): Promise<ConversationMeta | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId),
      ),
    );
  if (!row) return null;
  return {
    id: row.id,
    startedAt: row.startedAt,
    lastMessageAt: row.lastMessageAt,
    summary: row.summary,
  };
}

export async function setConversationSummary(
  userId: string,
  conversationId: string,
  summary: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(conversations)
    .set({ summary })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId),
      ),
    );
}

// Conversations with a turn at or after `sinceTs`, newest first — the window
// the coach's shared memory is built from (see coach-memory.ts).
export async function getRecentConversations(
  userId: string,
  sinceTs: number,
  limit: number,
): Promise<ConversationMeta[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, userId),
        gte(conversations.lastMessageAt, sinceTs),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    startedAt: r.startedAt,
    lastMessageAt: r.lastMessageAt,
    summary: r.summary,
  }));
}

// Unix-seconds timestamp of the user's most recent chat turn across all
// conversations (max lastMessageAt), or null. Used as the "since we last spoke"
// cutoff for surfacing newly-logged activities — read it *before* persisting the
// current turn.
export async function lastInteractionTs(
  userId: string,
): Promise<number | null> {
  const db = getDb();
  const [latest] = await db
    .select({ lastMessageAt: conversations.lastMessageAt })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);
  return latest?.lastMessageAt ?? null;
}

function parseContent(raw: string): string | Anthropic.ContentBlockParam[] {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function saveMessage(
  userId: string,
  conversationId: string,
  role: MessageRole,
  // The coach streams through the beta namespace, whose blocks are a superset.
  content:
    | string
    | Anthropic.ContentBlockParam[]
    | Anthropic.Beta.BetaContentBlockParam[],
): Promise<void> {
  const db = getDb();
  await db.insert(chatMessages).values({
    userId,
    conversationId,
    role,
    content: JSON.stringify(content),
  });
  // Scoped by userId like every other conversation query in this file. The id
  // always arrives from an already-scoped lookup today, so this is not
  // currently reachable — it closes the one gap in the invariant rather than a
  // live hole.
  await db
    .update(conversations)
    .set({ lastMessageAt: Math.floor(Date.now() / 1000) })
    .where(
      and(eq(conversations.id, conversationId), eq(conversations.userId, userId)),
    );
}

// The newest `limit` messages of a conversation, returned oldest → newest.
// Counted from the end of the thread: past the limit, it is the opening turns
// that drop out, never the latest ones.
export async function getLatestConversationMessages(
  userId: string,
  conversationId: string,
  limit: number,
): Promise<StoredMessage[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.userId, userId),
        eq(chatMessages.conversationId, conversationId),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit);
  return rows.reverse().map((r) => ({
    id: r.id,
    role: r.role as MessageRole,
    content: parseContent(r.content),
    createdAt: r.createdAt,
  }));
}

// A stored row the API will accept as the first turn of a replay: a user turn
// that is the athlete talking, not a tool_result answering a tool_use that has
// fallen out of the window.
function isPlainUserTurn(m: StoredMessage): boolean {
  if (m.role !== "user") return false;
  if (typeof m.content === "string") return true;
  return !m.content.some((b) => b.type === "tool_result");
}

function hasToolUse(m: StoredMessage): boolean {
  return (
    m.role === "assistant" &&
    typeof m.content !== "string" &&
    m.content.some((b) => b.type === "tool_use")
  );
}

// Snap a newest-N slice of a thread to boundaries the API accepts. The front is
// trimmed to the first plain user turn, so the window never opens on an orphaned
// tool_result or on an assistant turn. The back drops an assistant tool_use
// whose tool_result was never stored (a round cut off mid-stream), since a
// dangling tool_use is the same 400 from the other side.
export function trimToReplayWindow(messages: StoredMessage[]): StoredMessage[] {
  const start = messages.findIndex(isPlainUserTurn);
  if (start === -1) return [];
  let end = messages.length;
  while (end > start && hasToolUse(messages[end - 1])) end--;
  return messages.slice(start, end);
}

// The last `limit` rows of a thread that can be replayed to the model as-is.
export async function getReplayHistory(
  userId: string,
  conversationId: string,
  limit: number,
): Promise<StoredMessage[]> {
  return trimToReplayWindow(
    await getLatestConversationMessages(userId, conversationId, limit),
  );
}

// For UI rendering: collapse complex content into a text string. Returns
// null for messages that are purely tool plumbing (no visible text).
export function messageToText(m: StoredMessage): string | null {
  if (typeof m.content === "string") return m.content;
  const texts: string[] = [];
  for (const block of m.content) {
    if (block.type === "text") texts.push(block.text);
  }
  return texts.length > 0 ? texts.join("\n") : null;
}
