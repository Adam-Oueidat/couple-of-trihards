import { NextResponse } from "next/server";
import { createLogger, type Limiter } from "@trihards/core";
import type { NextRequest } from "next/server";

const log = createLogger("ratelimit");

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
