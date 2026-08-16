import crypto from "node:crypto";

// Core platform webhooks (Inventory/Orders/Customers/etc.) are verified with
// a static shared-secret header compared against the "Clover Auth Code" shown
// in the app's Developer Dashboard settings. This is a *different* scheme
// from the HMAC Clover-Signature used on Ecommerce Hosted Checkout webhooks —
// don't conflate the two.
export function verifyCloverAuthHeader(headerValue: string | undefined): boolean {
  const secret = process.env.CLOVER_WEBHOOK_SECRET;
  if (!secret || !headerValue) return false;

  const expected = Buffer.from(secret);
  const actual = Buffer.from(headerValue);
  if (expected.length !== actual.length) return false;

  return crypto.timingSafeEqual(expected, actual);
}

// Hosted Checkout webhooks (pay-by-link) are secured per-merchant with a
// signing secret generated in that merchant's own Clover dashboard (Settings
// > Ecommerce > Hosted Checkout), NOT the app-wide CLOVER_WEBHOOK_SECRET
// above. Header shape: "Clover-Signature: t=<unix seconds>,v1=<hex hmac>",
// where the signed message is `${timestamp}.${rawBody}` (HMAC-SHA256).
// Requires the exact raw request bytes -- a re-serialized JSON.stringify of
// the parsed body is not guaranteed to byte-match what Clover actually sent
// and signed, so the caller must pass the untouched raw buffer (see
// index.ts's express.json({ verify }) capture).
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;

export function verifyHostedCheckoutSignature(
  headerValue: string | undefined,
  rawBody: Buffer | undefined,
  secret: string | undefined,
): boolean {
  if (!headerValue || !rawBody || !secret) return false;

  const parts = Object.fromEntries(
    headerValue.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k?.trim(), v?.trim()];
    }),
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;

  // Reject stale/replayed signatures rather than trusting the timestamp
  // blindly -- Clover's docs don't specify a tolerance window, so this uses
  // the same order of magnitude as other providers' HMAC webhook schemes.
  const skewSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (skewSeconds > MAX_CLOCK_SKEW_SECONDS) return false;

  const expectedHex = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody.toString("utf8")}`)
    .digest("hex");

  const expected = Buffer.from(expectedHex);
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return false;

  return crypto.timingSafeEqual(expected, actual);
}
