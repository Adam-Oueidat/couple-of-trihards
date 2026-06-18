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

export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}
