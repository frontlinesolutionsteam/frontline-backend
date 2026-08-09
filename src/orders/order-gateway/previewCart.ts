import { mapCartToCloverOrder } from "./mapCartToCloverOrder";
import { resolveCartLines, type CheckoutLineItemInput, type UnavailableCartItem } from "./resolveCartLines";

export interface CartPreviewResult {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  warnings: string[];
  /**
   * Cart items that went unavailable (86'd, or removed from the menu
   * entirely) since the customer added them, checked live against the same
   * cache webhooks/reconciliation write to. Phase 3 (live inventory sync):
   * checkout was already safe against this (submitOrder/submitPaidOrder both
   * re-check and reject), but that only surfaced the problem after the
   * customer had filled in their name/phone/card and hit Pay. Surfacing it
   * here lets the cart page flag the offending line and block checkout
   * before that point instead.
   */
  unavailableItems: UnavailableCartItem[];
}

// Read-only tax-aware total for the pre-checkout cart page. Deliberately
// reuses mapCartToCloverOrder/computeExpectedTax -- the exact same code path
// submitOrder uses to build the real Clover order -- so the number shown
// before payment and the number Clover actually charges come from one
// calculation, not two that can drift apart. Passes checkAvailability:false
// to resolveCartLines: an estimate shouldn't hard-fail just because an item
// went 86'd while someone was still browsing -- unavailableItems below
// reports it instead, so this can still return a usable total.
export async function previewCart(
  merchantId: string,
  cloverMerchantId: string,
  items: CheckoutLineItemInput[],
): Promise<CartPreviewResult> {
  if (items.length === 0) {
    return { subtotalCents: 0, taxCents: 0, totalCents: 0, warnings: [], unavailableItems: [] };
  }

  const { internalOrderLines, unavailableItems } = await resolveCartLines(merchantId, cloverMerchantId, items, {
    checkAvailability: false,
  });

  const mapped = mapCartToCloverOrder({ lines: internalOrderLines, source: "website" });

  // Order-type/customer/note warnings don't apply to a pre-checkout estimate
  // -- only surface the ones a customer-facing total actually needs to know
  // about (e.g. tax rates that couldn't be resolved).
  const relevantWarnings = mapped.warnings.filter((w) => w.includes("Tax rates were not fetched"));

  return {
    subtotalCents: mapped.expectedSubtotalCents,
    taxCents: mapped.expectedTaxCents,
    totalCents: mapped.expectedTotalCents,
    warnings: relevantWarnings,
    unavailableItems,
  };
}
