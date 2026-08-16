import { getOrderTypeId } from "../../clover/auth/apiTokenStore";
import { getMerchantById } from "../../clover/auth/tokenStore";
import { createHostedCheckoutSession } from "../../clover/ecommerce/hostedCheckoutClient";
import { findExternalPaymentTenderId, payOrderExternal } from "../../clover/ecommerce/payOrderExternalClient";
import { createAtomicOrder } from "../../clover/orders/createAtomicOrder";
import type { CloverOrder } from "../../clover/types/order";
import { getOrCreateCustomer, type CustomerInput } from "../../customers/repository";
import { alertOps, sendCustomerSms } from "../../shared/alerts/opsAlerts";
import { logger } from "../../shared/logging/logger";
import { triggerPrint } from "../printing/triggerPrint";
import { mapCartToCloverOrder } from "./mapCartToCloverOrder";
import {
  attachHostedCheckoutSession,
  claimPendingHostedCheckoutOrder,
  findExpiredAwaitingPaymentOrders,
  findOrderByIdempotencyKey,
  findPendingOrderByCheckoutSessionId,
  markHostedCheckoutOrderCreated,
  markHostedCheckoutOrderPaid,
  markOrderCanceled,
  markOrderFailed,
  markOrderPrinted,
} from "./repository";
import { resolveCartLines, type CheckoutLineItemInput } from "./resolveCartLines";

// Native Hosted Checkout session lifetime is a fixed 15 minutes (confirmed
// against Clover's docs, not configurable via the create-session request).
// 17 = 15 + a 2-minute buffer, so a customer who pays right at the wire
// isn't cut off by our own timeout racing Clover's.
const TIMEOUT_MINUTES = 17;

export class HostedCheckoutInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedCheckoutInProgressError";
  }
}

export interface InitiateHostedCheckoutOrderInput {
  merchantId: string;
  cloverMerchantId: string;
  items: CheckoutLineItemInput[];
  customer: CustomerInput;
  requestedTime?: string;
  note?: string;
  idempotencyKey: string;
  source: "ai_phone" | "website";
}

export interface InitiateHostedCheckoutOrderResult {
  orderId: string;
  checkoutUrl: string;
  totalCents: number;
}

// Step 1 of the pay-by-link flow: NOT a Clover order yet, just a Hosted
// Checkout session (ad-hoc name/price/qty line items, no relationship to a
// Platform order) plus our own bookkeeping row. The real atomic order isn't
// created until payment is confirmed -- see completeHostedCheckoutOrder.
export async function initiateHostedCheckoutOrder(
  input: InitiateHostedCheckoutOrderInput,
): Promise<InitiateHostedCheckoutOrderResult> {
  if (input.items.length === 0) throw new Error("Cart is empty");
  if (!input.idempotencyKey) throw new Error("idempotencyKey is required");

  const existing = await findOrderByIdempotencyKey(input.merchantId, input.idempotencyKey);
  if (existing) {
    if (existing.hostedCheckoutUrl) {
      logger.info("Duplicate Hosted Checkout initiation suppressed by idempotency key", { orderId: existing.id });
      return { orderId: existing.id, checkoutUrl: existing.hostedCheckoutUrl, totalCents: existing.totalCents };
    }
    // A claim exists but the session isn't attached yet -- either a genuinely
    // concurrent request currently creating it, or a crash between claim and
    // attach. Either way, proceeding here risks a second Hosted Checkout
    // session (a second real, textable payment link) for the same order.
    throw new HostedCheckoutInProgressError(
      "A checkout link is already being created for this order. Please wait a moment and try again.",
    );
  }

  // Resolved fresh (current catalog/availability/pricing/tax) before we ever
  // talk to Clover -- same principle every other checkout path in this file
  // uses. checkAvailability:true so we never text a link for something
  // that's already 86'd.
  const { internalOrderLines } = await resolveCartLines(input.merchantId, input.cloverMerchantId, input.items, {
    checkAvailability: true,
  });
  const customer = await getOrCreateCustomer(input.merchantId, input.cloverMerchantId, input.customer);

  const mapped = mapCartToCloverOrder({
    lines: internalOrderLines,
    source: input.source,
    note: input.note,
    requestedTime: input.requestedTime,
  });

  const claimed = await claimPendingHostedCheckoutOrder({
    merchantId: input.merchantId,
    customerId: customer.id,
    source: input.source,
    requestedTime: input.requestedTime ?? null,
    note: input.note ?? null,
    idempotencyKey: input.idempotencyKey,
    subtotalCents: mapped.expectedSubtotalCents,
    totalCents: mapped.expectedTotalCents,
    pendingCart: input.items,
  });

  if (!claimed.isNew) {
    // Lost a race we didn't detect above (the SELECT and this INSERT aren't
    // atomic together). Re-check what the winner did rather than proceed
    // blind -- same pattern submitPaidOrder.ts uses for the equivalent gap.
    const raceWinner = await findOrderByIdempotencyKey(input.merchantId, input.idempotencyKey);
    if (raceWinner?.hostedCheckoutUrl) {
      return { orderId: raceWinner.id, checkoutUrl: raceWinner.hostedCheckoutUrl, totalCents: raceWinner.totalCents };
    }
    throw new HostedCheckoutInProgressError(
      "A checkout link is already being created for this order. Please wait a moment and try again.",
    );
  }

  // Hosted Checkout's line items are ad-hoc display strings with no tax
  // engine behind them -- confirmed live against the sandbox that a session
  // built from bare item prices charges only the pre-tax subtotal. Add tax
  // as its own line so the amount actually collected matches
  // expectedTotalCents (what the real atomic order will total), not just
  // the subtotal -- otherwise the external-payment-tender attach at
  // completion would be recording more as "paid" than the customer
  // actually paid.
  const hostedCheckoutLineItems = internalOrderLines.map((line) => ({
    name: line.name,
    price: line.priceCents,
    unitQty: line.quantity,
    note: line.note,
  }));
  if (mapped.expectedTaxCents > 0) {
    // "Tax (estimated)" rather than plain "Tax" -- Hosted Checkout renders
    // its own separate, always-zero "Tax" line for ad-hoc items (it has no
    // real tax engine behind this line-item shape), and the two side by
    // side reading as duplicate/contradictory "Tax" rows was confusing on
    // the actual checkout page when tested live.
    hostedCheckoutLineItems.push({
      name: "Tax (estimated)",
      price: mapped.expectedTaxCents,
      unitQty: 1,
      note: undefined,
    });
  }

  const session = await createHostedCheckoutSession({
    merchantId: input.merchantId,
    cloverMerchantId: input.cloverMerchantId,
    lineItems: hostedCheckoutLineItems,
  });

  const expiresAt = new Date(Date.now() + TIMEOUT_MINUTES * 60 * 1000);
  await attachHostedCheckoutSession(claimed.orderId, session.checkoutSessionId, session.href, expiresAt);

  logger.info("Hosted Checkout session created", {
    orderId: claimed.orderId,
    checkoutSessionId: session.checkoutSessionId,
    totalCents: mapped.expectedTotalCents,
  });

  return { orderId: claimed.orderId, checkoutUrl: session.href, totalCents: mapped.expectedTotalCents };
}

// Step 2: called once Clover confirms (webhook) that a Hosted Checkout
// session was paid. Creates the REAL atomic order fresh from current
// catalog/pricing (not the ad-hoc Hosted Checkout line items, and not a
// stale snapshot from initiation time), then attaches the already-collected
// payment to it via the external-payment-tender path -- verified against the
// sandbox before this was trusted (see payOrderExternalClient.ts).
export async function completeHostedCheckoutOrder(hostedCheckoutSessionId: string): Promise<void> {
  const pending = await findPendingOrderByCheckoutSessionId(hostedCheckoutSessionId);
  if (!pending) {
    logger.error("Payment webhook for unknown Hosted Checkout session", { hostedCheckoutSessionId });
    return;
  }
  if (pending.status !== "awaiting_payment") {
    // Already completed (a duplicate webhook delivery) or already canceled
    // by the timeout job racing this same webhook -- either way, idempotent
    // no-op rather than risk creating a second Clover order.
    logger.info("Hosted Checkout payment webhook for order not in awaiting_payment, skipping", {
      orderId: pending.id,
      status: pending.status,
    });
    return;
  }

  const merchant = await getMerchantById(pending.merchantId);
  if (!merchant) {
    logger.error("Hosted Checkout payment confirmed but merchant record is gone", { orderId: pending.id });
    return;
  }

  try {
    const { internalOrderLines } = await resolveCartLines(
      pending.merchantId,
      merchant.cloverMerchantId,
      pending.pendingCart,
      { checkAvailability: true },
    );

    const mapped = mapCartToCloverOrder({
      lines: internalOrderLines,
      source: "ai_phone",
      note: pending.note ?? undefined,
      requestedTime: pending.requestedTime ?? undefined,
      cloverOrderTypeId: (await getOrderTypeId(pending.merchantId)) ?? undefined,
    });

    const cloverOrder: CloverOrder = await createAtomicOrder(
      pending.merchantId,
      merchant.cloverMerchantId,
      mapped.request,
    );
    const taxCents = cloverOrder.total - mapped.expectedSubtotalCents;
    await markHostedCheckoutOrderCreated(pending.id, cloverOrder.id, cloverOrder.total, taxCents);

    // Attach the amount actually collected via Hosted Checkout
    // (pending.totalCents, fixed at initiation time), NOT cloverOrder.total
    // -- they can legitimately differ if pricing changed between initiation
    // and payment, and recording a fresher/different figure as "paid" would
    // misstate what the customer really paid. Flag any mismatch loudly
    // rather than silently reconciling it either direction.
    if (cloverOrder.total !== pending.totalCents) {
      logger.error("Hosted Checkout order total does not match amount actually collected", {
        orderId: pending.id,
        collectedCents: pending.totalCents,
        freshCloverTotalCents: cloverOrder.total,
      });
      await alertOps(
        "Pay-by-link total mismatch",
        `Customer paid $${(pending.totalCents / 100).toFixed(2)} via Hosted Checkout, but the order now totals ` +
          `$${(cloverOrder.total / 100).toFixed(2)} (pricing likely changed in between). Attaching the ` +
          `originally-collected amount; MANUAL REVIEW recommended. orderId=${pending.id} cloverOrderId=${cloverOrder.id}`,
      );
    }

    const externalTenderId = await findExternalPaymentTenderId(pending.merchantId, merchant.cloverMerchantId);
    const payment = await payOrderExternal({
      merchantId: pending.merchantId,
      cloverMerchantId: merchant.cloverMerchantId,
      cloverOrderId: cloverOrder.id,
      amountCents: pending.totalCents,
      externalPaymentTenderId: externalTenderId,
    });
    await markHostedCheckoutOrderPaid(pending.id, payment.paymentId);

    const printResult = await triggerPrint(pending.merchantId, merchant.cloverMerchantId, cloverOrder.id);
    if (printResult.success) {
      await markOrderPrinted(pending.id);
    } else {
      logger.warn("Hosted Checkout order confirmed and paid but print did not confirm", {
        orderId: pending.id,
        cloverOrderId: cloverOrder.id,
        reason: printResult.reason,
      });
    }

    logger.info("Hosted Checkout order completed", { orderId: pending.id, cloverOrderId: cloverOrder.id });
  } catch (err) {
    // The customer already paid (Clover confirmed it -- that's why this
    // function is running at all) but we failed to create/attach the real
    // order. Never silent: this is money collected with no kitchen ticket,
    // exactly the failure mode the whole external-payment-tender
    // verification exercise was trying to avoid ending up in anyway.
    await markOrderFailed(pending.id);
    logger.error("CRITICAL: Hosted Checkout payment confirmed but order completion failed -- MANUAL REVIEW REQUIRED", {
      orderId: pending.id,
      hostedCheckoutSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    await alertOps(
      "Paid order failed to complete",
      `Customer PAID via Hosted Checkout but we failed to create/attach the Clover order. ` +
        `MANUAL REVIEW REQUIRED -- check Clover dashboard for session ${hostedCheckoutSessionId}. ` +
        `orderId=${pending.id} phone=${pending.customerPhoneE164} amount=$${(pending.totalCents / 100).toFixed(2)} ` +
        `error=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Timeout backstop -- not a recovery mechanism. Clover's Hosted Checkout has
// no session-status polling endpoint (confirmed against Clover's own docs
// before assuming otherwise), so unlike inventory sync there is no second
// channel to double-check against; the webhook is the only real-time signal.
// This just bounds how long an order can sit unconfirmed. Call on a
// recurring interval (see worker.ts).
export async function cancelExpiredHostedCheckoutOrders(): Promise<void> {
  const expired = await findExpiredAwaitingPaymentOrders();
  for (const order of expired) {
    await markOrderCanceled(order.id, "Payment link expired without a completed payment");

    const restaurant = order.businessName ?? "the restaurant";
    // Proposed and approved alongside the timeout window: tells the customer
    // plainly what happened, and gives a human recovery path for the rare
    // case where they actually did pay and our webhook was simply missed
    // (there's no polling channel to catch that automatically -- see the
    // module comment above cancelExpiredHostedCheckoutOrders).
    await sendCustomerSms(
      order.customerPhoneE164,
      `Sorry, your order at ${restaurant} was cancelled because payment wasn't completed in time. ` +
        `If you already paid, please call the restaurant -- nothing was charged twice, we just want to make sure your order gets made.`,
    );

    logger.info("Hosted Checkout order auto-canceled after timeout", { orderId: order.id });

    await alertOps(
      "Pay-by-link order auto-cancelled (timeout)",
      `Order timed out waiting for payment and was auto-cancelled. If the customer actually paid, ` +
        `this needs a human to check Clover's dashboard directly and reconcile manually -- our webhook ` +
        `may have been missed (no polling channel exists for Hosted Checkout to double-check against). ` +
        `checkoutSessionId=${order.hostedCheckoutSessionId} cloverMerchantId=${order.cloverMerchantId} ` +
        `restaurant=${restaurant} phone=${order.customerPhoneE164} amount=$${(order.totalCents / 100).toFixed(2)} ` +
        `orderCreatedAt=${order.createdAt}`,
    );
  }
}
