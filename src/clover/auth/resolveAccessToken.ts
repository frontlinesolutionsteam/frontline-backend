import { pilotCredentials } from "../config";
import { loadApiToken } from "./apiTokenStore";
import { getValidToken } from "./getValidToken";

export type TokenSource = "pilot_env" | "merchant_api_token" | "oauth";

export interface ResolvedToken {
  accessToken: string;
  source: TokenSource;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Single place that decides how a given merchant authenticates to Clover.
//
// Order matters:
//   1. pilot env override  -- bootstrap, lets the sandbox script run with no DB
//   2. merchant API token  -- the pilot path: a token the restaurant generated
//                             in their own Clover Dashboard, stored encrypted
//   3. OAuth               -- the existing app-install path, unchanged
//
// Merchant-generated tokens do not expire and have no refresh token, so
// there is nothing to rotate -- that is the whole reason they are simpler.
export async function resolveAccessToken(
  merchantId: string,
  cloverMerchantId?: string,
): Promise<ResolvedToken> {
  if (
    pilotCredentials.apiToken &&
    pilotCredentials.cloverMerchantId &&
    (cloverMerchantId === pilotCredentials.cloverMerchantId ||
      merchantId === pilotCredentials.cloverMerchantId)
  ) {
    return { accessToken: pilotCredentials.apiToken, source: "pilot_env" };
  }

  // Everything below reads the DB, which keys merchants by our own uuid. A
  // non-uuid here means a caller passed a Clover merchant id without a
  // matching pilot env override -- fail with something readable rather than
  // a Postgres cast error.
  if (!UUID_RE.test(merchantId)) {
    throw new Error(
      `No Clover credentials for "${merchantId}". Either set CLOVER_PILOT_MERCHANT_ID / ` +
        `CLOVER_PILOT_API_TOKEN for this merchant, or pass our internal merchant uuid.`,
    );
  }

  const stored = await loadApiToken(merchantId);
  if (stored) {
    return { accessToken: stored.apiToken, source: "merchant_api_token" };
  }

  return { accessToken: await getValidToken(merchantId), source: "oauth" };
}
