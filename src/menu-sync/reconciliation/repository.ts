import { pool } from "../../db/pool";

export async function upsertCategory(
  merchantId: string,
  category: { id: string; name: string; sortOrder?: number },
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO categories (merchant_id, clover_category_id, name, sort_order, deleted_at)
     VALUES ($1, $2, $3, $4, NULL)
     ON CONFLICT (merchant_id, clover_category_id)
     DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, deleted_at = NULL
     RETURNING id`,
    [merchantId, category.id, category.name, category.sortOrder ?? null],
  );
  return rows[0].id;
}

export async function upsertModifierGroup(
  merchantId: string,
  group: { id: string; name: string; minRequired?: number; maxAllowed?: number },
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO modifier_groups (merchant_id, clover_modifier_group_id, name, min_required, max_allowed)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (merchant_id, clover_modifier_group_id)
     DO UPDATE SET name = EXCLUDED.name, min_required = EXCLUDED.min_required, max_allowed = EXCLUDED.max_allowed
     RETURNING id`,
    [merchantId, group.id, group.name, group.minRequired ?? null, group.maxAllowed ?? null],
  );
  return rows[0].id;
}

export async function upsertModifier(
  modifierGroupId: string,
  modifier: { id: string; name: string; price?: number },
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO modifiers (modifier_group_id, clover_modifier_id, name, price_cents)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (modifier_group_id, clover_modifier_id)
     DO UPDATE SET name = EXCLUDED.name, price_cents = EXCLUDED.price_cents
     RETURNING id`,
    [modifierGroupId, modifier.id, modifier.name, modifier.price ?? 0],
  );
  return rows[0].id;
}

export async function upsertItem(
  merchantId: string,
  item: { id: string; name: string; price?: number; hidden?: boolean; available?: boolean; modifiedTime?: number },
): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO items (merchant_id, clover_item_id, name, price_cents, hidden, available, modified_at_clover, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (merchant_id, clover_item_id)
     DO UPDATE SET
       name = EXCLUDED.name,
       price_cents = EXCLUDED.price_cents,
       hidden = EXCLUDED.hidden,
       available = EXCLUDED.available,
       modified_at_clover = EXCLUDED.modified_at_clover,
       synced_at = now()
     RETURNING id`,
    [
      merchantId,
      item.id,
      item.name,
      item.price ?? 0,
      item.hidden ?? false,
      item.available ?? true,
      item.modifiedTime ? new Date(item.modifiedTime) : null,
    ],
  );
  return rows[0].id;
}

export async function linkItemCategory(itemId: string, categoryId: string): Promise<void> {
  await pool.query(
    `INSERT INTO item_categories (item_id, category_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [itemId, categoryId],
  );
}

export async function linkItemModifierGroup(itemId: string, modifierGroupId: string): Promise<void> {
  await pool.query(
    `INSERT INTO item_modifier_groups (item_id, modifier_group_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [itemId, modifierGroupId],
  );
}
