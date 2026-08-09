import "dotenv/config";
import { getConnectedMerchants } from "../../clover/auth/tokenStore";
import { pool } from "../../db/pool";
import { logger } from "../../shared/logging/logger";
import { closeAvailabilityCache } from "../cache/availabilityCache";
import { reconcileMerchant } from "./reconcileMenu";

// Runs reconcileMerchant on a recurring interval as a persistent process --
// the backup safety net for the webhook channel described in the
// architecture doc ("poll Clover's Inventory API every few minutes"). Reuses
// reconcileMenu.ts's exact per-merchant logic (drift detection, delete
// detection) rather than duplicating it; that file's own CLI stays a one-shot
// entrypoint for manual runs or an external cron, unaffected by this.
const INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS ?? 5 * 60 * 1000);
let stopping = false;

async function tick(): Promise<void> {
  const merchants = await getConnectedMerchants();
  for (const { cloverMerchantId } of merchants) {
    try {
      await reconcileMerchant(cloverMerchantId);
    } catch (err) {
      logger.error("Reconciliation loop tick failed for merchant", {
        cloverMerchantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function run(): Promise<void> {
  logger.info("Reconciliation loop started", { intervalMs: INTERVAL_MS });
  while (!stopping) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
  await Promise.all([pool.end(), closeAvailabilityCache()]);
}

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

run();
