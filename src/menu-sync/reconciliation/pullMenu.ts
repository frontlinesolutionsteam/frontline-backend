import { cloverConfig } from "../../clover/config";
import { fetchAllPages } from "../../clover/client/paginate";
import { getMerchantByCloverId } from "../../clover/auth/tokenStore";
import { pool } from "../../db/pool";
import type { CloverCategory, CloverItem, CloverModifierGroup } from "../../clover/types/menu";
import {
  linkItemCategory,
  linkItemModifierGroup,
  upsertCategory,
  upsertItem,
  upsertModifier,
  upsertModifierGroup,
} from "./repository";

async function pullMenu(cloverMerchantId: string) {
  const merchant = await getMerchantByCloverId(cloverMerchantId);
  if (!merchant) {
    throw new Error(
      `No merchant record for Clover merchant ${cloverMerchantId}. Complete the OAuth connect flow first.`,
    );
  }

  console.log(`Pulling menu for merchant ${merchant.id} (Clover ${cloverMerchantId})`);

  const categories = await fetchAllPages<CloverCategory>(merchant.id, cloverMerchantId, "/categories");
  const categoryIdMap = new Map<string, string>();
  for (const category of categories) {
    const id = await upsertCategory(merchant.id, category);
    categoryIdMap.set(category.id, id);
  }
  console.log(`  categories: ${categories.length}`);

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
  console.log(`  modifier groups: ${modifierGroups.length} (${modifierCount} modifiers)`);

  const items = await fetchAllPages<CloverItem>(merchant.id, cloverMerchantId, "/items", {
    expand: "categories,modifierGroups",
  });
  let categoryLinks = 0;
  let modifierGroupLinks = 0;
  for (const item of items) {
    const itemId = await upsertItem(merchant.id, item);

    for (const category of item.categories?.elements ?? []) {
      const categoryId = categoryIdMap.get(category.id);
      if (categoryId) {
        await linkItemCategory(itemId, categoryId);
        categoryLinks += 1;
      }
    }

    for (const group of item.modifierGroups?.elements ?? []) {
      const groupId = modifierGroupIdMap.get(group.id);
      if (groupId) {
        await linkItemModifierGroup(itemId, groupId);
        modifierGroupLinks += 1;
      }
    }
  }
  console.log(`  items: ${items.length} (${categoryLinks} category links, ${modifierGroupLinks} modifier group links)`);

  console.log("Menu pull complete.");
}

const cloverMerchantId = process.argv[2] ?? cloverConfig.sandboxMerchantId;
if (!cloverMerchantId) {
  console.error("Usage: npm run sync-menu -- <cloverMerchantId>  (or set CLOVER_SANDBOX_MERCHANT_ID)");
  process.exit(1);
}

pullMenu(cloverMerchantId)
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
