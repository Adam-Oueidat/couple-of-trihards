import { describe, expect, it } from "vitest";
import { trimToReplayWindow, type StoredMessage } from "./chat";

let seq = 0;
function msg(role: StoredMessage["role"], content: StoredMessage["content"]): StoredMessage {
  seq += 1;
  return { id: `m${seq}`, role, content, createdAt: seq };
}

const toolUse = (id: string) =>
  msg("assistant", [
    { type: "text", text: "Let me check." },
    { type: "tool_use", id, name: "get_activities", input: {} },
  ]);
const toolResult = (id: string) =>
  msg("user", [{ type: "tool_result", tool_use_id: id, content: "[]" }]);

describe("trimToReplayWindow", () => {
  it("keeps a window that already starts and ends cleanly", () => {
    const window = [msg("user", "hi"), msg("assistant", "hello")];
    expect(trimToReplayWindow(window)).toEqual(window);
  });

  it("drops an orphaned tool_result whose tool_use fell out of the window", () => {
    const window = [
      toolResult("a"),
      msg("assistant", "Done."),
      msg("user", "thanks"),
      msg("assistant", "Any time."),
    ];
    expect(trimToReplayWindow(window).map((m) => m.content)).toEqual([
      "thanks",
      "Any time.",
    ]);
  });

  it("never opens on an assistant turn", () => {
    const window = [msg("assistant", "late reply"), msg("user", "next"), msg("assistant", "ok")];
    expect(trimToReplayWindow(window)[0].content).toBe("next");
  });

  it("drops a trailing tool_use that never got its tool_result", () => {
    const window = [msg("user", "how was my week?"), toolUse("b")];
    expect(trimToReplayWindow(window).map((m) => m.content)).toEqual([
      "how was my week?",
    ]);
  });

  it("keeps a complete tool round inside the window", () => {
    const window = [
      msg("user", "how was my week?"),
      toolUse("c"),
      toolResult("c"),
      msg("assistant", "Solid."),
    ];
    expect(trimToReplayWindow(window)).toEqual(window);
  });

  it("is empty when no plain user turn is in the window", () => {
    expect(trimToReplayWindow([toolResult("d"), msg("assistant", "x")])).toEqual([]);
  });

  // The 20-row window of a 30-row thread whose cut lands inside a tool round:
  // newest-20 starts on the round's tool_result, which must be trimmed away.
  it("snaps a newest-N slice of a long thread that splits a tool pair", () => {
    const thread: StoredMessage[] = [];
    for (let i = 0; i < 4; i++) {
      thread.push(msg("user", `q${i}`), msg("assistant", `a${i}`));
    }
    thread.push(msg("user", "check my rides"), toolUse("e"), toolResult("e"));
    thread.push(msg("assistant", "Rides look good."));
    for (let i = 4; i < 13; i++) {
      thread.push(msg("user", `q${i}`), msg("assistant", `a${i}`));
    }
    const newest = thread.slice(-20);
    expect(newest[0].content).toEqual(toolResult("e").content);

    const replay = trimToReplayWindow(newest);
    expect(replay[0].content).toBe("q4");
    expect(replay.at(-1)!.content).toBe("a12");
  });
});
