import { describe, expect, it } from "vitest";
import { makeInMemoryLimiter } from "../src/rate-limit";

describe("in-memory limiter", () => {
  it("allows requests up to the token count, then rejects", async () => {
    const lim = makeInMemoryLimiter(3, 60_000);
    expect((await lim.limit("a")).success).toBe(true);
    expect((await lim.limit("a")).success).toBe(true);
    expect((await lim.limit("a")).success).toBe(true);
    expect((await lim.limit("a")).success).toBe(false);
  });

  it("scopes counters per identifier", async () => {
    const lim = makeInMemoryLimiter(1, 60_000);
    expect((await lim.limit("alice")).success).toBe(true);
    expect((await lim.limit("alice")).success).toBe(false);
    expect((await lim.limit("bob")).success).toBe(true);
  });

  it("resets after the window expires", async () => {
    const lim = makeInMemoryLimiter(1, 10);
    expect((await lim.limit("x")).success).toBe(true);
    expect((await lim.limit("x")).success).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect((await lim.limit("x")).success).toBe(true);
  });
});
