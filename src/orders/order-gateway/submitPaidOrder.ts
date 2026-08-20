import { getOrderTypeId } from "../../clover/auth/apiTokenStore";
import { ChargeDeclinedError } from "../../clover/ecommerce/chargeClient";
import { payOrder } from "../../clover/ecommerce/payOrderClient";
import { createAtomicOrder, deleteOrder } from "../../clover/orders/createAtomicOrder";
import type { CloverOrder } from "../../clover/types/order";
import { getOrCreateCustomer, type CustomerInput } from "../../customers/repository";
import { logger } from "../../shared/logging/logger";
import { triggerPrint } from "../printing/triggerPrint";
import { mapCartToCloverOrder } from "./mapCartToCloverOrder";
import {
  claimOrderForCharging,
  findOrderByIdempotencyKey,
  insertDraftOrder,
  markChargeDeclined,
  markOrderConfirmedAndPaid,
  markOrderCreatedAwaitingPayment,
  markOrderPrinted,
} from "./repository";
import { resolveCartLines, type CheckoutLineItemInput } from "./resolveCartLines";

export interface SubmitPaidOrderInput {
  merchantId: string; // our uuid
  cloverMerchantId: string;
  items: CheckoutLineItemInput[];
  customer: CustomerInput;
  source: "website" | "kiosk";
  requestedTime?: string;
  note?: string;
  idempotencyKey: string;
  /** Single-use `clv_...` token from the storefront's/kiosk's Clover iframe (clover.createToken()). Never a raw card number. */
  sourceToken: string;
}

export interface SubmitPaidOrderResult {
  orderId: string;
  cloverOrderId: string;
  cloverChargeId: string;
  status: string;
  totalCents: number;
  printTriggered: boolean;
}

export class PaymentDeclinedError extends Error {
  constructor(
    message: string,
    public readonly declineCode: string | undefined,
  ) {
    super(message);
    this.name = "PaymentDeclinedError";
  }
}

// Covers three cases the router should treat the same way (409, try again
// shortly / with a new attempt): a charge already failed for this key, a
// charge is actively in flight for it, or we can't tell which.
export class PaymentAlreadyAttemptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentAlreadyAttemptedError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Order-first, pay-second checkout for website orders with online payment.
//
// REVISION HISTORY: this was originally charge-first (charge via standalone
// POST /v1/charges, create the Platform atomic order only after success).
// That version worked -- a real sandbox payment printed a real, correctly-
// totaled kitchen ticket -- but checking the actual Clover merchant dashboard
// afterward showed the order as "Open" (not paid) and Sales Overview reported
// no payments for the day. Standalone /v1/charges creates its own
// Ecommerce-side order object as a side effect; it is NOT the same object as
// the Platform atomic order, so nothing about that charge ever reconciled
// with the order Clover shows to staff or counts in its own reporting.
//
// The fix, confirmed against Clover's own docs and empirically against the
// sandbox: POST /v1/orders/{orderId}/pay attaches a payment DIRECTLY to an
// existing Platform atomic order (confirmed by passing our own atomic order
// id in that path and getting a validation error about the payment source,
// not the order reference). That requires the order to exist BEFORE payment
// is attempted, which is the opposite sequencing from before.
//
// This reopens the ghost-order risk order-first was originally chosen to
// avoid. Clover's pay-for-order endpoint has a
// `metadata.delete_order_on_failure: true` flag documented to have Clover
// itself delete the order on a decline -- but tested that empirically (a
// clean decline against a fresh order) and the order was NOT deleted,
// matching other developers' reports of the same flag being unreliable. We
// therefore never rely on it: the catch block below always attempts an
// explicit DELETE ourselves, for both a clean decline and an ambiguous
// (non-decline) failure, and logs loudly if that delete itself fails --
// confirmed separately that DELETE does work on a fresh unpaid/unprinted
// order (GET 404s afterward) when we call it directly.
//
// Idempotency (GAP-4) still holds, restructured around order-first:
//   1. insertDraftOrder's ON CONFLICT lock (migration 003) -- only one
//      concurrent INSERT for the same key wins.
//   2. claimOrderForCharging's atomic 'draft' -> 'charging' transition
//      (migration 005) -- closes the race where two requests see the same
//      existing row and would otherwise both proceed.
//   3. markOrderCreatedAwaitingPayment persists the Clover order id
//      immediately after creation, BEFORE payment is attempted, so a crash
//      between "order created" and "payment attempted" resumes by paying the
//      SAME order rather than creating a second one.
//   4. A charge that already failed for a key is terminal: tokens are
//      single-use anyway, so a genuine retry has a fresh token and should use
//      a fresh key.
// ─────────────────────────────────────────────────────────────────────────────
export async function submitPaidOrder(input: SubmitPaidOrderInput): Promise<SubmitPaidOrderResult> {
  if (input.items.length === 0) throw new Error("Cart is empty");
  if (!input.idempotencyKey) throw new Error("idempotencyKey is required");
  if (!input.sourceToken) throw new Error("sourceToken is required");

  const existing = await findOrderByIdempotencyKey(input.merchantId, input.idempotencyKey);

  if (existing?.status === "confirmed_clover" || existing?.status === "printed") {
    if (!existing.cloverOrderId || !existing.cloverChargeId) {
      throw new Error(`Order ${existing.id} is ${existing.status} but missing Clover ids -- data integrity bug`);
    }
    logger.info("Duplicate paid checkout suppressed by idempotency key", {
      orderId: existing.id,
      cloverOrderId: existing.cloverOrderId,
    });
    return {
      orderId: existing.id,
      cloverOrderId: existing.cloverOrderId,
      cloverChargeId: existing.cloverChargeId,
      status: existing.status,
      totalCents: existing.totalCents,
      printTriggered: existing.status === "printed",
    };
  }

  if (existing?.status === "failed") {
    // Deliberately does NOT echo existing.declineReason here: that field can
    // hold our own internal error text, not just Clover's customer-safe
    // decline message, and this is a retry path a customer can reach --
    // found the hard way when an internal diagnostic string leaked into this
    // exact message during testing. The real decline reason was already
    // shown to the customer once, on the original attempt that set this row
    // to 'failed'.
    throw new PaymentAlreadyAttemptedError(
      "This checkout already failed. Please re-enter your card and try again.",
    );
  }

  const { cartLineItems, internalOrderLines } = await resolveCartLines(
    input.merchantId,
    input.cloverMerchantId,
    input.items,
    { checkAvailability: true },
  );

  const customer = await getOrCreateCustomer(input.merchantId, input.cloverMerchantId, input.customer);

  let orderId: string;
  let cloverOrderId: string;
  let amountToChargeCents: number;

  if (existing?.status === "charging" && existing.cloverOrderId) {
    // Resuming after a crash between "order created" and "payment attempted".
    // The order's total was already recorded by markOrderCreatedAwaitingPayment
    // when it was first created -- reuse it rather than recomputing, since
    // that recorded value is what Clover itself confirmed as the order total.
    orderId = existing.id;
    cloverOrderId = existing.cloverOrderId;
    amountToChargeCents = existing.totalCents;
  } else if (existing?.status === "charging") {
    // Another request already claimed this order and hasn't created the
    // Clover order yet -- could be a genuinely concurrent double-click, or a
    // crash before that call ever reached Clover. Either way, proceeding here
    // risks a second Clover order for the same checkout, so we refuse rather
    // than guess.
    throw new PaymentAlreadyAttemptedError(
      "Payment is already being processed for this order. Please wait a moment and check your order status before trying again.",
    );
  } else {
    const inserted = await insertDraftOrder(
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
    orderId = inserted.orderId;

    if (!inserted.isNew) {
      // The SELECT above and this INSERT aren't atomic together -- lost a
      // race we didn't detect earlier. Re-check what the winner did.
      const raceWinner = await findOrderByIdempotencyKey(input.merchantId, input.idempotencyKey);
      if (
        (raceWinner?.status === "confirmed_clover" || raceWinner?.status === "printed") &&
        raceWinner.cloverOrderId &&
        raceWinner.cloverChargeId
      ) {
        return {
          orderId: raceWinner.id,
          cloverOrderId: raceWinner.cloverOrderId,
          cloverChargeId: raceWinner.cloverChargeId,
          status: raceWinner.status,
          totalCents: raceWinner.totalCents,
          printTriggered: raceWinner.status === "printed",
        };
      }
      throw new PaymentAlreadyAttemptedError(
        "Payment is already being processed for this order. Please wait a moment and check your order status before trying again.",
      );
    }

    const claimed = await claimOrderForCharging(orderId);
    if (!claimed) {
      // Vanishingly unlikely immediately after our own insert, but fail safe
      // rather than proceed blind if it somehow happens.
      throw new PaymentAlreadyAttemptedError(
        "Payment is already being processed for this order. Please wait a moment and check your order status before trying again.",
      );
    }

    // Everything Clover-shaped happens in the mapping layer, which also
    // reports where our cart format falls short of Clover's order model. Tax
    // rates were already fetched by resolveCartLines above. No "paid"
    // indicator is stamped on the note here -- the order does not exist as
    // paid yet, and once payment succeeds Clover's own order state reflects
    // it correctly (that's the whole point of this endpoint over the
    // standalone-charge approach), so there's no text hack needed.
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
      // No payment was ever attempted -- a clean failure, nothing to reverse.
      await markChargeDeclined(orderId, `Order creation failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    const actualTaxCents = cloverOrder.total - mapped.expectedSubtotalCents;
    if (cloverOrder.total !== mapped.expectedTotalCents) {
      logger.error("Clover's order total did not match our expected total -- see computeExpectedTax.ts for known gaps", {
        orderId,
        cloverOrderId: cloverOrder.id,
        expectedTotalCents: mapped.expectedTotalCents,
        cloverTotalCents: cloverOrder.total,
      });
    }

    await markOrderCreatedAwaitingPayment(orderId, cloverOrder.id, cloverOrder.total, actualTaxCents);
    cloverOrderId = cloverOrder.id;
    amountToChargeCents = cloverOrder.total;
  }

  try {
    const payResult = await payOrder({
      cloverOrderId,
      amountCents: amountToChargeCents,
      source: input.sourceToken,
    });

    await markOrderConfirmedAndPaid(orderId, payResult.chargeId);

    const printResult = await triggerPrint(input.merchantId, input.cloverMerchantId, cloverOrderId);
    if (printResult.success) {
      await markOrderPrinted(orderId);
    } else {
      logger.warn("Paid order confirmed in Clover but print did not confirm", {
        orderId,
        cloverOrderId,
        reason: printResult.reason,
      });
    }

    return {
      orderId,
      cloverOrderId,
      cloverChargeId: payResult.chargeId,
      status: printResult.success ? "printed" : "confirmed_clover",
      totalCents: amountToChargeCents,
      printTriggered: printResult.success,
    };
  } catch (err) {
    const isDecline = err instanceof ChargeDeclinedError;

    // Never rely on metadata.delete_order_on_failure alone -- found
    // empirically that it does NOT reliably delete the order (tested a clean
    // decline against a fresh order in the sandbox; the order was still
    // there afterward), matching reports of the same behavior in Clover's
    // developer community. We always attempt our own explicit delete here,
    // for BOTH a clean decline and an ambiguous failure, rather than trusting
    // Clover's flag to have handled it.
    //
    // A failed delete is informative either way: for a clean decline it means
    // a real ghost order was just left in the queue on an everyday decline
    // (not a rare edge case -- worth its own alert). For an ambiguous
    // failure, a delete rejected because "the order already has a payment"
    // is actual evidence the charge went through despite the error we saw --
    // exactly the kind of thing a human needs to check, not something safe
    // to resolve automatically in either direction.
    try {
      await deleteOrder(input.merchantId, input.cloverMerchantId, cloverOrderId);
    } catch (deleteErr) {
      logger.error(
        "CRITICAL: could not delete order after a " +
          (isDecline ? "decline" : "failed payment attempt") +
          " -- if this failed because the order already has a payment, the charge likely DID succeed. MANUAL REVIEW REQUIRED.",
        {
          orderId,
          cloverOrderId,
          deleteError: deleteErr instanceof Error ? deleteErr.message : String(deleteErr),
        },
      );
    }

    if (isDecline) {
      await markChargeDeclined(orderId, err.message);
      throw new PaymentDeclinedError(err.message, err.declineCode);
    }

    logger.error("CRITICAL: pay-for-order call failed with an ambiguous (non-decline) error -- outcome unknown", {
      orderId,
      cloverOrderId,
      merchantId: input.merchantId,
      error: err instanceof Error ? err.message : String(err),
    });
    await markChargeDeclined(orderId, `Payment attempt failed: ${err instanceof Error ? err.message : String(err)}`);
    throw new Error(
      "Something went wrong while processing your payment. Our team has been alerted -- " +
        "please contact the restaurant directly rather than resubmitting.",
    );
  }
}
