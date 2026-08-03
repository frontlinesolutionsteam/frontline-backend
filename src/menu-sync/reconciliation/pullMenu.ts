import { cloverConfig } from "../../clover/config";
import { pool } from "../../db/pool";
import { closeAvailabilityCache } from "../cache/availabilityCache";
import { pullAndSyncMenu } from "./syncMenu";

async function main(cloverMerchantId: string) {
  console.log(`Pulling menu for Clover merchant ${cloverMerchantId}`);
  const result = await pullAndSyncMenu(cloverMerchantId);
  console.log(`  categories: ${result.categoryCount}`);
  console.log(`  modifier groups: ${result.modifierGroupCount} (${result.modifierCount} modifiers)`);
  console.log(`  items: ${result.itemCount}`);
  console.log("Menu pull complete.");
}

const cloverMerchantId = process.argv[2] ?? cloverConfig.sandboxMerchantId;
if (!cloverMerchantId) {
  console.error("Usage: npm run sync-menu -- <cloverMerchantId>  (or set CLOVER_SANDBOX_MERCHANT_ID)");
  process.exit(1);
}

main(cloverMerchantId)
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([pool.end(), closeAvailabilityCache()]));
