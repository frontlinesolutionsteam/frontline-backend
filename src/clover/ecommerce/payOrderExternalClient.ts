import { cloverRequest } from "../client/httpClient";

export interface PayOrderExternalInput {
  merchantId: string; // our uuid
  cloverMerchantId: string;
  cloverOrderId: string;
  amountCents: number;
  externalPaymentTenderId: string;
}

export interface PayOrderExternalResult {
  paymentId: string;
  amount: number;
  result: string;
}

interface CreatePaymentResponseBody {
  id?: string;
  amount?: number;
  result?: string;
}

// POST /v3/merchants/{mId}/orders/{orderId}/payments with the merchant's
// com.clover.tender.external_payment tender -- records a payment that was
// actually collected elsewhere (here: a completed Hosted Checkout session)
// against a real Platform atomic order, the same order-first-then-attach
// shape payOrderClient.ts uses for card payments.
//
// Verified empirically against the sandbox before this was trusted: the
// order's own paymentState flips to "PAID" and the payment appears under
// that order's payments.elements, and Clover refuses to delete a paid order
// (400 "Can not delete order with an associated payment") -- confirming the
// attachment is real and enforced by Clover itself, not a loose side effect
// like the standalone POST /v1/charges approach turned out to be (see
// submitPaidOrder.ts's history comment).
export async function payOrderExternal(input: PayOrderExternalInput): Promise<PayOrderExternalResult> {
  const body = await cloverRequest<CreatePaymentResponseBody>(
    input.merchantId,
    input.cloverMerchantId,
    `/orders/${input.cloverOrderId}/payments`,
    {
      method: "POST",
      body: {
        tender: { id: input.externalPaymentTenderId },
        amount: input.amountCents,
      },
    },
  );

  if (!body.id) {
    throw new Error(`Clover external payment attach succeeded but returned no payment id: ${JSON.stringify(body)}`);
  }

  return {
    paymentId: body.id,
    amount: body.amount ?? input.amountCents,
    result: body.result ?? "unknown",
  };
}

interface Tender {
  id: string;
  labelKey?: string;
}

// Tender ids are per-merchant (confirmed against the sandbox: not a fixed
// platform-wide constant), so this must be looked up rather than hardcoded.
// Cheap and stable enough to call fresh each time rather than caching --
// this only runs once per completed Hosted Checkout order, not per request.
export async function findExternalPaymentTenderId(
  merchantId: string,
  cloverMerchantId: string,
): Promise<string> {
  const response = await cloverRequest<{ elements: Tender[] }>(merchantId, cloverMerchantId, "/tenders");
  const tender = response.elements.find((t) => t.labelKey === "com.clover.tender.external_payment");
  if (!tender) {
    throw new Error(`Merchant ${cloverMerchantId} has no com.clover.tender.external_payment tender configured`);
  }
  return tender.id;
}
