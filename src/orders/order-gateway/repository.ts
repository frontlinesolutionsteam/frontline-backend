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
}

export async function findOrderByIdempotencyKey(
  merchantId: string,
  idempotencyKey: string,
): Promise<ExistingOrderSnapshot | null> {
  const { rows } = await pool.query(
    `SELECT id, status, clover_order_id, total_cents, clover_charge_id, payment_status, decline_reason
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
