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
