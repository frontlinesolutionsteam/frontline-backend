/**
 * GAP-4 verification: submits the same logical checkout twice through the
 * real submitOrder() path (Postgres + Redis + Clover sandbox, no shortcuts)
 * and confirms only one Clover order results.
 *
 *   pnpm test-clover-idempotency
 *
 * Unlike testSandboxOrder.ts, this goes through the full order gateway --
 * catalog lookup, availability check, customer match/create, draft-order
 * insert, and the Clover call -- because idempotency is enforced at that
 * layer (submitOrder + repository.ts), not in the Clover client. It uses
 * whichever merchant is already connected in the local DB and pointed at the
 * Clover sandbox merchant, seeded with real catalog items via menu sync.
 *
 * Requires: local Postgres (DATABASE_URL) and Redis (REDIS_URL) reachable,
 * a connected merchant row with synced items, and Clover credentials
 * resolvable for that merchant (pilot env, API token, or OAuth).
 */
import "dotenv/config";
import crypto from "node:crypto";
import { pool } from "../db/pool";
import { closeAvailabilityCache } from "../menu-sync/cache/availabilityCache";
import { submitOrder, type SubmitOrderInput } from "../orders/order-gateway/submitOrder";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function pickMerchantAndItem(): Promise<{
  merchantId: string;
  cloverMerchantId: string;
  itemName: string;
}> {
  const overrideMerchantId = arg("merchant-id");
  const { rows: merchantRows } = await pool.query(
    overrideMerchantId
      ? `SELECT id, clover_merchant_id FROM merchants WHERE id = $1`
      : `SELECT id, clover_merchant_id FROM merchants WHERE status = 'connected' ORDER BY created_at LIMIT 1`,
    overrideMerchantId ? [overrideMerchantId] : [],
  );
  if (merchantRows.length === 0) {
    throw new Error("No connected merchant found in the local DB. Pass --merchant-id=<uuid> or sync one first.");
  }
  const merchant = merchantRows[0];

  const { rows: itemRows } = await pool.query(
    `SELECT name FROM items WHERE merchant_id = $1 AND available = true AND hidden = false LIMIT 1`,
    [merchant.id],
  );
  if (itemRows.length === 0) {
    throw new Error(`Merchant ${merchant.id} has no available items synced locally. Run menu sync first.`);
  }

  return { merchantId: merchant.id, cloverMerchantId: merchant.clover_merchant_id, itemName: itemRows[0].name };
}

async function main() {
  const { merchantId, cloverMerchantId } = await pickMerchantAndItem();
  const { rows: itemRows } = await pool.query(
    `SELECT id, name, price_cents FROM items WHERE merchant_id = $1 AND available = true AND hidden = false LIMIT 1`,
    [merchantId],
  );
  const item = itemRows[0];

  const idempotencyKey = crypto.randomUUID();
  const testPhone = `+1555${Math.floor(1000000 + Math.random() * 8999999)}`; // fresh customer each run

  const input: SubmitOrderInput = {
    merchantId,
    cloverMerchantId,
    items: [{ itemId: item.id, quantity: 1 }],
    customer: { phone: testPhone, firstName: "Idempotency", lastName: "Test" },
    source: "website",
    requestedTime: "ASAP",
    note: "Frontline idempotency probe",
    idempotencyKey,
  };

  console.log(`Merchant:         ${merchantId} (Clover ${cloverMerchantId})`);
  console.log(`Item:             ${item.name} ($${(item.price_cents / 100).toFixed(2)})`);
  console.log(`Idempotency key:  ${idempotencyKey}\n`);

  console.log("1. First submitOrder() call…");
  const t1 = Date.now();
  const first = await submitOrder(input);
  console.log(`   orderId=${first.orderId} cloverOrderId=${first.cloverOrderId} status=${first.status} (${Date.now() - t1}ms)`);

  console.log("\n2. Second submitOrder() call, SAME idempotency key (simulates a client retry)…");
  const t2 = Date.now();
  const second = await submitOrder(input);
  console.log(`   orderId=${second.orderId} cloverOrderId=${second.cloverOrderId} status=${second.status} (${Date.now() - t2}ms)`);

  console.log("\n3. Checking how many order rows exist for this idempotency key…");
  const { rows: dbRows } = await pool.query(
    `SELECT id, clover_order_id, status FROM orders WHERE merchant_id = $1 AND idempotency_key = $2`,
    [merchantId, idempotencyKey],
  );
  console.log(`   ${dbRows.length} row(s) in our orders table`);

  console.log("\n────────────────────────────────────────────");
  const sameOrderId = first.orderId === second.orderId;
  const sameCloverOrderId = first.cloverOrderId === second.cloverOrderId;
  const oneDbRow = dbRows.length === 1;

  console.log(`Same internal order id:   ${sameOrderId ? "PASS" : "FAIL"} (${first.orderId} vs ${second.orderId})`);
  console.log(`Same Clover order id:     ${sameCloverOrderId ? "PASS" : "FAIL"} (${first.cloverOrderId} vs ${second.cloverOrderId})`);
  console.log(`Exactly one DB row:       ${oneDbRow ? "PASS" : "FAIL"} (found ${dbRows.length})`);
  console.log("────────────────────────────────────────────");

  if (!sameOrderId || !sameCloverOrderId || !oneDbRow) {
    console.log("\nFAILED: the second call did not short-circuit -- a duplicate Clover order may exist.");
    console.log(`Check manually: https://apisandbox.dev.clover.com/v3/merchants/${cloverMerchantId}/orders`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nPASSED: retrying the same checkout produced exactly one Clover order (${first.cloverOrderId}).`);
}

main()
  .catch((err) => {
    console.error("\nFAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAvailabilityCache();
    await pool.end();
  });
