import { refreshAccessToken } from "./oauth";
import { loadTokenPair, saveTokenPair } from "./tokenStore";

// Access tokens live 30 minutes; refresh proactively with 5 minutes of
// headroom rather than waiting for a 401, per the architecture doc.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Refresh tokens are single-use and rotate on every refresh call. If two
// callers (e.g. a webhook handler and a cron job) refresh concurrently for
// the same merchant, one wins and the other's token goes stale. This map
// dedupes concurrent refreshes per merchant onto a single in-flight promise.
const refreshInFlight = new Map<string, Promise<string>>();

export async function getValidToken(merchantId: string): Promise<string> {
  const tokens = await loadTokenPair(merchantId);
  if (!tokens) {
    throw new Error(`No stored Clover tokens for merchant ${merchantId}`);
  }

  const needsRefresh =
    tokens.accessTokenExpiresAt.getTime() - Date.now() < REFRESH_BUFFER_MS;

  if (!needsRefresh) {
    return tokens.accessToken;
  }

  const existing = refreshInFlight.get(merchantId);
  if (existing) {
    return existing;
  }

  const refreshPromise = (async () => {
    try {
      const fresh = await refreshAccessToken(tokens.refreshToken);
      await saveTokenPair(merchantId, fresh);
      return fresh.accessToken;
    } finally {
      refreshInFlight.delete(merchantId);
    }
  })();

  refreshInFlight.set(merchantId, refreshPromise);
  return refreshPromise;
}
