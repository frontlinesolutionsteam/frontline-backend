import { getOrderTypeId } from "../../clover/auth/apiTokenStore";
import { createAtomicOrder } from "../../clover/orders/createAtomicOrder";
import type { CloverOrder } from "../../clover/types/order";
import { getOrCreateCustomer, type CustomerInput } from "../../customers/repository";
import { mapCartToCloverOrder } from "./mapCartToCloverOrder";
import { logger } from "../../shared/logging/logger";
import { triggerPrint } from "../printing/triggerPrint";
import {
  findOrderByIdempotencyKey,
  insertDraftOrder,
  markOrderConfirmed,
  markOrderFailed,
  markOrderPrinted,
} from "./repository";
import { resolveCartLines, type CheckoutLineItemInput } from "./resolveCartLines";

export type { CheckoutLineItemInput };

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
  // A fresh checkout must use a fresh key. See mapCartToCloverOrder.ts GAP-4.
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

  const { cartLineItems, internalOrderLines } = await resolveCartLines(
    input.merchantId,
    input.cloverMerchantId,
    input.items,
    { checkAvailability: true },
  );

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

  // Everything Clover-shaped happens in the mapping layer, which also reports
  // where our cart format falls short of Clover's order model. Tax rates were
  // already fetched by resolveCartLines above.
  const mapped = mapCartToCloverOrder({
    lines: internalOrderLines,
    source: input.source,
    note: input.note,
    requestedTime: input.requestedTime,
    cloverCustomerId: customer.cloverCustomerId ?? undefined,
    cloverOrderTypeId: (await getOrderTypeId(input.merchantId)) ?? undefined,
  });

  if (mapped.warnings.length) {
    logger.warn("Cart mapped to Clover order with gaps", { orderId, warnings: mapped.warnings });
  }

  let cloverOrder: CloverOrder;
  try {
    cloverOrder = await createAtomicOrder(input.merchantId, input.cloverMerchantId, mapped.request);
  } catch (err) {
    await markOrderFailed(orderId);
    throw err;
  }

  // GAP-3: cloverOrder.total is the ground truth for what the customer will
  // actually be charged; mapped.expectedTotalCents is our replica of Clover's
  // tax computation, kept only as a monitoring cross-check (see
  // computeExpectedTax.ts for the rounding rules this reproduces and the two
  // sub-cases -- exact-.5-cent ties, taxed modifiers -- that remain
  // unverified). A mismatch here means one of those unverified cases has
  // actually occurred, or a line's tax rates could not be resolved; it is
  // logged loudly rather than silently trusted either way. Clover's own
  // response has no separate tax field, so the tax actually charged is
  // derived the same way here: total minus our (tax-independent) subtotal.
  const actualTaxCents = cloverOrder.total - mapped.expectedSubtotalCents;
  if (cloverOrder.total !== mapped.expectedTotalCents) {
    logger.error("Our expected tax total did not match Clover's -- see computeExpectedTax.ts for known gaps", {
      orderId,
      cloverOrderId: cloverOrder.id,
      expectedSubtotalCents: mapped.expectedSubtotalCents,
      expectedTaxCents: mapped.expectedTaxCents,
      expectedTotalCents: mapped.expectedTotalCents,
      cloverTotalCents: cloverOrder.total,
      actualTaxCents,
    });
  }

  await markOrderConfirmed(orderId, cloverOrder.id, cloverOrder.total, actualTaxCents);

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
