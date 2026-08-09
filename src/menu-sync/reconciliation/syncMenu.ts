import { fetchAllPages } from "../../clover/client/paginate";
import { getMerchantByCloverId, type MerchantRecord } from "../../clover/auth/tokenStore";
import type { CloverCategory, CloverItem, CloverModifierGroup } from "../../clover/types/menu";
import {
  linkItemCategory,
  linkItemModifierGroup,
  upsertCategory,
  upsertItem,
  upsertModifier,
  upsertModifierGroup,
  type AvailabilityDrift,
} from "./repository";

export interface MenuSyncResult {
  merchant: MerchantRecord;
  categoryIds: Set<string>; // Clover category ids seen in this pull
  itemIds: Set<string>; // Clover item ids seen in this pull
  categoryCount: number;
  itemCount: number;
  modifierGroupCount: number;
  modifierCount: number;
  /** Items whose hidden/available changed from what was already cached -- see reconcileMenu.ts. */
  availabilityDrift: AvailabilityDrift[];
}

// Full pull + upsert of a merchant's menu (categories, modifier groups,
// items, and their links). Shared by the one-off manual sync and the nightly
// reconciliation job — reconciliation adds delete-detection on top by
// diffing the returned id sets against what's already in Postgres.
export async function pullAndSyncMenu(cloverMerchantId: string): Promise<MenuSyncResult> {
  const merchant = await getMerchantByCloverId(cloverMerchantId);
  if (!merchant) {
    throw new Error(
      `No merchant record for Clover merchant ${cloverMerchantId}. Complete the OAuth connect flow first.`,
    );
  }

  const categories = await fetchAllPages<CloverCategory>(merchant.id, cloverMerchantId, "/categories");
  const categoryIdMap = new Map<string, string>();
  for (const category of categories) {
    const id = await upsertCategory(merchant.id, category);
    categoryIdMap.set(category.id, id);
  }

  const modifierGroups = await fetchAllPages<CloverModifierGroup>(
    merchant.id,
    cloverMerchantId,
    "/modifier_groups",
    { expand: "modifiers" },
  );
  const modifierGroupIdMap = new Map<string, string>();
  let modifierCount = 0;
  for (const group of modifierGroups) {
    const groupId = await upsertModifierGroup(merchant.id, group);
    modifierGroupIdMap.set(group.id, groupId);
    for (const modifier of group.modifiers?.elements ?? []) {
      await upsertModifier(groupId, modifier);
      modifierCount += 1;
    }
  }

  const items = await fetchAllPages<CloverItem>(merchant.id, cloverMerchantId, "/items", {
    expand: "categories,modifierGroups,itemStock",
  });
  const availabilityDrift: AvailabilityDrift[] = [];
  for (const item of items) {
    const { id: itemId, drift } = await upsertItem(merchant.id, item);
    if (drift) availabilityDrift.push(drift);

    for (const category of item.categories?.elements ?? []) {
      const categoryId = categoryIdMap.get(category.id);
      if (categoryId) await linkItemCategory(itemId, categoryId);
    }
    for (const group of item.modifierGroups?.elements ?? []) {
      const groupId = modifierGroupIdMap.get(group.id);
      if (groupId) await linkItemModifierGroup(itemId, groupId);
    }
  }

  return {
    merchant,
    categoryIds: new Set(categories.map((c) => c.id)),
    itemIds: new Set(items.map((i) => i.id)),
    categoryCount: categories.length,
    itemCount: items.length,
    modifierGroupCount: modifierGroups.length,
    modifierCount,
    availabilityDrift,
  };
}
