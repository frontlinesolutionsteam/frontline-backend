import type { CloverLineItemInput, CreateAtomicOrderRequest } from "../../clover/types/order";
import { computeExpectedTax, type TaxRateRef } from "./computeExpectedTax";

// ─────────────────────────────────────────────────────────────────────────────
// Internal order format → Clover atomic order payload.
//
// This is the only place that knows Clover's request shape. It is a pure
// function on purpose: the sandbox test script, the website checkout and the
// AI caller all produce the same InternalOrder and share this mapping, and it
// can be asserted on without a network or a database.
// ─────────────────────────────────────────────────────────────────────────────

export interface InternalOrderModifier {
  cloverModifierId: string;
  name: string;
  priceCents: number;
}

// Mirrors the storefront cart (src/cart/CartContext.tsx `CartLine`) after our
// catalog has resolved each of our uuids to its Clover id.
export interface InternalOrderLine {
  cloverItemId: string;
  name: string;
  priceCents: number;
  quantity: number;
  note?: string;
  modifiers: InternalOrderModifier[];
  // The item's effective Clover tax rate(s), fetched by the caller (see
  // fetchItemTaxRates.ts) BEFORE calling this function -- this file stays a
  // pure, network-free function on purpose. `undefined` means "not fetched /
  // unknown" (tax cannot be computed for this line, see the warning below);
  // `[]` means "fetched, and Clover confirmed this item is untaxed."
  taxRates?: TaxRateRef[];
}

export interface InternalOrder {
  lines: InternalOrderLine[];
  source: "website" | "ai_phone" | "kiosk";
  /** Free-text customer note ("no cilantro, ring bell"). */
  note?: string;
  /** Requested pickup time as the customer phrased it. See GAP-1. */
  requestedTime?: string;
  /** Clover customer id, once we have matched or created one. */
  cloverCustomerId?: string;
  /** Per-merchant order type id, e.g. the merchant's "Online Order". */
  cloverOrderTypeId?: string;
}

// A single order producing more than this many Clover line items almost
// certainly means a bad quantity got through validation upstream. Clover will
// happily accept it and print a 400-line ticket.
const MAX_LINE_ITEMS = 200;

export class CartMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartMappingError";
  }
}

export interface MappedOrder {
  request: CreateAtomicOrderRequest;
  /** Sum of item + modifier prices, pre-tax. Our number, not Clover's. */
  expectedSubtotalCents: number;
  /** Our replica of Clover's own tax computation -- see computeExpectedTax.ts. */
  expectedTaxCents: number;
  /** expectedSubtotalCents + expectedTaxCents. Compare directly against cloverOrder.total. */
  expectedTotalCents: number;
  /** Non-fatal gaps between our cart format and what Clover models. */
  warnings: string[];
}

export function mapCartToCloverOrder(order: InternalOrder): MappedOrder {
  if (order.lines.length === 0) {
    throw new CartMappingError("Cannot submit an empty cart");
  }

  const warnings: string[] = [];
  const lineItems: CloverLineItemInput[] = [];
  let expectedSubtotalCents = 0;

  for (const line of order.lines) {
    if (!line.cloverItemId) {
      throw new CartMappingError(`Line "${line.name}" has no Clover item id`);
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new CartMappingError(`Line "${line.name}" has invalid quantity ${line.quantity}`);
    }

    const modifications = line.modifiers.map((modifier) => {
      if (!modifier.cloverModifierId) {
        throw new CartMappingError(
          `Modifier "${modifier.name}" on "${line.name}" has no Clover modifier id`,
        );
      }
      return {
        modifier: { id: modifier.cloverModifierId },
        // Clover stores a name/amount snapshot on the modification so the
        // ticket still reads correctly if the modifier is renamed or repriced
        // later. It does not use these to compute the total.
        name: modifier.name,
        amount: modifier.priceCents,
      };
    });

    // Quantity is expressed by repeating the line item, not by `unitQty`.
    // `unitQty` is Clover's per-weight/per-measure field and is read in
    // thousandths (1000 = one unit), so sending `unitQty: 3` for three tacos
    // asks for 0.003 of an item rather than three of them. Repeating the entry
    // is unambiguous and is how the POS itself represents a quantity-3 line.
    for (let i = 0; i < line.quantity; i++) {
      lineItems.push({
        item: { id: line.cloverItemId },
        note: line.note,
        modifications: modifications.length ? modifications : undefined,
      });
    }

    expectedSubtotalCents +=
      (line.priceCents + line.modifiers.reduce((sum, m) => sum + m.priceCents, 0)) * line.quantity;
  }

  if (lineItems.length > MAX_LINE_ITEMS) {
    throw new CartMappingError(
      `Order expands to ${lineItems.length} Clover line items (limit ${MAX_LINE_ITEMS}); check quantities`,
    );
  }

  // GAP-1: Clover has no structured scheduled-time field on an order, so a
  // requested pickup time can only ride along as ticket text. Nothing on the
  // POS will sort, alert or fire on it.
  const noteParts: string[] = [];
  if (order.requestedTime) noteParts.push(`Pickup: ${order.requestedTime}`);
  if (order.note) noteParts.push(order.note);
  if (order.source === "ai_phone") noteParts.push("Placed by AI phone order");
  if (order.source === "kiosk") noteParts.push("Placed via kiosk");

  const note = noteParts.length ? noteParts.join(" | ") : undefined;
  if (note && note.length > 255) {
    warnings.push(
      `Order note is ${note.length} chars; Clover truncates long notes on the printed ticket.`,
    );
  }

  if (!order.cloverOrderTypeId) {
    // GAP-2: without an order type the ticket inherits the merchant's default,
    // which on most restaurant setups reads as a dine-in ticket.
    warnings.push(
      "No Clover order type id configured for this merchant -- the ticket will use the merchant's " +
        "default order type instead of an online/pickup one.",
    );
  }

  if (!order.cloverCustomerId) {
    warnings.push("No Clover customer attached -- the ticket will not show the customer's name or phone.");
  }

  const linesMissingTaxRates = order.lines.filter((l) => l.taxRates === undefined).length;
  if (linesMissingTaxRates > 0) {
    warnings.push(
      `Tax rates were not fetched for ${linesMissingTaxRates} line(s) -- expectedTotalCents excludes tax ` +
        "for those lines and will not match Clover's total. Fetch each item's tax rates before mapping " +
        "(see fetchItemTaxRates.ts) unless the merchant is genuinely untaxed.",
    );
  }

  const { taxCents: expectedTaxCents } = computeExpectedTax(order.lines);

  return {
    request: {
      orderCart: {
        state: "open",
        lineItems,
        note,
        customer: order.cloverCustomerId ? { id: order.cloverCustomerId } : undefined,
        orderType: order.cloverOrderTypeId ? { id: order.cloverOrderTypeId } : undefined,
      },
    },
    expectedSubtotalCents,
    expectedTaxCents,
    expectedTotalCents: expectedSubtotalCents + expectedTaxCents,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Known gaps between our cart format and Clover's order model.
//
// Kept here as code rather than prose so it stays next to the mapping it
// describes. None of these block the pilot; all of them matter before real
// money moves.
//
// GAP-1  Scheduled time.  Clover models no pickup/ready time on an order. We
//        encode it in the ticket note (above). Anything time-aware has to live
//        on our side.
//
// GAP-2  Order type.  Per-merchant id, now stored on `merchants`. Unset means
//        online orders look like dine-in on the POS.
//
// GAP-3  Tax.  RESOLVED for computation: submitOrder.ts fetches each line's
//        effective tax rate(s) from Clover (fetchItemTaxRates.ts) and this
//        file replicates Clover's own rounding (computeExpectedTax.ts) so
//        expectedTotalCents matches cloverOrder.total exactly -- verified
//        against the sandbox for single-rate, repeated-line, and mixed-rate
//        orders (see computeExpectedTax.ts for the empirical cases). NOT
//        resolved: the storefront's pre-checkout cart total is still a
//        pre-tax estimate (CartContext.tsx has no tax field), so the number a
//        customer sees before submitting can still differ from what Clover
//        charges -- acceptable while payment is taken in person post-pilot,
//        not once online payment exists. Also unverified: exact-.5-cent
//        rounding ties, and whether modifiers are taxed at all (see the
//        warnings at the top of computeExpectedTax.ts).
//
// GAP-4  Idempotency.  RESOLVED: checkout now requires a client-supplied
//        idempotencyKey (storefront generates one per cart session), stored
//        as a unique (merchant_id, idempotency_key) constraint on `orders`.
//        submitOrder.ts checks for an existing row with that key before
//        calling Clover, and returns the prior result on a retry instead of
//        creating a second ticket -- confirmed empirically that Clover's
//        atomic order endpoint has no idempotency of its own to lean on.
//
// GAP-5  Modifier group rules.  Our menu API exposes minRequired/maxAllowed on
//        modifier groups, but nothing enforces them at submit time, so a
//        crafted request can order a burrito with no tortilla choice or four
//        proteins. Clover accepts whatever we send.
//
// GAP-6  Discounts, service charges and tips.  Not modelled in our cart, not
//        sent here. Clover supports all three on the order.
// ─────────────────────────────────────────────────────────────────────────────
