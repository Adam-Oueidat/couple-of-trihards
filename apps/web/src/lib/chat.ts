import Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq } from "drizzle-orm";
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

// The most recent non-null summary from the user's *other* conversations — the
// rolling memory we inject so continuity survives a fresh daily thread.
export async function getCarryoverSummary(
  userId: string,
  excludeConversationId: string,
): Promise<string | null> {
  const db = getDb();
  const rows = await db
    .select({ id: conversations.id, summary: conversations.summary })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(10);
  for (const r of rows) {
    if (r.id !== excludeConversationId && r.summary) return r.summary;
  }
  return null;
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

export async function getConversationMessages(
  userId: string,
  conversationId: string,
  limit = 20,
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
    .orderBy(asc(chatMessages.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    role: r.role as MessageRole,
    content: parseContent(r.content),
    createdAt: r.createdAt,
  }));
}

export async function saveMessage(
  userId: string,
  conversationId: string,
  role: MessageRole,
  content: string | Anthropic.ContentBlockParam[],
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
