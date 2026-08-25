import { beforeEach, describe, expect, it, vi } from "vitest";

// The in-memory activity cache is keyed by athlete as well as activity id.
// Without the athlete component a cache hit short-circuits the Strava call, so
// athlete B asking for athlete A's private activity gets A's payload back
// without Strava ever being consulted. These tests pin that shut.

const session = {
  tokens: {
    athlete_id: 1,
    access_token: "token-athlete-1",
    refresh_token: "refresh",
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
  },
  save: async () => {},
};

vi.mock("./session", () => ({ getSession: async () => session }));

function asAthlete(id: number) {
  session.tokens = { ...session.tokens, athlete_id: id, access_token: `token-athlete-${id}` };
}

let fetchCalls: string[] = [];

beforeEach(() => {
  fetchCalls = [];
  asAthlete(1);
  vi.stubGlobal("fetch", async (url: string | URL) => {
    const href = url.toString();
    fetchCalls.push(href);
    return new Response(
      JSON.stringify({ id: 4242, name: `payload for ${session.tokens.athlete_id}` }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
});

describe("getActivityDetail cache scoping", () => {
  it("serves a second athlete from Strava rather than the first athlete's cached copy", async () => {
    const { getActivityDetail } = await import("./strava");

    const first = await getActivityDetail(4242);
    expect(first).toMatchObject({ name: "payload for 1" });
    expect(fetchCalls).toHaveLength(1);

    // Same athlete, same activity — must be served from cache.
    await getActivityDetail(4242);
    expect(fetchCalls).toHaveLength(1);

    // Different athlete, same activity id. This is the leak: before the fix the
    // cache answered with athlete 1's payload and Strava was never asked, so
    // athlete 2's token was never checked against the activity.
    asAthlete(2);
    const second = await getActivityDetail(4242);
    expect(fetchCalls).toHaveLength(2);
    expect(second).toMatchObject({ name: "payload for 2" });
    expect(fetchCalls[1]).toContain("/activities/4242");
  });
});

describe("getActivityStreams cache scoping", () => {
  it("does not serve one athlete's streams to another", async () => {
    const { getActivityStreams } = await import("./strava");

    await getActivityStreams(777);
    expect(fetchCalls).toHaveLength(1);

    await getActivityStreams(777);
    expect(fetchCalls).toHaveLength(1);

    asAthlete(3);
    await getActivityStreams(777);
    expect(fetchCalls).toHaveLength(2);
  });
});
