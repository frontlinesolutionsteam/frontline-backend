import { getConnectedMerchants } from "../../clover/auth/tokenStore";
import { pool } from "../../db/pool";
import { logger } from "../../shared/logging/logger";
import { closeAvailabilityCache } from "../cache/availabilityCache";
import { getKnownCloverCategoryIds, getKnownCloverItemIds, markCategoryDeleted, markItemDeleted } from "./repository";
import { pullAndSyncMenu } from "./syncMenu";

// Nightly full reconciliation: defense against missed/failed webhook
// deliveries, which Clover doesn't guarantee. Re-pulls and upserts the whole
// menu (same as the manual sync), then marks anything in our DB that no
// longer showed up in the fresh pull as deleted — the one thing webhook
// replay from thin payloads can't reliably tell us on its own.
async function reconcileMerchant(cloverMerchantId: string): Promise<void> {
  const result = await pullAndSyncMenu(cloverMerchantId);

  const knownItemIds = await getKnownCloverItemIds(result.merchant.id);
  const missingItemIds = knownItemIds.filter((id) => !result.itemIds.has(id));
  for (const id of missingItemIds) {
    await markItemDeleted(result.merchant.id, id);
  }

  const knownCategoryIds = await getKnownCloverCategoryIds(result.merchant.id);
  const missingCategoryIds = knownCategoryIds.filter((id) => !result.categoryIds.has(id));
  for (const id of missingCategoryIds) {
    await markCategoryDeleted(result.merchant.id, id);
  }

  logger.info("Reconciled merchant menu", {
    cloverMerchantId,
    categories: result.categoryCount,
    items: result.itemCount,
    itemsMarkedDeleted: missingItemIds.length,
    categoriesMarkedDeleted: missingCategoryIds.length,
  });
}

async function main() {
  const arg = process.argv[2];
  const merchants = arg
    ? [{ cloverMerchantId: arg }]
    : (await getConnectedMerchants()).map((m) => ({ cloverMerchantId: m.cloverMerchantId }));

  if (merchants.length === 0) {
    console.log("No connected merchants to reconcile.");
    return;
  }

  for (const { cloverMerchantId } of merchants) {
    try {
      await reconcileMerchant(cloverMerchantId);
    } catch (err) {
      logger.error("Reconciliation failed for merchant", {
        cloverMerchantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([pool.end(), closeAvailabilityCache()]));
