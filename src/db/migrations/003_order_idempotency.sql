-- GAP-4 fix: application-level idempotency for order submission.
--
-- Confirmed empirically against the Clover sandbox (two POSTs to
-- /atomic_order/orders with the same client-supplied orderCart.id produced
-- two distinct Clover orders) that Clover's atomic order endpoint has no
-- idempotency of its own -- the orderCart.id field is not deduped, and there
-- is no externalReferenceId (or equivalent) on the atomic-order request body
-- to reconcile against afterward. Retry-safety has to live entirely on our
-- side, keyed off a value the caller supplies once per checkout attempt.
ALTER TABLE orders ADD COLUMN idempotency_key TEXT;

-- Partial (not full) unique index: rows created before this migration have no
-- key and must not collide with each other or block new ones. Every new
-- checkout is required to supply a key at the application layer (see
-- submitOrder.ts), so the constraint only needs to bite once a key exists.
CREATE UNIQUE INDEX orders_merchant_idempotency_key_idx
  ON orders (merchant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
