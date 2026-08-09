import { cloverRequest } from "../../clover/client/httpClient";
import type { CloverLineItemInput, CloverOrder } from "../../clover/types/order";
import { getOrCreateCustomer, type CustomerInput } from "../../customers/repository";
import { readAvailability } from "../../menu-sync/cache/availabilityCache";
import { logger } from "../../shared/logging/logger";
import { triggerPrint } from "../printing/triggerPrint";
import {
  findOrderByIdempotencyKey,
  getCatalogItems,
  getCatalogModifiers,
  insertDraftOrder,
  markOrderConfirmed,
  markOrderFailed,
  markOrderPrinted,
  type CartLineItem,
} from "./repository";

export interface CheckoutLineItemInput {
  itemId: string; // our uuid
  quantity: number;
  note?: string;
  modifierIds?: string[]; // our uuid
}

export interface SubmitOrderInput {
  merchantId: string; // our uuid
  cloverMerchantId: string;
  items: CheckoutLineItemInput[];
  customer: CustomerInput;
  source: "website" | "ai_phone";
  requestedTime?: string;
  note?: string;
  // GAP-4: caller-supplied, stable across retries of the SAME checkout
  // attempt (a network retry, a doubled click, a crashed process resuming).
  // A fresh checkout must use a fresh key.
  idempotencyKey: string;
}

export interface SubmitOrderResult {
  orderId: string;
  cloverOrderId: string;
  status: string;
  totalCents: number;
  printTriggered: boolean;
}

// Every website checkout and AI phone order goes through this single call.
// Pricing is always computed server-side from our own catalog -- a client
// can send item/modifier ids but never a price. Availability is re-checked
// against the live Redis cache (not just the menu snapshot the customer
// loaded earlier), since a busy shift can 86 an item mid-order.
export async function submitOrder(input: SubmitOrderInput): Promise<SubmitOrderResult> {
  if (input.items.length === 0) {
    throw new Error("Cart is empty");
  }
  if (!input.idempotencyKey) {
    throw new Error("idempotencyKey is required");
  }

  // GAP-4: if this exact checkout attempt already reached Clover, short-
  // circuit before any catalog lookup or Clover call. This is the only thing
  // standing between a client retry and a duplicate kitchen ticket -- Clover's
  // atomic order endpoint does not dedupe (confirmed empirically: two POSTs
  // with the same orderCart.id produced two distinct Clover orders).
  //
  // If a prior attempt for this key exists but never reached Clover (crash,
  // or a Clover call that failed outright), cloverOrderId is null here and we
  // fall through to the normal path; insertDraftOrder below will reuse that
  // same draft row instead of creating a second one.
  const existing = await findOrderByIdempotencyKey(input.merchantId, input.idempotencyKey);
  if (existing?.cloverOrderId) {
    logger.info("Duplicate checkout suppressed by idempotency key", {
      orderId: existing.id,
      cloverOrderId: existing.cloverOrderId,
    });
    return {
      orderId: existing.id,
      cloverOrderId: existing.cloverOrderId,
      status: existing.status,
      totalCents: existing.totalCents,
      printTriggered: existing.status === "printed",
    };
  }

  const itemIds = input.items.map((i) => i.itemId);
  const catalogItems = await getCatalogItems(input.merchantId, itemIds);
  const catalogById = new Map(catalogItems.map((c) => [c.id, c]));

  for (const cartItem of input.items) {
    const catalog = catalogById.get(cartItem.itemId);
    if (!catalog) throw new Error(`Unknown item ${cartItem.itemId}`);
    if (catalog.hidden) throw new Error(`${catalog.name} is not on the menu`);

    const live = await readAvailability(input.merchantId, catalog.cloverItemId);
    const isAvailable = live ? live.available && !live.hidden : catalog.available;
    if (!isAvailable) throw new Error(`${catalog.name} is currently unavailable`);
  }

  const allModifierIds = [...new Set(input.items.flatMap((i) => i.modifierIds ?? []))];
  const modifierById = new Map((await getCatalogModifiers(allModifierIds)).map((m) => [m.id, m]));

  const cartLineItems: CartLineItem[] = input.items.map((cartItem) => {
    const catalog = catalogById.get(cartItem.itemId)!;
    const modifiers = (cartItem.modifierIds ?? []).map((modifierId) => {
      const modifier = modifierById.get(modifierId);
      if (!modifier) throw new Error(`Unknown modifier ${modifierId}`);
      return modifier;
    });
    return {
      itemId: catalog.id,
      cloverItemId: catalog.cloverItemId,
      name: catalog.name,
      priceCents: catalog.priceCents,
      quantity: cartItem.quantity,
      note: cartItem.note,
      modifiers,
    };
  });

  const customer = await getOrCreateCustomer(input.merchantId, input.cloverMerchantId, input.customer);

  const { orderId } = await insertDraftOrder(
    {
      merchantId: input.merchantId,
      customerId: customer.id,
      source: input.source,
      requestedTime: input.requestedTime ?? null,
      note: input.note ?? null,
      idempotencyKey: input.idempotencyKey,
    },
    cartLineItems,
  );

  // Clover has no structured "scheduled pickup time" field on an order --
  // it has to be encoded as text on the ticket, per the architecture doc.
  const orderNoteParts = [input.requestedTime ? `Pickup: ${input.requestedTime}` : null, input.note].filter(
    (part): part is string => Boolean(part),
  );

  const cloverLineItems: CloverLineItemInput[] = cartLineItems.map((li) => ({
    item: { id: li.cloverItemId },
    unitQty: li.quantity,
    note: li.note,
    modifications: li.modifiers.length
      ? li.modifiers.map((m) => ({ modifier: { id: m.cloverModifierId }, name: m.name, amount: m.priceCents }))
      : undefined,
  }));

  let cloverOrder: CloverOrder;
  try {
    cloverOrder = await cloverRequest<CloverOrder>(
      input.merchantId,
      input.cloverMerchantId,
      "/atomic_order/orders",
      {
        method: "POST",
        body: {
          orderCart: {
            state: "open",
            lineItems: cloverLineItems,
            note: orderNoteParts.length ? orderNoteParts.join(" | ") : undefined,
          },
        },
      },
    );
  } catch (err) {
    await markOrderFailed(orderId);
    throw err;
  }

  await markOrderConfirmed(orderId, cloverOrder.id);

  const printResult = await triggerPrint(input.merchantId, input.cloverMerchantId, cloverOrder.id);
  if (printResult.success) {
    await markOrderPrinted(orderId);
  } else {
    logger.warn("Order confirmed in Clover but print did not confirm", {
      orderId,
      cloverOrderId: cloverOrder.id,
      reason: printResult.reason,
    });
  }

  return {
    orderId,
    cloverOrderId: cloverOrder.id,
    status: printResult.success ? "printed" : "confirmed_clover",
    totalCents: cloverOrder.total,
    printTriggered: printResult.success,
  };
}
