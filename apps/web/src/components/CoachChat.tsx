"use client";

import { useEffect, useRef, useState } from "react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "How balanced is my training across the three disciplines?",
  "Am I at risk of overtraining right now?",
  "How should I structure next week based on my current form?",
];

// The athlete's local calendar date (YYYY-MM-DD). Sent with each turn so the
// coach anchors on the user's real timezone instead of the server's UTC clock.
function localToday(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function CoachChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Load the latest conversation on mount — but only resume it if it's from
    // today. A thread from a prior calendar day is stale (its replayed turns
    // carry old dates and confuse the coach), so we leave the panel fresh and
    // let the next message open a new thread. The browser clock is the
    // athlete's real timezone, so it's the most accurate day-boundary signal.
    (async () => {
      try {
        const res = await fetch("/api/chat/history");
        if (!res.ok) return;
        const data = await res.json();
        const sameDay =
          typeof data.lastMessageAt === "number" &&
          new Date(data.lastMessageAt * 1000).toDateString() ===
            new Date().toDateString();
        if (sameDay && data.conversationId) {
          setConversationId(data.conversationId);
          if (Array.isArray(data.messages)) setMessages(data.messages);
        }
      } catch {
        // best-effort; user can still chat without history
      }
    })();
  }, []);

  // Begin a fresh thread. Non-destructive: the old conversation stays in the DB
  // and gets summarized server-side when the next message opens a new thread.
  function clearChat() {
    if (loading) return;
    setConversationId(null);
    setMessages([]);
    setError(null);
    setInput("");
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || loading) return;

    setError(null);
    setInput("");
    const history = [...messages, { role: "user" as const, content }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content }],
          conversationId,
          today: localToday(),
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Request failed (${res.status})`);
      }

      const newConvId = res.headers.get("X-Conversation-Id");
      if (newConvId && newConvId !== conversationId) {
        setConversationId(newConvId);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        assistantText += decoder.decode(value, { stream: true });
        setMessages([
          ...history,
          { role: "assistant", content: assistantText },
        ]);
      }
    } catch (err) {
      console.error(err);
      setError("Something went wrong. Please try again.");
      setMessages(history);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-800 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
            AI Coach
          </h2>
          <p className="text-gray-600 text-xs mt-0.5">
            Grounded in your last 12 months of Strava data
          </p>
        </div>
        {messages.length > 0 && (
          <button
            onClick={clearChat}
            disabled={loading}
            className="shrink-0 text-xs text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-600 rounded-full px-3 py-1 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            New chat
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center gap-3">
            <p className="text-gray-500 text-sm">
              Ask anything about your training.
            </p>
            <div className="flex flex-col gap-2 w-full max-w-md">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="text-left text-sm text-gray-300 bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-gray-600 rounded-lg px-4 py-2.5 transition-colors cursor-pointer"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap leading-relaxed ${
                m.role === "user"
                  ? "bg-orange-500 text-white"
                  : "bg-gray-800 text-gray-200 border border-gray-700"
              }`}
            >
              {m.content || (
                <span className="inline-flex gap-1">
                  <span className="animate-pulse">●</span>
                  <span className="animate-pulse [animation-delay:150ms]">●</span>
                  <span className="animate-pulse [animation-delay:300ms]">●</span>
                </span>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {error && (
        <p className="px-5 py-2 text-red-400 text-xs bg-red-950/40 border-t border-red-900">
          {error}
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex gap-2 p-4 border-t border-gray-800"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="Message to your coach"
          placeholder="Ask your coach..."
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-orange-500"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="px-5 py-2.5 bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors cursor-pointer"
        >
          Send
        </button>
      </form>
    </div>
  );
}
