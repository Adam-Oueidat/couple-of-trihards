import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StravaIdentity } from "./strava";

// The in-memory activity cache is keyed by athlete as well as activity id.
// Without the athlete component a cache hit short-circuits the Strava call, so
// athlete B asking for athlete A's private activity gets A's payload back
// without Strava ever being consulted. These tests pin that shut.
//
// Credentials are resolved per user (see lib/strava-tokens.ts), so the mock
// stands in for the token store rather than the session cookie — which is the
// point of that change: identity comes from the caller, not from a cookie.

vi.mock("./strava-tokens", () => ({
  getValidAccessToken: async (userId: string) => `token-${userId}`,
}));

function identity(n: number): StravaIdentity {
  return { userId: `user-${n}`, stravaAthleteId: n };
}

let fetchCalls: string[] = [];

beforeEach(() => {
  fetchCalls = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const href = url.toString();
    fetchCalls.push(href);
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    return new Response(JSON.stringify({ id: 4242, name: `payload for ${auth}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
});

describe("getActivityDetail cache scoping", () => {
  it("serves a second athlete from Strava rather than the first athlete's cached copy", async () => {
    const { getActivityDetail } = await import("./strava");

    const first = await getActivityDetail(identity(1), 4242);
    expect(first).toMatchObject({ name: "payload for Bearer token-user-1" });
    expect(fetchCalls).toHaveLength(1);

    // Same athlete, same activity — must be served from cache.
    await getActivityDetail(identity(1), 4242);
    expect(fetchCalls).toHaveLength(1);

    // Different athlete, same activity id. This is the leak: before the fix the
    // cache answered with athlete 1's payload and Strava was never asked, so
    // athlete 2's token was never checked against the activity.
    const second = await getActivityDetail(identity(2), 4242);
    expect(fetchCalls).toHaveLength(2);
    expect(second).toMatchObject({ name: "payload for Bearer token-user-2" });
    expect(fetchCalls[1]).toContain("/activities/4242");
  });
});

describe("getActivityStreams cache scoping", () => {
  it("does not serve one athlete's streams to another", async () => {
    const { getActivityStreams } = await import("./strava");

    await getActivityStreams(identity(1), 777);
    expect(fetchCalls).toHaveLength(1);

    await getActivityStreams(identity(1), 777);
    expect(fetchCalls).toHaveLength(1);

    await getActivityStreams(identity(3), 777);
    expect(fetchCalls).toHaveLength(2);
  });
});

describe("credentials follow the caller, not a cookie", () => {
  it("sends each user's own token without any session present", async () => {
    // No cookie is mocked anywhere in this file. Before the change this path
    // read getSession() and threw "Not authenticated" for a bearer-only client.
    const { getActivityDetail } = await import("./strava");

    await getActivityDetail(identity(9), 555);

    expect(fetchCalls).toHaveLength(1);
    const detail = await getActivityDetail(identity(9), 555);
    expect(detail).toMatchObject({ name: "payload for Bearer token-user-9" });
  });
});
