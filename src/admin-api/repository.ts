import { pool } from "../db/pool";

export interface AdminItem {
  id: string;
  cloverItemId: string;
  name: string;
  description: string | null;
  priceCents: number;
  hidden: boolean;
  available: boolean;
  imageUrl: string | null;
  syncedAt: string;
}

export interface AdminCategory {
  id: string;
  cloverCategoryId: string;
  name: string;
  sortOrder: number | null;
  items: AdminItem[];
}

// Read model for the admin menu-review UI. Categories and items are
// Clover-owned (synced, read-only in the UI); description and imageUrl are
// Frontline-owned fields the restaurant edits here, per the schema.
export async function getMerchantMenu(merchantId: string): Promise<AdminCategory[]> {
  const { rows: categoryRows } = await pool.query(
    `SELECT id, clover_category_id, name, sort_order
     FROM categories
     WHERE merchant_id = $1 AND deleted_at IS NULL
     ORDER BY sort_order NULLS LAST, name`,
    [merchantId],
  );

  const { rows: itemRows } = await pool.query(
    `SELECT i.id, i.clover_item_id, i.name, i.description, i.price_cents, i.hidden, i.available,
            i.image_url, i.synced_at, ic.category_id
     FROM items i
     JOIN item_categories ic ON ic.item_id = i.id
     WHERE i.merchant_id = $1
     ORDER BY i.name`,
    [merchantId],
  );

  const itemsByCategory = new Map<string, AdminItem[]>();
  for (const row of itemRows) {
    const item: AdminItem = {
      id: row.id,
      cloverItemId: row.clover_item_id,
      name: row.name,
      description: row.description,
      priceCents: row.price_cents,
      hidden: row.hidden,
      available: row.available,
      imageUrl: row.image_url,
      syncedAt: row.synced_at,
    };
    const list = itemsByCategory.get(row.category_id) ?? [];
    list.push(item);
    itemsByCategory.set(row.category_id, list);
  }

  return categoryRows.map((row) => ({
    id: row.id,
    cloverCategoryId: row.clover_category_id,
    name: row.name,
    sortOrder: row.sort_order,
    items: itemsByCategory.get(row.id) ?? [],
  }));
}

export async function updateItemDescription(itemId: string, description: string): Promise<void> {
  await pool.query(`UPDATE items SET description = $1 WHERE id = $2`, [description, itemId]);
}

export async function updateItemImageUrl(itemId: string, imageUrl: string): Promise<void> {
  await pool.query(`UPDATE items SET image_url = $1 WHERE id = $2`, [imageUrl, itemId]);
}
