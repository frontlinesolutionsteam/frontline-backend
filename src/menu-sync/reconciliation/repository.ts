import { pool } from "../../db/pool";
import { deleteAvailability, readAvailability, writeAvailability, type ItemAvailability } from "../cache/availabilityCache";

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

export interface UpsertableItem {
  id: string;
  name: string;
  price?: number;
  hidden?: boolean;
  available?: boolean;
  modifiedTime?: number;
  /** Clover's separate stock-tracking concept -- informational only, never gates orderability. See migration 006. */
  itemStock?: { quantity?: number; stockAlertThreshold?: number };
}

export interface AvailabilityDrift {
  cloverItemId: string;
  name: string;
  previous: ItemAvailability | null;
  current: ItemAvailability;
}

export interface UpsertItemResult {
  id: string;
  /** Non-null when this write changed hidden/available from what was already cached -- see reconcileMenu.ts for why this matters. */
  drift: AvailabilityDrift | null;
}

export async function upsertItem(merchantId: string, item: UpsertableItem): Promise<UpsertItemResult> {
  const current: ItemAvailability = {
    hidden: item.hidden ?? false,
    available: item.available ?? true,
  };

  // Read the PRIOR cached state before overwriting it -- this is what lets a
  // caller (reconcileMenu.ts) tell "Clover's value matched what we already
  // had" apart from "the poll just corrected something stale", which is the
  // whole signal for how reliable the webhook channel actually is. Cheap
  // (one Redis GET) and harmless for callers that don't care (pullMenu.ts's
  // manual one-off sync, and every webhook-driven call from processEvent.ts,
  // simply ignore the drift field).
  const previous = await readAvailability(merchantId, item.id);
  const drift =
    previous && previous.hidden === current.hidden && previous.available === current.available
      ? null
      : { cloverItemId: item.id, name: item.name, previous, current };

  const { rows } = await pool.query(
    `INSERT INTO items (merchant_id, clover_item_id, name, price_cents, hidden, available, quantity, stock_alert_threshold, modified_at_clover, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (merchant_id, clover_item_id)
     DO UPDATE SET
       name = EXCLUDED.name,
       price_cents = EXCLUDED.price_cents,
       hidden = EXCLUDED.hidden,
       available = EXCLUDED.available,
       quantity = EXCLUDED.quantity,
       stock_alert_threshold = EXCLUDED.stock_alert_threshold,
       modified_at_clover = EXCLUDED.modified_at_clover,
       synced_at = now()
     RETURNING id`,
    [
      merchantId,
      item.id,
      item.name,
      item.price ?? 0,
      current.hidden,
      current.available,
      item.itemStock?.quantity ?? null,
      item.itemStock?.stockAlertThreshold ?? null,
      item.modifiedTime ? new Date(item.modifiedTime) : null,
    ],
  );

  // Keep the fast-path availability cache in lockstep with every write to
  // items, so 86'd-item checks never depend on a slower Postgres round trip.
  await writeAvailability(merchantId, item.id, current);

  return { id: rows[0].id, drift };
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

// Used by both the webhook DELETE handler and reconciliation's delete-
// detection pass (items no longer present in a fresh full pull).
export async function markItemDeleted(merchantId: string, cloverItemId: string): Promise<void> {
  await pool.query(
    `UPDATE items SET hidden = true, available = false, synced_at = now()
     WHERE merchant_id = $1 AND clover_item_id = $2`,
    [merchantId, cloverItemId],
  );
  await deleteAvailability(merchantId, cloverItemId);
}

export async function markCategoryDeleted(merchantId: string, cloverCategoryId: string): Promise<void> {
  await pool.query(
    `UPDATE categories SET deleted_at = now() WHERE merchant_id = $1 AND clover_category_id = $2`,
    [merchantId, cloverCategoryId],
  );
}

// items has no deleted_at column (see schema) — "deleted" is represented as
// hidden=true/available=false, so this returns every known item and lets the
// caller diff against a fresh pull to find ones no longer present in Clover.
export async function getKnownCloverItemIds(merchantId: string): Promise<string[]> {
  const { rows } = await pool.query(`SELECT clover_item_id FROM items WHERE merchant_id = $1`, [merchantId]);
  return rows.map((r) => r.clover_item_id);
}

export async function getKnownCloverCategoryIds(merchantId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT clover_category_id FROM categories WHERE merchant_id = $1 AND deleted_at IS NULL`,
    [merchantId],
  );
  return rows.map((r) => r.clover_category_id);
}
