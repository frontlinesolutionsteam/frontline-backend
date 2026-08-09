import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// OAuth-only settings are lazy getters rather than eager `required()` calls: a
// pilot merchant connected with a merchant-generated API token needs no Clover
// app at all, so the backend must boot without APP_ID/APP_SECRET set. Anything
// that actually touches the OAuth flow still fails loudly on first access.
export const cloverConfig = {
  apiHost: required("CLOVER_API_HOST"),
  sandboxMerchantId: process.env.CLOVER_SANDBOX_MERCHANT_ID,

  get appId(): string {
    return required("CLOVER_APP_ID");
  },
  get appSecret(): string {
    return required("CLOVER_APP_SECRET");
  },
  get authorizeHost(): string {
    return required("CLOVER_AUTHORIZE_HOST");
  },
  get redirectUri(): string {
    return required("CLOVER_REDIRECT_URI");
  },
};

// Single-merchant bootstrap path for the pilot: lets the sandbox test script
// run before any merchant row exists. Real per-client credentials live
// encrypted in `clover_api_tokens` (see auth/apiTokenStore.ts) -- this is a
// bootstrap escape hatch, not the storage mechanism.
export const pilotCredentials = {
  cloverMerchantId: process.env.CLOVER_PILOT_MERCHANT_ID,
  apiToken: process.env.CLOVER_PILOT_API_TOKEN,
  orderTypeId: process.env.CLOVER_PILOT_ORDER_TYPE_ID,
};
