export interface CloverOrderModificationInput {
  modifier: { id: string };
  name: string;
  amount: number;
}

export interface CloverLineItemInput {
  item: { id: string };
  unitQty: number;
  note?: string;
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
  };
}

export interface CloverOrder {
  id: string;
  total: number;
  state: string;
}
