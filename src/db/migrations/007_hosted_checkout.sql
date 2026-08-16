-- Pay-by-link (Hosted Checkout) support for AI-phone orders.
--
-- 'awaiting_payment' is a new pending state distinct from 'draft'/'charging'
-- (the card-token flow's states, see submitPaidOrder.ts): a pay-by-link order
-- has no Clover atomic order yet and won't until payment is confirmed
-- (webhook) or the window lapses (timeout job cancels it). 'canceled' already
-- existed in the enum but was previously unused by any code path.
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('draft', 'charging', 'awaiting_payment', 'submitted', 'confirmed_clover', 'printed', 'failed', 'canceled'));

-- The Hosted Checkout session id (Clover's own uuid, from the create-session
-- response) -- how an incoming webhook or the timeout job finds its way back
-- to this row. Unique because a session belongs to exactly one order attempt.
ALTER TABLE orders ADD COLUMN hosted_checkout_session_id TEXT UNIQUE;

-- The session's checkout page URL, stored so an idempotent retry of the
-- "initiate checkout" call can return the exact same link rather than
-- creating (and charging toward) a second Hosted Checkout session.
ALTER TABLE orders ADD COLUMN hosted_checkout_url TEXT;

-- created_at + 17 minutes (15-minute native Hosted Checkout session lifetime
-- + a buffer), computed once at initiation and stored rather than
-- recalculated, so the timeout job's query is a plain index-friendly
-- comparison against "now" instead of doing timezone/interval math per row.
ALTER TABLE orders ADD COLUMN hosted_checkout_expires_at TIMESTAMPTZ;

-- The original cart request (CheckoutLineItemInput[]), stored so the atomic
-- order can be created fresh from current catalog/availability/pricing at
-- payment-completion time rather than trusting a stale snapshot from when
-- the checkout link was created -- same "always resolve fresh" principle
-- resolveCartLines already applies everywhere else.
ALTER TABLE orders ADD COLUMN pending_cart_json JSONB;

CREATE INDEX idx_orders_awaiting_payment_expiry
  ON orders (hosted_checkout_expires_at)
  WHERE status = 'awaiting_payment';

-- orders.note was accepted in NewOrder/insertDraftOrder's TypeScript type all
-- along but never actually had a column to land in -- a pre-existing gap
-- (the value was silently dropped, not persisted), discovered while building
-- this feature's own note-handling. Not fixed in insertDraftOrder itself
-- (out of scope here), but the column needs to exist for
-- claimPendingHostedCheckoutOrder/findPendingOrderByCheckoutSessionId to
-- work at all, so adding it at the table level now.
ALTER TABLE orders ADD COLUMN note TEXT;

-- Per-merchant Hosted Checkout webhook signing secret (HMAC-SHA256, see
-- verifyHostedCheckout.ts). This is a genuinely different credential from
-- CLOVER_WEBHOOK_SECRET (the static X-Clover-Auth shared secret for core
-- Platform webhooks) -- Hosted Checkout webhooks are configured and secured
-- per-merchant, in that merchant's own Clover dashboard under Settings >
-- Ecommerce > Hosted Checkout, not app-wide in the Developer Dashboard.
ALTER TABLE merchants ADD COLUMN hosted_checkout_webhook_secret TEXT;
