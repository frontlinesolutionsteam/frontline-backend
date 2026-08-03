import { cloverConfig } from "../config";
import type { CloverTokenResponse, TokenPair } from "../types";

export function buildAuthorizeUrl(state: string): string {
  const url = new URL("/oauth/v2/authorize", `https://${cloverConfig.authorizeHost}`);
  url.searchParams.set("client_id", cloverConfig.appId);
  url.searchParams.set("redirect_uri", cloverConfig.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

function toTokenPair(body: CloverTokenResponse): TokenPair {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    // Clover OAuth timestamps are unix seconds, unlike the rest of the API (ms).
    accessTokenExpiresAt: new Date(body.access_token_expiration * 1000),
    refreshTokenExpiresAt: new Date(body.refresh_token_expiration * 1000),
  };
}

async function postOAuth(pathname: string, body: Record<string, string>): Promise<TokenPair> {
  const url = new URL(pathname, `https://${cloverConfig.apiHost}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Clover OAuth ${pathname} failed: ${res.status} ${text}`);
  }

  return toTokenPair((await res.json()) as CloverTokenResponse);
}

export function exchangeCodeForToken(code: string): Promise<TokenPair> {
  return postOAuth("/oauth/v2/token", {
    client_id: cloverConfig.appId,
    client_secret: cloverConfig.appSecret,
    code,
  });
}

export function refreshAccessToken(refreshToken: string): Promise<TokenPair> {
  return postOAuth("/oauth/v2/refresh", {
    client_id: cloverConfig.appId,
    refresh_token: refreshToken,
  });
}
