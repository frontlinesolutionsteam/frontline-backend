import { pool } from "../../db/pool";

export interface CartLineItem {
  itemId: string; // our uuid
  cloverItemId: string;
  name: string;
  priceCents: number;
  quantity: number;
  note?: string;
  modifiers: { id: string; cloverModifierId: string; name: string; priceCents: number }[];
}

export interface NewOrder {
  merchantId: string;
  customerId: string | null;
  source: "website" | "ai_phone";
  requestedTime: string | null;
  note: string | null;
  idempotencyKey: string;
}

export interface InsertOrderResult {
  orderId: string;
  /** false if a row for this (merchantId, idempotencyKey) already existed -- line items were NOT re-inserted. */
  isNew: boolean;
}

// GAP-4: Clover's atomic order endpoint has no idempotency of its own (see
// migration 003), so a retry of the same logical checkout must not insert a
// second draft order. The ON CONFLICT DO NOTHING + re-select is what makes
// this race-safe: two concurrent requests with the same idempotency key can
// both reach this function at once, and only one of them wins the insert --
// the other observes the conflict and reuses the winner's order id instead of
// creating its own draft.
export async function insertDraftOrder(order: NewOrder, lineItems: CartLineItem[]): Promise<InsertOrderResult> {
  const subtotalCents = lineItems.reduce(
    (sum, li) => sum + (li.priceCents + li.modifiers.reduce((s, m) => s + m.priceCents, 0)) * li.quantity,
    0,
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO orders (merchant_id, customer_id, source, status, requested_time, subtotal_cents, total_cents, payment_status, idempotency_key)
       VALUES ($1, $2, $3, 'draft', $4, $5, $5, 'unpaid', $6)
       ON CONFLICT (merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [order.merchantId, order.customerId, order.source, order.requestedTime, subtotalCents, order.idempotencyKey],
    );

    if (rows.length === 0) {
      // Someone already inserted an order for this idempotency key (either an
      // earlier attempt in this process, or a concurrent request that won the
      // race). Nothing to commit on this transaction.
      await client.query("ROLLBACK");
      const existing = await findOrderByIdempotencyKey(order.merchantId, order.idempotencyKey);
      if (!existing) {
        // Insert conflicted against a row we can no longer find -- should be
        // unreachable, but surfacing this as a normal "reuse" would silently
        // drop the order.
        throw new Error(
          `Order insert conflicted for idempotency key ${order.idempotencyKey} but no existing order was found`,
        );
      }
      return { orderId: existing.id, isNew: false };
    }

    const orderId = rows[0].id;

    for (const li of lineItems) {
      const { rows: liRows } = await client.query(
        `INSERT INTO order_line_items (order_id, item_id, quantity, note, price_cents_at_order)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [orderId, li.itemId, li.quantity, li.note ?? null, li.priceCents],
      );
      const lineItemId = liRows[0].id;
      for (const modifier of li.modifiers) {
        await client.query(
          `INSERT INTO order_line_item_modifiers (order_line_item_id, modifier_id) VALUES ($1, $2)`,
          [lineItemId, modifier.id],
        );
      }
    }

    await client.query("COMMIT");
    return { orderId, isNew: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface ExistingOrderSnapshot {
  id: string;
  status: string;
  cloverOrderId: string | null;
  totalCents: number;
  cloverChargeId: string | null;
  paymentStatus: string;
  declineReason: string | null;
  hostedCheckoutUrl: string | null;
}

export async function findOrderByIdempotencyKey(
  merchantId: string,
  idempotencyKey: string,
): Promise<ExistingOrderSnapshot | null> {
  const { rows } = await pool.query(
    `SELECT id, status, clover_order_id, total_cents, clover_charge_id, payment_status, decline_reason, hosted_checkout_url
     FROM orders WHERE merchant_id = $1 AND idempotency_key = $2`,
    [merchantId, idempotencyKey],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    status: row.status,
    cloverOrderId: row.clover_order_id,
    totalCents: row.total_cents,
    cloverChargeId: row.clover_charge_id,
    paymentStatus: row.payment_status,
    declineReason: row.decline_reason,
    hostedCheckoutUrl: row.hosted_checkout_url,
  };
}

// Atomically claims a draft row for a charge attempt. Only the caller that
// flips 'draft' -> 'charging' gets to actually call Clover; a concurrent
// request (a double-click firing two requests before either completes) sees
// 0 rows updated and must not charge. This is the guard insertDraftOrder's
// ON CONFLICT lock (migration 003) does NOT provide by itself -- that lock
// only dedupes the row's INSERT, not what two callers do once they both see
// the same existing row.
export async function claimOrderForCharging(orderId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE orders SET status = 'charging' WHERE id = $1 AND status = 'draft'`,
    [orderId],
  );
  return (rowCount ?? 0) > 0;
}

// Recorded immediately after the Platform atomic order is created, BEFORE
// payment is attempted -- see submitPaidOrder.ts. This is what makes a crash
// between "order created" and "payment attempted" resumable without creating
// a second Clover order: a retry with the same idempotency key finds
// clover_order_id already set and skips straight to paying that order.
// total_cents/tax_cents are known for certain at this point (the atomic
// order create response gives us Clover's own total immediately), so they're
// recorded here rather than guessed at.
export async function markOrderCreatedAwaitingPayment(
  orderId: string,
  cloverOrderId: string,
  totalCents: number,
  taxCents: number,
): Promise<void> {
  await pool.query(
    `UPDATE orders SET clover_order_id = $1, total_cents = $2, tax_cents = $3 WHERE id = $4`,
    [cloverOrderId, totalCents, taxCents, orderId],
  );
}

// A decline is terminal for this idempotency key -- see submitPaidOrder.ts
// for why we don't allow a same-key retry after this (tokens are single-use
// and a genuine retry should mint a fresh key). status='failed' already
// exists in the schema; nothing Clover-side was ever created.
export async function markChargeDeclined(orderId: string, declineReason: string): Promise<void> {
  await pool.query(`UPDATE orders SET status = 'failed', decline_reason = $1 WHERE id = $2`, [
    declineReason,
    orderId,
  ]);
}

export async function markOrderRefunded(orderId: string): Promise<void> {
  await pool.query(`UPDATE orders SET payment_status = 'refunded' WHERE id = $1`, [orderId]);
}

export interface OrderByCloverOrderId {
  id: string;
  merchantId: string;
  cloverChargeId: string | null;
  paymentStatus: string;
  totalCents: number;
}

// Used by the refund path: staff identify an order by its Clover atomic
// order id (what's printed on the ticket / visible in the Clover dashboard),
// not by our internal uuid or the Ecommerce charge id.
export async function getOrderByCloverOrderId(cloverOrderId: string): Promise<OrderByCloverOrderId | null> {
  const { rows } = await pool.query(
    `SELECT id, merchant_id, clover_charge_id, payment_status, total_cents FROM orders WHERE clover_order_id = $1`,
    [cloverOrderId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    merchantId: row.merchant_id,
    cloverChargeId: row.clover_charge_id,
    paymentStatus: row.payment_status,
    totalCents: row.total_cents,
  };
}

// GAP-3: totalCents/taxCents come from Clover's own computation (the
// authoritative source for what the customer will actually be charged), not
// from our pre-tax subtotal. `total_cents` therefore stops meaning "our
// subtotal" the moment an order confirms and starts meaning "what Clover
// says this order costs" -- `subtotal_cents` remains the pre-tax figure so
// `tax_cents` is always derivable as a cross-check (total - subtotal).
export async function markOrderConfirmed(
  orderId: string,
  cloverOrderId: string,
  totalCents: number,
  taxCents: number,
): Promise<void> {
  await pool.query(
    `UPDATE orders SET clover_order_id = $1, status = 'confirmed_clover', total_cents = $2, tax_cents = $3 WHERE id = $4`,
    [cloverOrderId, totalCents, taxCents, orderId],
  );
}

// Used by the paid checkout path (submitPaidOrder.ts) once POST
// /v1/orders/{orderId}/pay succeeds -- payment is attached to the SAME
// Platform atomic order (clover_order_id was already set by
// markOrderCreatedAwaitingPayment), so this order shows as paid in Clover's
// own Orders list and Sales Overview reporting, not just in our DB. The
// plain markOrderConfirmed above stays untouched for the unpaid/pay-at-pickup
// path (submitOrder.ts), which the AI phone-order flow still uses.
export async function markOrderConfirmedAndPaid(
  orderId: string,
  cloverChargeId: string,
): Promise<void> {
  await pool.query(
    `UPDATE orders SET status = 'confirmed_clover', payment_status = 'paid', clover_charge_id = $1, payment_method = 'iframe_web' WHERE id = $2`,
    [cloverChargeId, orderId],
  );
}

export async function markOrderPrinted(orderId: string): Promise<void> {
  await pool.query(`UPDATE orders SET status = 'printed' WHERE id = $1`, [orderId]);
}

export async function markOrderFailed(orderId: string): Promise<void> {
  await pool.query(`UPDATE orders SET status = 'failed' WHERE id = $1`, [orderId]);
}

export interface OrderStatus {
  id: string;
  cloverOrderId: string | null;
  status: string;
  totalCents: number;
  createdAt: string;
}

export async function getOrderStatus(orderId: string): Promise<OrderStatus | null> {
  const { rows } = await pool.query(
    `SELECT id, clover_order_id, status, total_cents, created_at FROM orders WHERE id = $1`,
    [orderId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    cloverOrderId: row.clover_order_id,
    status: row.status,
    totalCents: row.total_cents,
    createdAt: row.created_at,
  };
}

export interface CatalogItem {
  id: string;
  cloverItemId: string;
  name: string;
  priceCents: number;
  hidden: boolean;
  available: boolean;
}

export async function getCatalogItems(merchantId: string, itemIds: string[]): Promise<CatalogItem[]> {
  const { rows } = await pool.query(
    `SELECT id, clover_item_id, name, price_cents, hidden, available
     FROM items WHERE merchant_id = $1 AND id = ANY($2::uuid[])`,
    [merchantId, itemIds],
  );
  return rows.map((row) => ({
    id: row.id,
    cloverItemId: row.clover_item_id,
    name: row.name,
    priceCents: row.price_cents,
    hidden: row.hidden,
    available: row.available,
  }));
}

export interface CatalogModifier {
  id: string;
  cloverModifierId: string;
  name: string;
  priceCents: number;
}

// ── Pay-by-link (Hosted Checkout) ───────────────────────────────────────────

export interface ClaimPendingHostedCheckoutOrder {
  merchantId: string;
  customerId: string;
  source: "ai_phone" | "website";
  requestedTime: string | null;
  note: string | null;
  idempotencyKey: string;
  subtotalCents: number;
  totalCents: number;
  /** The original CheckoutLineItemInput[] request, re-resolved fresh at payment-completion time. */
  pendingCart: unknown;
}

// Claims the idempotency key BEFORE any Clover call is made (no
// hosted_checkout_session_id yet -- attachHostedCheckoutSession sets it
// after). Same insert-first-side-effect-second shape submitPaidOrder.ts uses
// and for the same reason: creating the Hosted Checkout session is an
// external side effect (it produces a real, textable payment link), so two
// concurrent requests for the same idempotency key must not both reach that
// call -- only the one that wins this claim proceeds; the loser reuses
// whatever the winner produces.
export async function claimPendingHostedCheckoutOrder(
  order: ClaimPendingHostedCheckoutOrder,
): Promise<InsertOrderResult> {
  const { rows } = await pool.query(
    `INSERT INTO orders
       (merchant_id, customer_id, source, status, requested_time, note, subtotal_cents, total_cents,
        payment_status, idempotency_key, pending_cart_json)
     VALUES ($1, $2, $3, 'awaiting_payment', $4, $5, $6, $7, 'unpaid', $8, $9)
     ON CONFLICT (merchant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      order.merchantId,
      order.customerId,
      order.source,
      order.requestedTime,
      order.note,
      order.subtotalCents,
      order.totalCents,
      order.idempotencyKey,
      JSON.stringify(order.pendingCart),
    ],
  );

  if (rows.length > 0) return { orderId: rows[0].id, isNew: true };

  const existing = await findOrderByIdempotencyKey(order.merchantId, order.idempotencyKey);
  if (!existing) {
    throw new Error(
      `Pending Hosted Checkout order claim conflicted for idempotency key ${order.idempotencyKey} but no existing order was found`,
    );
  }
  return { orderId: existing.id, isNew: false };
}

export async function attachHostedCheckoutSession(
  orderId: string,
  hostedCheckoutSessionId: string,
  hostedCheckoutUrl: string,
  expiresAt: Date,
): Promise<void> {
  await pool.query(
    `UPDATE orders SET hosted_checkout_session_id = $1, hosted_checkout_url = $2, hosted_checkout_expires_at = $3 WHERE id = $4`,
    [hostedCheckoutSessionId, hostedCheckoutUrl, expiresAt, orderId],
  );
}

export interface PendingHostedCheckoutOrder {
  id: string;
  merchantId: string;
  customerId: string;
  status: string;
  totalCents: number;
  requestedTime: string | null;
  note: string | null;
  pendingCart: { itemId: string; quantity: number; note?: string; modifierIds?: string[] }[];
  customerPhoneE164: string;
}

export async function findPendingOrderByCheckoutSessionId(
  hostedCheckoutSessionId: string,
): Promise<PendingHostedCheckoutOrder | null> {
  const { rows } = await pool.query(
    `SELECT o.id, o.merchant_id, o.customer_id, o.status, o.total_cents, o.requested_time, o.note,
            o.pending_cart_json, c.phone_e164
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.hosted_checkout_session_id = $1`,
    [hostedCheckoutSessionId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    merchantId: row.merchant_id,
    customerId: row.customer_id,
    status: row.status,
    totalCents: row.total_cents,
    requestedTime: row.requested_time,
    note: row.note,
    pendingCart: row.pending_cart_json,
    customerPhoneE164: row.phone_e164,
  };
}

// Timeout job's query -- every order still awaiting payment whose window has
// lapsed. Joins customers for the cancellation SMS's phone number and
// merchants for its Clover merchant id (ops-alert detail / dashboard lookup).
export interface ExpiredHostedCheckoutOrder {
  id: string;
  hostedCheckoutSessionId: string;
  totalCents: number;
  customerPhoneE164: string;
  cloverMerchantId: string;
  businessName: string | null;
  createdAt: string;
}

export async function findExpiredAwaitingPaymentOrders(): Promise<ExpiredHostedCheckoutOrder[]> {
  const { rows } = await pool.query(
    `SELECT o.id, o.hosted_checkout_session_id, o.total_cents, o.created_at,
            c.phone_e164, m.clover_merchant_id, m.business_name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN merchants m ON m.id = o.merchant_id
     WHERE o.status = 'awaiting_payment' AND o.hosted_checkout_expires_at < now()`,
  );
  return rows.map((row) => ({
    id: row.id,
    hostedCheckoutSessionId: row.hosted_checkout_session_id,
    totalCents: row.total_cents,
    customerPhoneE164: row.phone_e164,
    cloverMerchantId: row.clover_merchant_id,
    businessName: row.business_name,
    createdAt: row.created_at,
  }));
}

export async function markOrderCanceled(orderId: string, reason: string): Promise<void> {
  await pool.query(`UPDATE orders SET status = 'canceled', decline_reason = $1 WHERE id = $2`, [reason, orderId]);
}

// Used once a Hosted Checkout payment is confirmed and the real atomic order
// has just been created -- mirrors markOrderCreatedAwaitingPayment's "record
// the Clover order id immediately, before attaching payment" sequencing, so
// a crash between order-creation and payment-attach resumes against the same
// Clover order rather than creating a second one.
export async function markHostedCheckoutOrderCreated(
  orderId: string,
  cloverOrderId: string,
  totalCents: number,
  taxCents: number,
): Promise<void> {
  await pool.query(
    `UPDATE orders SET clover_order_id = $1, total_cents = $2, tax_cents = $3 WHERE id = $4`,
    [cloverOrderId, totalCents, taxCents, orderId],
  );
}

export async function markHostedCheckoutOrderPaid(orderId: string, paymentId: string): Promise<void> {
  await pool.query(
    `UPDATE orders SET status = 'confirmed_clover', payment_status = 'paid', clover_charge_id = $1, payment_method = 'hosted_checkout_sms' WHERE id = $2`,
    [paymentId, orderId],
  );
}

export async function getCatalogModifiers(modifierIds: string[]): Promise<CatalogModifier[]> {
  if (modifierIds.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT id, clover_modifier_id, name, price_cents FROM modifiers WHERE id = ANY($1::uuid[])`,
    [modifierIds],
  );
  return rows.map((row) => ({
    id: row.id,
    cloverModifierId: row.clover_modifier_id,
    name: row.name,
    priceCents: row.price_cents,
  }));
}
