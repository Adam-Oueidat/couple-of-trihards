import { createHmac, timingSafeEqual } from "node:crypto";

// Browser-bound CSRF nonce for the web OAuth flow: set as an httpOnly cookie at
// /api/auth/strava/start and compared against the signed state in the callback.
export const OAUTH_STATE_COOKIE = "trihard_oauth_state";

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

export function encodeState(data: object): string {
  const body = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${body}.${sign(body)}`;
}

// Verifies the signature and, when maxAgeMs is given, rejects a state whose
// embedded `ts` is missing or older than the window — bounding how long a
// captured state URL can be replayed.
export function decodeState<T>(signed: string | null, maxAgeMs?: number): T | null {
  if (!signed) return null;
  const [body, sig] = signed.split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  if (
    expected.length !== sig.length ||
    !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"))
  ) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & {
      ts?: number;
    };
    if (maxAgeMs !== undefined) {
      if (typeof data.ts !== "number" || Date.now() - data.ts > maxAgeMs) return null;
    }
    return data as T;
  } catch {
    return null;
  }
}
