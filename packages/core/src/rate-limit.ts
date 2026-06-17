import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export interface RateLimitResult {
  success: boolean;
  reset: number;
  limit: number;
  remaining: number;
}

export interface Limiter {
  limit(identifier: string): Promise<RateLimitResult>;
}

type Window = `${number} ${"s" | "m" | "h" | "d"}`;

function makeUpstashLimiter(prefix: string, tokens: number, window: Window): Limiter {
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  const redis = new Redis({ url, token });
  const rl = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(tokens, window),
    prefix,
    analytics: false,
  });
  return {
    async limit(id) {
      const r = await rl.limit(id);
      return {
        success: r.success,
        reset: r.reset,
        limit: r.limit,
        remaining: r.remaining,
      };
    },
  };
}

export function makeInMemoryLimiter(tokens: number, windowMs: number): Limiter {
  const buckets = new Map<string, number[]>();
  return {
    async limit(id) {
      const now = Date.now();
      const prev = buckets.get(id) ?? [];
      const live = prev.filter((t) => now - t < windowMs);
      if (live.length >= tokens) {
        return {
          success: false,
          reset: live[0] + windowMs,
          limit: tokens,
          remaining: 0,
        };
      }
      live.push(now);
      buckets.set(id, live);
      return {
        success: true,
        reset: now + windowMs,
        limit: tokens,
        remaining: tokens - live.length,
      };
    },
  };
}

function makeLimiter(
  prefix: string,
  tokens: number,
  windowMs: number,
  upstashWindow: Window,
): Limiter {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return makeUpstashLimiter(prefix, tokens, upstashWindow);
  }
  return makeInMemoryLimiter(tokens, windowMs);
}

let _chat: Limiter | null = null;
let _analyze: Limiter | null = null;
let _default: Limiter | null = null;
let _anon: Limiter | null = null;

export function chatLimiter(): Limiter {
  return (_chat ??= makeLimiter("rl:chat", 20, 60 * 60 * 1000, "1 h"));
}

export function analyzeLimiter(): Limiter {
  return (_analyze ??= makeLimiter("rl:analyze", 30, 60 * 60 * 1000, "1 h"));
}

export function defaultLimiter(): Limiter {
  return (_default ??= makeLimiter("rl:default", 300, 60 * 1000, "1 m"));
}

export function anonLimiter(): Limiter {
  return (_anon ??= makeLimiter("rl:anon", 10, 60 * 1000, "1 m"));
}
