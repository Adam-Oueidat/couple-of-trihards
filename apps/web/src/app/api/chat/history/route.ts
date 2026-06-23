import { NextRequest, NextResponse } from "next/server";
import { defaultLimiter } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import {
  getConversation,
  getConversationMessages,
  getLatestConversation,
  messageToText,
} from "@/lib/chat";

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  const url = new URL(request.url);
  const requestedId = url.searchParams.get("conversation_id");
  const conversation = requestedId
    ? await getConversation(auth.userId, requestedId)
    : await getLatestConversation(auth.userId);
  if (!conversation) {
    return NextResponse.json({
      conversationId: null,
      messages: [],
      startedAt: null,
      lastMessageAt: null,
    });
  }

  const stored = await getConversationMessages(auth.userId, conversation.id, 50);
  const messages = stored
    .map((m) => {
      const text = messageToText(m);
      if (!text) return null;
      return { role: m.role, content: text };
    })
    .filter((m): m is { role: "user" | "assistant"; content: string } => m !== null);

  return NextResponse.json({
    conversationId: conversation.id,
    messages,
    startedAt: conversation.startedAt,
    lastMessageAt: conversation.lastMessageAt,
  });
}
