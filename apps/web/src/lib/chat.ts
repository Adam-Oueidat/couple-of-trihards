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

export async function getLatestConversationId(userId: string): Promise<string | null> {
  const db = getDb();
  const [latest] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);
  return latest?.id ?? null;
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
  await db
    .update(conversations)
    .set({ lastMessageAt: Math.floor(Date.now() / 1000) })
    .where(eq(conversations.id, conversationId));
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
