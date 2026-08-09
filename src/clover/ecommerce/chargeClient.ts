// This module originally wrapped standalone POST /v1/charges. That call
// creates its own disconnected Ecommerce-side order object as a side effect,
// which does not reconcile with the Platform atomic order (the kitchen
// ticket) in Clover's own Orders list or Sales Overview reporting -- found by
// checking the actual sandbox dashboard after a real payment. Payment
// collection now goes through payOrderClient.ts's POST
// /v1/orders/{orderId}/pay instead, which attaches the payment directly to
// an existing Platform atomic order. Only the shared decline-error type
// remains here, since both call sites throw it identically.
export class ChargeDeclinedError extends Error {
  constructor(
    message: string,
    public readonly declineCode: string | undefined,
    public readonly code: string | undefined,
  ) {
    super(message);
    this.name = "ChargeDeclinedError";
  }
}
