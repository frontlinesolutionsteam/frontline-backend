import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const cloverConfig = {
  appId: required("CLOVER_APP_ID"),
  appSecret: required("CLOVER_APP_SECRET"),
  apiHost: required("CLOVER_API_HOST"),
  authorizeHost: required("CLOVER_AUTHORIZE_HOST"),
  redirectUri: required("CLOVER_REDIRECT_URI"),
  sandboxMerchantId: process.env.CLOVER_SANDBOX_MERCHANT_ID,
};
