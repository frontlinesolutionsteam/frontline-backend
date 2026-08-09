import { cloverRequest } from "../client/httpClient";
import type { CloverOrder, CreateAtomicOrderRequest } from "../types/order";

// POST /v3/merchants/{mId}/atomic_order/orders
//
// This is the call that makes an order appear in the restaurant's normal
// order queue alongside dine-in tickets. It is "atomic" in that the cart, its
// line items and their modifications are created in one request -- as opposed
// to the older flow of creating an empty order and then POSTing each line item
// separately, which can leave half-built tickets on the POS if it fails
// partway.
//
// Pricing note: we never send prices for catalog items. Clover resolves the
// price and the tax rates from the merchant's own inventory, which is what
// keeps the printed ticket consistent with what the POS would have charged
// for the same order rung in by hand.
export async function createAtomicOrder(
  merchantId: string,
  cloverMerchantId: string,
  request: CreateAtomicOrderRequest,
): Promise<CloverOrder> {
  return cloverRequest<CloverOrder>(merchantId, cloverMerchantId, "/atomic_order/orders", {
    method: "POST",
    body: request,
  });
}

export interface CloverInventoryItem {
  id: string;
  name: string;
  price: number;
  priceType?: string;
  hidden?: boolean;
}

// Small read helper, used by the sandbox test script to pick a real item to
// order without needing our menu tables populated first.
export async function listInventoryItems(
  merchantId: string,
  cloverMerchantId: string,
  limit = 25,
): Promise<CloverInventoryItem[]> {
  const response = await cloverRequest<{ elements: CloverInventoryItem[] }>(
    merchantId,
    cloverMerchantId,
    "/items",
    { query: { limit } },
  );
  return response.elements ?? [];
}

export async function getOrder(
  merchantId: string,
  cloverMerchantId: string,
  cloverOrderId: string,
): Promise<CloverOrder> {
  return cloverRequest<CloverOrder>(merchantId, cloverMerchantId, `/orders/${cloverOrderId}`, {
    query: { expand: "lineItems" },
  });
}

// DELETE /v3/merchants/{mId}/orders/{orderId} -- best-effort cleanup used only
// when a pay-for-order call's outcome is genuinely unknown (a network/
// transport failure, not a clean decline response -- see submitPaidOrder.ts).
// Clover's own docs note an order cannot be deleted once it has a payment,
// credit, refund, or printed line items, so this only succeeds for an order
// that never actually got paid or printed -- exactly the case where we want
// it gone. Never assume this succeeds; callers must still log loudly and let
// a human confirm, since the whole reason we're here is that we don't know
// what actually happened on Clover's side.
export async function deleteOrder(
  merchantId: string,
  cloverMerchantId: string,
  cloverOrderId: string,
): Promise<void> {
  await cloverRequest<void>(merchantId, cloverMerchantId, `/orders/${cloverOrderId}`, {
    method: "DELETE",
  });
}
