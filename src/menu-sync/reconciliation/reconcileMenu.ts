import { getConnectedMerchants } from "../../clover/auth/tokenStore";
import { pool } from "../../db/pool";
import { logger } from "../../shared/logging/logger";
import { closeAvailabilityCache } from "../cache/availabilityCache";
import { getKnownCloverCategoryIds, getKnownCloverItemIds, markCategoryDeleted, markItemDeleted } from "./repository";
import { pullAndSyncMenu } from "./syncMenu";

// Defense against missed/failed webhook deliveries, which Clover doesn't
// guarantee. Re-pulls and upserts the whole menu (same as the manual sync),
// then marks anything in our DB that no longer showed up in the fresh pull
// as deleted -- the one thing webhook replay from thin payloads can't
// reliably tell us on its own.
//
// Exported (not just called from main() below) so reconcileLoop.ts can run
// this on a recurring interval as a persistent process, reusing the exact
// same logic the one-off/cron-invoked CLI below uses -- see that file for
// why a separate entrypoint rather than making this file loop by default.
export async function reconcileMerchant(cloverMerchantId: string): Promise<void> {
  const result = await pullAndSyncMenu(cloverMerchantId);

  // This is the signal for how reliable the webhook channel actually is: an
  // item's availabilityDrift entry here means Clover's real state differed
  // from what we already had cached BEFORE this poll ran, i.e. no webhook
  // (or a webhook that failed to process) had corrected it yet. Logged at
  // 'warn' specifically to stand out from the routine 'info' summary below --
  // every one of these during normal operation (no manual DB edits, no
  // process outage) represents a gap the webhook channel alone left open.
  for (const drift of result.availabilityDrift) {
    logger.warn("Reconciliation caught an availability change the webhook channel missed", {
      cloverMerchantId,
      cloverItemId: drift.cloverItemId,
      name: drift.name,
      previous: drift.previous,
      current: drift.current,
    });
  }

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
    availabilityDriftCaught: result.availabilityDrift.length,
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

// Only run as a one-shot CLI when invoked directly (`pnpm reconcile-menu`,
// or a cron entry) -- reconcileLoop.ts imports reconcileMerchant/main's
// per-merchant logic without wanting this file's own process lifecycle
// (pool.end() etc) to fire on import.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => Promise.all([pool.end(), closeAvailabilityCache()]));
}

export { main as reconcileAllConnectedMerchants };
