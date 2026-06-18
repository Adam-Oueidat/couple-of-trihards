import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@trihards/core";
import { getDb, licenses, users } from "@trihards/db";
import { exchangeCodeForTokens, invalidateAthleteCache } from "@/lib/strava";
import { getSession } from "@/lib/session";
import { resolveSession } from "@/lib/auth";
import { mintMobileToken } from "@/lib/mobile-tokens";
import { decodeState } from "@/lib/oauth-state";

const log = createLogger("auth:callback");

interface MobileState {
  kind: "mobile";
  redirect: string;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const state = decodeState<MobileState>(searchParams.get("state"));

  if (error || !code) {
    log.warn("oauth denied or missing code", { error, kind: state?.kind ?? "web" });
    if (state?.kind === "mobile") {
      const url = new URL(state.redirect);
      url.searchParams.set("error", "access_denied");
      return NextResponse.redirect(url.toString());
    }
    return NextResponse.redirect(new URL("/?error=access_denied", request.url));
  }

  try {
    const tokens = await exchangeCodeForTokens(code);

    if (state?.kind === "mobile") {
      // Mobile flow: create-or-find user, mint bearer token, deep-link back.
      const db = getDb();
      const [existing] = await db
        .select()
        .from(users)
        .where(eq(users.stravaAthleteId, tokens.athlete_id));
      let userId: string;
      if (existing) {
        userId = existing.id;
      } else {
        const displayName =
          [tokens.athlete_firstname, tokens.athlete_lastname]
            .filter(Boolean)
            .join(" ") || null;
        const [created] = await db
          .insert(users)
          .values({ stravaAthleteId: tokens.athlete_id, displayName })
          .returning({ id: users.id });
        userId = created.id;
      }

      const token = await mintMobileToken(userId);

      const [activeLicense] = await db
        .select({ id: licenses.id })
        .from(licenses)
        .where(eq(licenses.boundUserId, userId));

      log.info("mobile sign-in", {
        userId,
        athleteId: tokens.athlete_id,
        needsLicense: !activeLicense,
      });

      const url = new URL(state.redirect);
      url.searchParams.set("token", token);
      url.searchParams.set("needs_license", activeLicense ? "false" : "true");
      return NextResponse.redirect(url.toString());
    }

    // Web flow: set the iron-session cookie.
    const session = await getSession();
    session.tokens = tokens;
    await session.save();

    // A fresh login should always show live data. Dashboard fetches are cached
    // persistently (sync only on login or the "Sync" button), so invalidate this
    // athlete's entries to guarantee the first post-login render refetches —
    // this also refreshes a returning user whose cache survived a prior session.
    invalidateAthleteCache(tokens.athlete_id);

    const resolved = await resolveSession();
    const destination = resolved?.license ? "/dashboard" : "/activate";
    log.info("web sign-in", {
      athleteId: tokens.athlete_id,
      userId: resolved?.userId,
      destination,
    });
    return NextResponse.redirect(new URL(destination, request.url));
  } catch (err) {
    log.error("oauth callback failed", err);
    if (state?.kind === "mobile") {
      const url = new URL(state.redirect);
      url.searchParams.set("error", "auth_failed");
      return NextResponse.redirect(url.toString());
    }
    return NextResponse.redirect(new URL("/?error=auth_failed", request.url));
  }
}
