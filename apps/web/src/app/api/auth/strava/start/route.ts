import { NextRequest, NextResponse } from "next/server";
import { anonLimiter, createLogger } from "@trihards/core";
import { clientIp, withLimit } from "@/lib/api";
import { encodeState } from "@/lib/oauth-state";

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
  if (!redirect || !isAllowedRedirect(redirect)) {
    log.warn("rejected mobile start", { redirect: redirect ?? "(missing)" });
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
