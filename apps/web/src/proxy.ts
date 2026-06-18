import { getIronSession } from "iron-session";
import { NextRequest, NextResponse } from "next/server";
import { SessionData, sessionOptions } from "@/lib/session";
import { refreshStravaTokens, tokensNeedRefresh } from "@/lib/strava-auth";

// Server Components cannot write cookies, so token refresh must happen here,
// where setting cookies on the response is allowed.
export default async function proxy(request: NextRequest) {
  const response = NextResponse.next();
  const session = await getIronSession<SessionData>(request, response, sessionOptions);

  if (session.tokens && tokensNeedRefresh(session.tokens.expires_at)) {
    try {
      const refreshed = await refreshStravaTokens(session.tokens.refresh_token);
      session.tokens = { ...session.tokens, ...refreshed };
      await session.save();
    } catch (err) {
      console.error("Proxy token refresh failed:", err);
      // Leave the session as-is; downstream code will surface the auth error.
    }
  }

  return response;
}

export const config = {
  matcher: ["/dashboard/:path*", "/dashboard", "/api/:path*"],
};
