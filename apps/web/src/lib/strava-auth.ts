// Token refresh kept free of next/headers imports so it can be called from any
// runtime — the token store (lib/strava-tokens.ts) is its only caller today.

export interface RefreshedTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

const TOKEN_REFRESH_MARGIN_SECONDS = 300;

export function tokensNeedRefresh(expiresAt: number): boolean {
  return (
    expiresAt - Math.floor(Date.now() / 1000) < TOKEN_REFRESH_MARGIN_SECONDS
  );
}

export async function refreshStravaTokens(
  refreshToken: string,
): Promise<RefreshedTokens> {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
  };
}
