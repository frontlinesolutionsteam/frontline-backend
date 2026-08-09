export interface CloverOrderModificationInput {
  modifier: { id: string };
  name: string;
  amount: number;
}

export interface CloverLineItemInput {
  item: { id: string };
  // Only meaningful for items the merchant sells by weight/measure, where
  // Clover reads it in thousandths (1000 = one unit). Plain items express
  // quantity by repeating the line item instead -- see mapCartToCloverOrder.
  unitQty?: number;
  note?: string;
  // Suppresses the item's catalog tax rates for this line. We never set this
  // today; it exists so tax-exempt orders have a home when we get there.
  taxRemoved?: boolean;
  modifications?: CloverOrderModificationInput[];
}

// Discovered empirically against the sandbox: the create-order body must be
// wrapped in "orderCart", and each modification needs its own name/amount
// snapshot rather than just a modifier id reference.
export interface CreateAtomicOrderRequest {
  orderCart: {
    state: "open";
    lineItems: CloverLineItemInput[];
    note?: string;
    customer?: { id: string };
    // Per-merchant id (e.g. the merchant's "Online Order" type). Controls how
    // the ticket is labelled and routed on the POS, so it is client config,
    // never a constant.
    orderType?: { id: string };
    title?: string;
  };
}

export interface CloverOrderLineItem {
  id: string;
  name?: string;
  price?: number;
  note?: string;
}

export interface CloverOrder {
  id: string;
  total: number;
  state: string;
  currency?: string;
  createdTime?: number;
  lineItems?: { elements: CloverOrderLineItem[] };
}

// Confirmed empirically against the sandbox: Clover does NOT return a
// top-level tax field on the order (create or get). Tax is only recoverable
// as `total - sum(line item prices + modifications)`. There was previously an
// (incorrect) `taxAmount` field on CloverOrder -- removed rather than left
// around returning undefined forever. See computeExpectedTax.ts for how we
// derive our own expected tax instead.
