import { pool } from "../db/pool";

export interface PublicModifier {
  id: string;
  name: string;
  priceCents: number;
}

export interface PublicModifierGroup {
  id: string;
  name: string;
  minRequired: number | null;
  maxAllowed: number | null;
  modifiers: PublicModifier[];
}

export interface PublicItem {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  available: boolean;
  imageUrl: string | null;
  modifierGroups: PublicModifierGroup[];
}

export interface PublicCategory {
  id: string;
  name: string;
  sortOrder: number | null;
  items: PublicItem[];
}

// Customer-facing menu read. Hidden items are excluded entirely; out-of-stock
// (available=false) items are still shown so the customer sees the full menu,
// but flagged so the storefront can disable ordering them.
export async function getPublicMenu(merchantId: string): Promise<PublicCategory[]> {
  const { rows: categoryRows } = await pool.query(
    `SELECT id, name, sort_order FROM categories
     WHERE merchant_id = $1 AND deleted_at IS NULL
     ORDER BY sort_order NULLS LAST, name`,
    [merchantId],
  );

  const { rows: itemRows } = await pool.query(
    `SELECT i.id, i.name, i.description, i.price_cents, i.available, i.image_url, ic.category_id
     FROM items i
     JOIN item_categories ic ON ic.item_id = i.id
     WHERE i.merchant_id = $1 AND i.hidden = false
     ORDER BY i.name`,
    [merchantId],
  );

  const { rows: groupRows } = await pool.query(
    `SELECT mg.id, mg.name, mg.min_required, mg.max_allowed, img.item_id
     FROM modifier_groups mg
     JOIN item_modifier_groups img ON img.modifier_group_id = mg.id
     WHERE mg.merchant_id = $1`,
    [merchantId],
  );

  const { rows: modifierRows } = await pool.query(
    `SELECT m.id, m.name, m.price_cents, m.modifier_group_id
     FROM modifiers m
     JOIN modifier_groups mg ON mg.id = m.modifier_group_id
     WHERE mg.merchant_id = $1
     ORDER BY m.name`,
    [merchantId],
  );

  const modifiersByGroup = new Map<string, PublicModifier[]>();
  for (const row of modifierRows) {
    const list = modifiersByGroup.get(row.modifier_group_id) ?? [];
    list.push({ id: row.id, name: row.name, priceCents: row.price_cents });
    modifiersByGroup.set(row.modifier_group_id, list);
  }

  const groupsByItem = new Map<string, PublicModifierGroup[]>();
  for (const row of groupRows) {
    const list = groupsByItem.get(row.item_id) ?? [];
    list.push({
      id: row.id,
      name: row.name,
      minRequired: row.min_required,
      maxAllowed: row.max_allowed,
      modifiers: modifiersByGroup.get(row.id) ?? [],
    });
    groupsByItem.set(row.item_id, list);
  }

  const itemsByCategory = new Map<string, PublicItem[]>();
  for (const row of itemRows) {
    const list = itemsByCategory.get(row.category_id) ?? [];
    list.push({
      id: row.id,
      name: row.name,
      description: row.description,
      priceCents: row.price_cents,
      available: row.available,
      imageUrl: row.image_url,
      modifierGroups: groupsByItem.get(row.id) ?? [],
    });
    itemsByCategory.set(row.category_id, list);
  }

  return categoryRows
    .map((row) => ({
      id: row.id,
      name: row.name,
      sortOrder: row.sort_order,
      items: itemsByCategory.get(row.id) ?? [],
    }))
    .filter((category) => category.items.length > 0);
}
