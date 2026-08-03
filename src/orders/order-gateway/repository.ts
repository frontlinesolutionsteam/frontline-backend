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
}

export async function insertDraftOrder(order: NewOrder, lineItems: CartLineItem[]): Promise<string> {
  const subtotalCents = lineItems.reduce(
    (sum, li) => sum + (li.priceCents + li.modifiers.reduce((s, m) => s + m.priceCents, 0)) * li.quantity,
    0,
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO orders (merchant_id, customer_id, source, status, requested_time, subtotal_cents, total_cents, payment_status)
       VALUES ($1, $2, $3, 'draft', $4, $5, $5, 'unpaid')
       RETURNING id`,
      [order.merchantId, order.customerId, order.source, order.requestedTime, subtotalCents],
    );
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
    return orderId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function markOrderConfirmed(orderId: string, cloverOrderId: string): Promise<void> {
  await pool.query(
    `UPDATE orders SET clover_order_id = $1, status = 'confirmed_clover' WHERE id = $2`,
    [cloverOrderId, orderId],
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
