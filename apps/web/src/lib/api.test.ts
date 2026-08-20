import { afterEach, describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { appOrigin } from "./api";

// appOrigin only reads `headers` and `url`, so a hand-rolled stand-in is enough
// and keeps the test free of a full NextRequest (which needs a running server).
function req(
  headers: Record<string, string>,
  url = "http://0.0.0.0:3000/api/auth/callback?code=abc",
): NextRequest {
  return { headers: new Headers(headers), url } as unknown as NextRequest;
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("appOrigin", () => {
  it("prefers APP_URL and strips trailing slashes", () => {
    process.env.APP_URL = "https://trilog.example.com/";
    expect(appOrigin(req({ host: "attacker.example" }))).toBe(
      "https://trilog.example.com",
    );
  });

  it("never returns the bind address baked into request.url", () => {
    delete process.env.APP_URL;
    expect(appOrigin(req({ host: "trilog.example.com" }))).not.toContain("0.0.0.0");
  });

  it("falls back to the forwarded host and protocol", () => {
    delete process.env.APP_URL;
    const origin = appOrigin(
      req({ "x-forwarded-host": "trilog.example.com", "x-forwarded-proto": "https" }),
    );
    expect(origin).toBe("https://trilog.example.com");
  });

  it("takes the rightmost forwarded entry, not the attacker-prepended one", () => {
    delete process.env.APP_URL;
    process.env.TRUSTED_PROXY_HOPS = "1";
    const origin = appOrigin(
      req({
        "x-forwarded-host": "evil.example, trilog.example.com",
        "x-forwarded-proto": "http, https",
      }),
    );
    expect(origin).toBe("https://trilog.example.com");
  });

  it("rejects a forwarded host that tries to smuggle a different target", () => {
    delete process.env.APP_URL;
    for (const host of [
      "evil.example/path",
      "trilog.example.com@evil.example",
      "evil.example\\@x",
      "https://evil.example",
      "evil example",
    ]) {
      // Bad hosts fall back to request.url's origin rather than being trusted.
      expect(appOrigin(req({ "x-forwarded-host": host }))).toBe("http://0.0.0.0:3000");
    }
  });

  it("accepts a host:port and a bracketed IPv6 literal", () => {
    delete process.env.APP_URL;
    expect(appOrigin(req({ "x-forwarded-host": "localhost:3000" }))).toBe(
      "http://localhost:3000",
    );
    expect(appOrigin(req({ "x-forwarded-host": "[::1]:3000" }))).toBe(
      "http://[::1]:3000",
    );
  });

  it("ignores a bogus forwarded protocol", () => {
    delete process.env.APP_URL;
    const origin = appOrigin(
      req({ "x-forwarded-host": "trilog.example.com", "x-forwarded-proto": "javascript" }),
    );
    expect(origin).toBe("http://trilog.example.com");
  });
});
