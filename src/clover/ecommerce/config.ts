import "dotenv/config";

// Clover's Ecommerce API (charges, refunds) is a SEPARATE product from the
// Platform API (atomic orders, inventory, tokenStore.ts/config.ts) -- its own
// host, its own credential pair (a public key for client-side tokenization, a
// private token for server-side charges/refunds), and its own object graph
// that does not share ids with Platform atomic orders. See
// submitPaidOrder.ts for how we reconcile the two ourselves.
export const ecommerceConfig = {
  chargeHost: process.env.CLOVER_ECOMMERCE_API_HOST ?? "scl-sandbox.dev.clover.com",

  get privateToken(): string {
    const value = process.env.CLOVER_PILOT_ECOMMERCE_PRIVATE_TOKEN;
    if (!value) {
      throw new Error("Missing required env var: CLOVER_PILOT_ECOMMERCE_PRIVATE_TOKEN");
    }
    return value;
  },
};
