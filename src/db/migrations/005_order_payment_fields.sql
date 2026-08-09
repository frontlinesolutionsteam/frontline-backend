-- Payment collection via Clover's Ecommerce API.
--
-- `payment_status`/`payment_method` already existed in 001_init.sql
-- (including 'iframe_web' as a payment_method) but were never written to;
-- this is the first feature to actually use them.
--
-- clover_charge_id is the Ecommerce API charge id -- a separate column from
-- clover_order_id (the Platform atomic order / kitchen ticket) since they are
-- different Clover objects, even once properly linked.
--
-- UPDATE (see submitPaidOrder.ts's revision history for the full story): this
-- comment originally said we reconcile the two ourselves because no
-- Clover-side link exists. That was wrong -- checking the actual sandbox
-- dashboard after a real payment showed the order as unpaid and missing from
-- Sales Overview, which led to switching from standalone POST /v1/charges to
-- POST /v1/orders/{orderId}/pay, which DOES attach the payment to the same
-- Platform atomic order. clover_charge_id is kept for refund lookups; the
-- order itself now correctly shows paid in Clover's own system, not just ours.
ALTER TABLE orders ADD COLUMN clover_charge_id TEXT;
ALTER TABLE orders ADD COLUMN decline_reason TEXT;

-- 'charging' is a transient claim state: submitPaidOrder.ts atomically flips
-- a row from 'draft' to 'charging' with `UPDATE ... WHERE status = 'draft'`
-- before calling Clover, and only the caller that wins that update actually
-- charges the card. This is what stops a double-click (two concurrent
-- requests for the same idempotency key) from charging the card twice --
-- the insertDraftOrder ON CONFLICT lock (migration 003) only dedupes the rows
-- INSERT, not what happens after both requests see the same existing row.
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('draft', 'charging', 'submitted', 'confirmed_clover', 'printed', 'failed', 'canceled'));
