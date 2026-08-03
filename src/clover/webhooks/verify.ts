import crypto from "node:crypto";

// Core platform webhooks (Inventory/Orders/Customers/etc.) are verified with
// a static shared-secret header compared against the "Clover Auth Code" shown
// in the app's Developer Dashboard settings. This is a *different* scheme
// from the HMAC Clover-Signature used on Ecommerce Hosted Checkout webhooks —
// don't conflate the two if that flow gets added later.
export function verifyCloverAuthHeader(headerValue: string | undefined): boolean {
  const secret = process.env.CLOVER_WEBHOOK_SECRET;
  if (!secret || !headerValue) return false;

  const expected = Buffer.from(secret);
  const actual = Buffer.from(headerValue);
  if (expected.length !== actual.length) return false;

  return crypto.timingSafeEqual(expected, actual);
}
