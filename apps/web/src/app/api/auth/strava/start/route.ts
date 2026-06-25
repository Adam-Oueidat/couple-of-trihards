import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { anonLimiter, createLogger } from "@trihards/core";
import { clientIp, withLimit } from "@/lib/api";
import { encodeState, OAUTH_STATE_COOKIE } from "@/lib/oauth-state";
import { getStravaAuthUrl } from "@/lib/strava";

const log = createLogger("auth:start");

function expectedScheme(): string {
  return process.env.MOBILE_DEEP_LINK_SCHEME ?? "trihard";
}

function isAllowedRedirect(redirect: string): boolean {
  // Allow only our mobile deep-link scheme — never an arbitrary URL.
  return redirect.startsWith(`${expectedScheme()}://`);
}

export async function GET(request: NextRequest) {
  const limited = await withLimit(anonLimiter(), clientIp(request));
  if (limited) return limited;

  const url = new URL(request.url);
  const redirect = url.searchParams.get("redirect");

  // Web flow: no deep-link redirect. Mint a random nonce, stash it in an
  // httpOnly cookie, and embed it in the signed state so the callback can prove
  // the OAuth response belongs to this browser (CSRF defense).
  if (!redirect) {
    const nonce = randomBytes(32).toString("base64url");
    const state = encodeState({ kind: "web", nonce, ts: Date.now() });
    log.info("web oauth start");
    const res = NextResponse.redirect(getStravaAuthUrl(state));
    res.cookies.set(OAUTH_STATE_COOKIE, nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 600, // 10 minutes to complete the login round-trip
    });
    return res;
  }

  if (!isAllowedRedirect(redirect)) {
    log.warn("rejected mobile start", { redirect });
    return NextResponse.json({ error: "invalid redirect" }, { status: 400 });
  }

  log.info("mobile oauth start", { redirect });
  const state = encodeState({ kind: "mobile", redirect, ts: Date.now() });

  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID!,
    redirect_uri: process.env.STRAVA_REDIRECT_URI!,
    response_type: "code",
    approval_prompt: "auto",
    scope: "read,activity:read_all,profile:read_all",
    state,
  });

  return NextResponse.redirect(`https://www.strava.com/oauth/authorize?${params}`);
}
