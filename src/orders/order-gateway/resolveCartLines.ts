import { fetchItemTaxRates } from "../../clover/tax/fetchItemTaxRates";
import { readAvailability } from "../../menu-sync/cache/availabilityCache";
import type { InternalOrderLine } from "./mapCartToCloverOrder";
import { getCatalogItems, getCatalogModifiers, type CartLineItem } from "./repository";

export interface CheckoutLineItemInput {
  itemId: string; // our uuid
  quantity: number;
  note?: string;
  modifierIds?: string[]; // our uuid
}

export interface UnavailableCartItem {
  itemId: string; // our uuid
  name: string;
}

export interface ResolvedCartLines {
  cartLineItems: CartLineItem[];
  /** Ready to hand straight to mapCartToCloverOrder -- tax rates already attached. */
  internalOrderLines: InternalOrderLine[];
  /**
   * Cart items that are currently hidden or unavailable, checked live via the
   * same Redis cache webhooks/reconciliation write to -- populated regardless
   * of `checkAvailability`, so a caller that doesn't want a hard throw (the
   * cart preview) still gets full visibility into every offending line, not
   * just the first one.
   */
  unavailableItems: UnavailableCartItem[];
}

// Shared by submitOrder (checkAvailability: true, since placing an order must
// re-check the live Redis cache) and the cart tax preview endpoint
// (checkAvailability: false, since an estimate shouldn't hard-fail just
// because an item went 86'd while someone was still browsing).
//
// Also fetches each line's effective Clover tax rate up front, so callers can
// hand the result straight to mapCartToCloverOrder without a second round of
// Clover calls.
export async function resolveCartLines(
  merchantId: string,
  cloverMerchantId: string,
  items: CheckoutLineItemInput[],
  options: { checkAvailability: boolean },
): Promise<ResolvedCartLines> {
  const itemIds = items.map((i) => i.itemId);
  const catalogItems = await getCatalogItems(merchantId, itemIds);
  const catalogById = new Map(catalogItems.map((c) => [c.id, c]));

  const unavailableItems: UnavailableCartItem[] = [];
  for (const cartItem of items) {
    const catalog = catalogById.get(cartItem.itemId);
    if (!catalog) throw new Error(`Unknown item ${cartItem.itemId}`); // client sent an id that isn't in the catalog at all -- not a "went unavailable" case

    if (catalog.hidden) {
      if (options.checkAvailability) throw new Error(`${catalog.name} is not on the menu`);
      unavailableItems.push({ itemId: catalog.id, name: catalog.name });
      continue;
    }

    const live = await readAvailability(merchantId, catalog.cloverItemId);
    const isAvailable = live ? live.available && !live.hidden : catalog.available;
    if (!isAvailable) {
      if (options.checkAvailability) throw new Error(`${catalog.name} is currently unavailable`);
      unavailableItems.push({ itemId: catalog.id, name: catalog.name });
    }
  }

  const allModifierIds = [...new Set(items.flatMap((i) => i.modifierIds ?? []))];
  const modifierById = new Map((await getCatalogModifiers(allModifierIds)).map((m) => [m.id, m]));

  const cartLineItems: CartLineItem[] = items.map((cartItem) => {
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

  const uniqueCloverItemIds = [...new Set(cartLineItems.map((li) => li.cloverItemId))];
  const taxRatesByCloverItemId = new Map(
    await Promise.all(
      uniqueCloverItemIds.map(
        async (cloverItemId) => [cloverItemId, await fetchItemTaxRates(merchantId, cloverMerchantId, cloverItemId)] as const,
      ),
    ),
  );

  const internalOrderLines: InternalOrderLine[] = cartLineItems.map((li) => ({
    cloverItemId: li.cloverItemId,
    name: li.name,
    priceCents: li.priceCents,
    quantity: li.quantity,
    note: li.note,
    modifiers: li.modifiers.map((m) => ({
      cloverModifierId: m.cloverModifierId,
      name: m.name,
      priceCents: m.priceCents,
    })),
    taxRates: taxRatesByCloverItemId.get(li.cloverItemId),
  }));

  return { cartLineItems, internalOrderLines, unavailableItems };
}
