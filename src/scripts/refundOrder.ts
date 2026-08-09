/**
 * Issue a full refund for an order paid through the online checkout flow.
 *
 *   pnpm refund-order <cloverOrderId>
 *
 * <cloverOrderId> is the Platform atomic order id -- the same id printed on
 * the kitchen ticket and visible in the Clover dashboard's Orders view, NOT
 * our internal order uuid and NOT the Ecommerce charge id.
 */
import "dotenv/config";
import { pool } from "../db/pool";
import { refundOrderByCloverOrderId } from "../orders/order-gateway/refundOrder";

async function main() {
  const cloverOrderId = process.argv[2];
  if (!cloverOrderId) {
    throw new Error("Usage: pnpm refund-order <cloverOrderId>");
  }

  console.log(`Refunding Clover order ${cloverOrderId}...`);
  const result = await refundOrderByCloverOrderId(cloverOrderId);

  console.log("\n────────────────────────────────────────────");
  console.log(`Refund id:        ${result.refundId}`);
  console.log(`Our order id:     ${result.orderId}`);
  console.log(`Clover charge id: ${result.cloverChargeId}`);
  console.log(`Amount refunded:  $${(result.amountCents / 100).toFixed(2)}`);
  console.log("────────────────────────────────────────────");
  console.log("\nConfirm in the sandbox dashboard: Payments/Ecommerce section, or GET the charge/refund via the API.");
}

main()
  .catch((err) => {
    console.error("\nFAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
