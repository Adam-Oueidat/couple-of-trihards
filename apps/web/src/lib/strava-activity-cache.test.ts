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

describe("getActivityStreamsStrict error handling", () => {
  // The bug this pins shut: getActivityStreams returned null for EVERY error,
  // including 429. A backfill persists what it is told, so a rate limit was
  // recorded as "this activity has no streams" and the activity was never
  // looked at again — one 15-minute limit silently became permanent missing
  // data across the athlete's history.
  function respondWith(status: number, body: string) {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      fetchCalls.push(url.toString());
      return new Response(body, { status, headers: { "Content-Type": "application/json" } });
    });
  }

  it("rethrows a rate limit instead of reporting no streams", async () => {
    const { getActivityStreamsStrict } = await import("./strava");
    respondWith(429, JSON.stringify({ message: "Rate Limit Exceeded" }));

    await expect(getActivityStreamsStrict(identity(21), 1001)).rejects.toThrow(
      /Strava API error 429/,
    );
  });

  it("returns null only for a genuine 404", async () => {
    const { getActivityStreamsStrict } = await import("./strava");
    respondWith(404, JSON.stringify({ message: "Record Not Found" }));

    await expect(getActivityStreamsStrict(identity(22), 1002)).resolves.toBeNull();
  });

  it("caches nothing after a throw, so the next attempt is a real retry", async () => {
    const { getActivityStreamsStrict } = await import("./strava");
    respondWith(429, JSON.stringify({ message: "Rate Limit Exceeded" }));

    await expect(getActivityStreamsStrict(identity(23), 1003)).rejects.toThrow();
    const afterFirst = fetchCalls.length;

    await expect(getActivityStreamsStrict(identity(23), 1003)).rejects.toThrow();
    expect(fetchCalls.length).toBeGreaterThan(afterFirst);
  });

  it("still degrades to null through the render-path wrapper", async () => {
    const { getActivityStreams } = await import("./strava");
    respondWith(429, JSON.stringify({ message: "Rate Limit Exceeded" }));

    // The activity modal fetches this in a Promise.all with the detail; a throw
    // would turn a missing HR trace into a 500 on the whole modal.
    await expect(getActivityStreams(identity(24), 1004)).resolves.toBeNull();
  });
});
