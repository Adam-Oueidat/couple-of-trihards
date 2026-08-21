import { NextResponse } from "next/server";
import { createLogger, type Limiter } from "@trihards/core";
import type { NextRequest } from "next/server";

const log = createLogger("ratelimit");
const originLog = createLogger("origin");

export async function withLimit(
  limiter: Limiter,
  identifier: string,
): Promise<NextResponse | null> {
  const result = await limiter.limit(identifier);
  if (result.success) {
    log.debug("allowed", { id: identifier, remaining: result.remaining });
    return null;
  }
  const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  log.warn("rate limit hit", { id: identifier, retryAfter });
  return NextResponse.json(
    { error: "rate_limited", reset: result.reset },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

// Number of trusted reverse proxies in front of the app (the platform edge is
// one hop; default 1). The genuine client-facing address is the Nth entry from
// the RIGHT of X-Forwarded-For — the value our trusted proxy appended. Entries
// further left are attacker-supplied and must not be trusted for rate limiting.
function trustedProxyHops(): number {
  const n = Number(process.env.TRUSTED_PROXY_HOPS ?? "1");
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const idx = parts.length - trustedProxyHops();
    if (idx >= 0 && parts[idx]) return parts[idx];
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

// Next builds `request.url` from the address the server is BOUND to, not from
// the Host header: the standalone server passes $HOSTNAME through to
// startServer(), and the router turns that into the request's absolute URL
// (next/dist/server/lib/router-utils/resolve-routes.js — `initUrl`). In a
// container bound to 0.0.0.0 that makes `request.url` read
// `http://0.0.0.0:3000/...`, so every `new URL(path, request.url)` redirect
// sends the browser to the bind address. (Next only reads the Host header
// instead when experimental.trustHostHeader is on, which it enables
// automatically on Vercel — which is why the upstream docs teach the
// `new URL(path, request.url)` idiom without this caveat.)
//
// Resolve the browser-facing origin explicitly instead.
export function appOrigin(req: NextRequest): string {
  const configured = process.env.APP_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;

  // No APP_URL: fall back to what the edge forwarded. Note that this is only
  // as trustworthy as the proxy in front of us — an ALB passes the client's
  // Host header through verbatim, and Next itself backfills x-forwarded-host
  // from it (base-server.js: `req.headers['x-forwarded-host'] ??=
  // req.headers['host'] ?? this.hostname`). So a client can choose this value.
  // Fine for local dev; production must set APP_URL.
  const host = trustedForwarded(req, "x-forwarded-host") ?? req.headers.get("host")?.trim();
  if (!host || !isPlausibleHost(host)) {
    warnUnresolvedOrigin(host);
    return new URL(req.url).origin;
  }
  const forwardedProto = trustedForwarded(req, "x-forwarded-proto");
  const proto =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : process.env.NODE_ENV === "production"
        ? "https"
        : "http";
  return `${proto}://${host}`;
}

// The Nth value from the RIGHT of a comma-joined X-Forwarded-* header — the
// entry our own trusted proxy contributed. Same trust boundary as clientIp
// above: a client can send its own X-Forwarded-* and proxies append to it, so
// entries further LEFT are attacker-supplied. When there are fewer entries
// than configured hops, every entry came from a trusted proxy and the first
// one is safe.
function trustedForwarded(req: NextRequest, header: string): string | null {
  const raw = req.headers.get(header);
  if (!raw) return null;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return parts[Math.max(0, parts.length - trustedProxyHops())];
}

// A forwarded host is an authority (`host` or `host:port`) and nothing else.
// Reject anything that could smuggle a different target into
// `new URL(path, origin)` — userinfo ("@"), a path, a scheme, a backslash, or
// whitespace/control characters — so a hostile header can at worst name a
// hostname, never rewrite the whole URL.
const HOST_PATTERN =
  /^(?:[a-zA-Z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

function isPlausibleHost(host: string): boolean {
  return host.length <= 255 && HOST_PATTERN.test(host);
}

let warnedUnresolvedOrigin = false;
function warnUnresolvedOrigin(host: string | undefined): void {
  if (warnedUnresolvedOrigin) return;
  warnedUnresolvedOrigin = true;
  originLog.warn(
    "could not resolve a public origin; redirects will use the server's bind address. Set APP_URL.",
    { host: host ?? null },
  );
}
