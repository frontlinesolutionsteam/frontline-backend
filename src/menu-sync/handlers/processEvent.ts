import { getMerchantById } from "../../clover/auth/tokenStore";
import { CloverApiError, cloverRequest } from "../../clover/client/httpClient";
import { fetchAllPages } from "../../clover/client/paginate";
import type { CloverCategory, CloverItem, CloverModifierGroup } from "../../clover/types/menu";
import { logger } from "../../shared/logging/logger";
import {
  linkItemCategory,
  linkItemModifierGroup,
  markCategoryDeleted,
  markItemDeleted,
  upsertCategory,
  upsertItem,
  upsertModifier,
  upsertModifierGroup,
} from "../reconciliation/repository";

export interface WebhookEventRow {
  id: string;
  merchantId: string;
  cloverObjectId: string;
  eventType: "CREATE" | "UPDATE" | "DELETE";
  objectKind: string;
}

export async function processWebhookEvent(event: WebhookEventRow): Promise<void> {
  const merchant = await getMerchantById(event.merchantId);
  if (!merchant) {
    throw new Error(`Unknown merchant ${event.merchantId} for webhook event ${event.id}`);
  }

  switch (event.objectKind) {
    case "I":
    case "IA": // item-availability toggle — observed in sandbox, not documented; objectId is the item id, same as "I"
      await processItemEvent(merchant.id, merchant.cloverMerchantId, event);
      return;
    case "IC":
      await processCategoryEvent(merchant.id, merchant.cloverMerchantId, event);
      return;
    case "IG":
    case "IM":
      // Modifier-level events don't carry their parent group's id in the thin
      // webhook payload, and Clover doesn't document a standalone
      // modifier-by-id endpoint — refresh all modifier groups for the
      // merchant instead. Cheap in practice: restaurant modifier lists are
      // always small. Deletions of groups/modifiers are caught by nightly
      // reconciliation rather than handled precisely here.
      await refreshAllModifierGroups(merchant.id, merchant.cloverMerchantId);
      return;
    default:
      logger.info("Ignoring webhook event for unhandled object kind", {
        kind: event.objectKind,
        cloverObjectId: event.cloverObjectId,
      });
  }
}

async function processItemEvent(
  merchantId: string,
  cloverMerchantId: string,
  event: WebhookEventRow,
): Promise<void> {
  if (event.eventType === "DELETE") {
    await markItemDeleted(merchantId, event.cloverObjectId);
    return;
  }

  try {
    const item = await cloverRequest<CloverItem>(merchantId, cloverMerchantId, `/items/${event.cloverObjectId}`, {
      query: { expand: "categories,modifierGroups" },
    });
    const itemId = await upsertItem(merchantId, item);

    for (const category of item.categories?.elements ?? []) {
      const categoryId = await upsertCategory(merchantId, category);
      await linkItemCategory(itemId, categoryId);
    }
    for (const group of item.modifierGroups?.elements ?? []) {
      const groupId = await upsertModifierGroup(merchantId, group);
      await linkItemModifierGroup(itemId, groupId);
    }
  } catch (err) {
    if (err instanceof CloverApiError && err.status === 404) {
      // Item gone from Clover but we received a CREATE/UPDATE rather than a
      // DELETE (or the DELETE webhook itself never arrived) — treat as gone.
      await markItemDeleted(merchantId, event.cloverObjectId);
      return;
    }
    throw err;
  }
}

async function processCategoryEvent(
  merchantId: string,
  cloverMerchantId: string,
  event: WebhookEventRow,
): Promise<void> {
  if (event.eventType === "DELETE") {
    await markCategoryDeleted(merchantId, event.cloverObjectId);
    return;
  }

  try {
    const category = await cloverRequest<CloverCategory>(
      merchantId,
      cloverMerchantId,
      `/categories/${event.cloverObjectId}`,
    );
    await upsertCategory(merchantId, category);
  } catch (err) {
    if (err instanceof CloverApiError && err.status === 404) {
      await markCategoryDeleted(merchantId, event.cloverObjectId);
      return;
    }
    throw err;
  }
}

async function refreshAllModifierGroups(merchantId: string, cloverMerchantId: string): Promise<void> {
  const groups = await fetchAllPages<CloverModifierGroup>(merchantId, cloverMerchantId, "/modifier_groups", {
    expand: "modifiers",
  });
  for (const group of groups) {
    const groupId = await upsertModifierGroup(merchantId, group);
    for (const modifier of group.modifiers?.elements ?? []) {
      await upsertModifier(groupId, modifier);
    }
  }
}
