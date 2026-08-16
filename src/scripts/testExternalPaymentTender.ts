/**
 * Sandbox verification for the external-payment-tender reconciliation path,
 * proposed for the pay-by-link (Hosted Checkout) feature: does recording a
 * payment via POST /v3/merchants/{mId}/orders/{orderId}/payments with the
 * com.clover.tender.external_payment tender actually make Clover treat the
 * order as paid/reconciled -- same empirical standard payOrder() was held to
 * before being trusted (see submitPaidOrder.ts's history comment).
 *
 *   pnpm tsx src/scripts/testExternalPaymentTender.ts
 *
 * Creates a real (small) unpaid order, looks up the external_payment tender,
 * posts a payment record for the full total, then reads the order back
 * (expand=payments) and prints everything relevant to judge reconciliation.
 */
import "dotenv/config";
import { cloverConfig, pilotCredentials } from "../clover/config";
import { cloverRequest } from "../clover/client/httpClient";
import { createAtomicOrder, listInventoryItems } from "../clover/orders/createAtomicOrder";

function money(cents: number | undefined): string {
  return cents === undefined ? "n/a" : `$${(cents / 100).toFixed(2)}`;
}

interface Tender {
  id: string;
  label?: string;
  labelKey?: string;
}

async function main() {
  const cloverMerchantId = pilotCredentials.cloverMerchantId ?? cloverConfig.sandboxMerchantId;
  if (!cloverMerchantId) throw new Error("Set CLOVER_PILOT_MERCHANT_ID (or CLOVER_SANDBOX_MERCHANT_ID) in .env");

  const isSandbox = cloverConfig.apiHost.includes("sandbox");
  if (!isSandbox && !process.argv.includes("--allow-production")) {
    throw new Error(`CLOVER_API_HOST is "${cloverConfig.apiHost}", not sandbox. Refusing to run.`);
  }

  console.log(`Clover host: ${cloverConfig.apiHost}`);
  console.log(`Merchant:    ${cloverMerchantId}\n`);

  // ── 1. Find the external_payment tender ──────────────────────────────────
  console.log("1. Fetching tenders…");
  const tendersResp = await cloverRequest<{ elements: Tender[] }>(cloverMerchantId, cloverMerchantId, "/tenders");
  for (const t of tendersResp.elements) {
    console.log(`   - ${t.id}  label=${t.label ?? "?"}  labelKey=${t.labelKey ?? "?"}`);
  }
  const externalTender = tendersResp.elements.find((t) => t.labelKey === "com.clover.tender.external_payment");
  if (!externalTender) {
    throw new Error("No tender with labelKey com.clover.tender.external_payment found on this merchant.");
  }
  console.log(`\n   Using tender: ${externalTender.id} (${externalTender.label})\n`);

  // ── 2. Create a small real order (unpaid) ────────────────────────────────
  console.log("2. Creating a test order…");
  const items = (await listInventoryItems(cloverMerchantId, cloverMerchantId, 5)).filter((i) => !i.hidden);
  if (items.length === 0) throw new Error("No visible inventory items to order.");
  const item = items[0];
  console.log(`   1x ${item.name} @ ${money(item.price)}`);

  const created = await createAtomicOrder(cloverMerchantId, cloverMerchantId, {
    orderCart: {
      state: "open",
      lineItems: [{ item: { id: item.id } }],
      note: "Frontline external-payment-tender reconciliation test",
    },
  });
  console.log(`   Created order ${created.id}, total ${money(created.total)}\n`);

  // ── 3. Record the external payment ───────────────────────────────────────
  console.log("3. POST /orders/{orderId}/payments …");
  const paymentResult = await cloverRequest(cloverMerchantId, cloverMerchantId, `/orders/${created.id}/payments`, {
    method: "POST",
    body: {
      tender: { id: externalTender.id },
      amount: created.total,
    },
  });
  console.log("   Response:", JSON.stringify(paymentResult, null, 2), "\n");

  // ── 4. Read the order back, expanding payments ───────────────────────────
  console.log("4. Reading the order back (expand=lineItems,payments)…");
  const fetched = await cloverRequest<Record<string, unknown>>(
    cloverMerchantId,
    cloverMerchantId,
    `/orders/${created.id}`,
    { query: { expand: "lineItems,payments" } },
  );
  console.log("\n────────────────────────────────────────────");
  console.log(`ORDER ID:  ${created.id}`);
  console.log(`total:     ${money(created.total)}`);
  console.log("Full order object:");
  console.log(JSON.stringify(fetched, null, 2));
  console.log("────────────────────────────────────────────");
  console.log(
    `\nCheck it in the dashboard too: https://${cloverConfig.apiHost.replace("api", "sandbox")}/v3/merchants/${cloverMerchantId}/orders/${created.id}`,
  );
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
