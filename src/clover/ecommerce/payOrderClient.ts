import { ecommerceConfig } from "./config";
import { ChargeDeclinedError } from "./chargeClient";

export interface PayOrderInput {
  /** The Platform atomic order id (e.g. "KCHY84YWH6GCP") -- confirmed empirically that this endpoint accepts it directly, not a separate Ecommerce-order id. */
  cloverOrderId: string;
  amountCents: number;
  /** Single-use `clv_...` token from the client-side iframe. */
  source: string;
}

export interface PayOrderResult {
  /** The Ecommerce charge id -- same purpose as chargeClient.ts's charge.id, used for refunds. */
  chargeId: string;
  amountPaid: number;
  status: string;
}

interface PayOrderErrorBody {
  error?: {
    type?: string;
    code?: string;
    decline_code?: string;
    message?: string;
  };
}

// POST /v1/orders/{orderId}/pay -- attaches a payment DIRECTLY to an existing
// Platform atomic order, instead of standalone POST /v1/charges (which
// creates its own disconnected Ecommerce-side order object). This is the fix
// for a real bug found by checking the actual Clover sandbox dashboard: a
// standalone charge does not make the order show as paid in the Orders list,
// and does not appear in Sales Overview reporting, because the charge and
// the kitchen-ticket order were never the same object as far as Clover's own
// system of record is concerned.
//
// metadata.delete_order_on_failure is documented to have Clover delete the
// order itself on a decline -- sent here since it's harmless, but NOT relied
// upon: tested empirically (a clean decline against a fresh sandbox order)
// and the order was not deleted, matching other developers' reports of the
// same flag being unreliable. submitPaidOrder.ts always does its own
// explicit DELETE on any payment failure rather than trusting this.
//
// amountCents is passed explicitly (the order's own confirmed total from
// createAtomicOrder's response) rather than relying on this endpoint's
// undocumented-to-us default-to-order-total behavior when amount is omitted
// -- a number we already know for certain beats one we're assuming.
export async function payOrder(input: PayOrderInput): Promise<PayOrderResult> {
  const response = await fetch(`https://${ecommerceConfig.chargeHost}/v1/orders/${input.cloverOrderId}/pay`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ecommerceConfig.privateToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: input.source,
      amount: input.amountCents,
      metadata: { delete_order_on_failure: true },
    }),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok && (body as PayOrderErrorBody).error) {
    const err = (body as PayOrderErrorBody).error!;
    throw new ChargeDeclinedError(err.message ?? "Card declined", err.decline_code, err.code);
  }
  if (!response.ok) {
    throw new Error(`Clover pay-for-order failed: ${response.status} ${JSON.stringify(body)}`);
  }

  const result = body as { charge?: string; amount_paid?: number; status?: string };
  if (!result.charge) {
    throw new Error(`Clover pay-for-order succeeded but returned no charge id: ${JSON.stringify(body)}`);
  }

  return {
    chargeId: result.charge,
    amountPaid: result.amount_paid ?? input.amountCents,
    status: result.status ?? "unknown",
  };
}
