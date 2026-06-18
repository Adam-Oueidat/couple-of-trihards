import { NextRequest, NextResponse } from "next/server";
import { defaultLimiter } from "@trihards/core";
import { isAuthFailure, requireAuth } from "@/lib/auth";
import { withLimit } from "@/lib/api";
import {
  getConversationMessages,
  getLatestConversationId,
  messageToText,
} from "@/lib/chat";

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (isAuthFailure(auth)) return auth;
  const limited = await withLimit(defaultLimiter(), auth.userId);
  if (limited) return limited;

  const url = new URL(request.url);
  let conversationId = url.searchParams.get("conversation_id");
  if (!conversationId) {
    conversationId = await getLatestConversationId(auth.userId);
  }
  if (!conversationId) {
    return NextResponse.json({ conversationId: null, messages: [] });
  }

  const stored = await getConversationMessages(auth.userId, conversationId, 50);
  const messages = stored
    .map((m) => {
      const text = messageToText(m);
      if (!text) return null;
      return { role: m.role, content: text };
    })
    .filter((m): m is { role: "user" | "assistant"; content: string } => m !== null);

  return NextResponse.json({ conversationId, messages });
}
