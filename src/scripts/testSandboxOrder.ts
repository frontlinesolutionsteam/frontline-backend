/**
 * End-to-end sandbox check for the Clover order pipeline.
 *
 *   pnpm test-clover-order
 *
 * Builds a cart in our internal format, runs it through the real mapping
 * layer, POSTs it as an atomic order, then reads the order back and prints the
 * Clover order id. Deliberately touches no Postgres and no Redis -- it proves
 * the credentials, the mapping and the Clover call, nothing else.
 *
 * Requires in .env:
 *   CLOVER_PILOT_MERCHANT_ID   sandbox test merchant id
 *   CLOVER_PILOT_API_TOKEN     merchant-generated Platform API token
 */
import "dotenv/config";
import { resolveAccessToken } from "../clover/auth/resolveAccessToken";
import { cloverConfig, pilotCredentials } from "../clover/config";
import { createAtomicOrder, getOrder, listInventoryItems } from "../clover/orders/createAtomicOrder";
import { fetchItemTaxRates } from "../clover/tax/fetchItemTaxRates";
import { mapCartToCloverOrder, type InternalOrderLine } from "../orders/order-gateway/mapCartToCloverOrder";

function money(cents: number | undefined): string {
  return cents === undefined ? "n/a" : `$${(cents / 100).toFixed(2)}`;
}

async function main() {
  const cloverMerchantId = pilotCredentials.cloverMerchantId ?? cloverConfig.sandboxMerchantId;

  if (!cloverMerchantId) {
    throw new Error("Set CLOVER_PILOT_MERCHANT_ID (or CLOVER_SANDBOX_MERCHANT_ID) in .env");
  }
  if (!pilotCredentials.apiToken) {
    throw new Error(
      "Set CLOVER_PILOT_API_TOKEN in .env -- generate it in the Clover Dashboard under " +
        "Account & Setup > API Tokens with Orders R/W, Inventory R, Customers R/W.",
    );
  }

  // This script creates real orders on whatever merchant it points at. Refuse
  // to run against production unless someone very deliberately overrides it.
  const isSandbox = cloverConfig.apiHost.includes("sandbox");
  if (!isSandbox && !process.argv.includes("--allow-production")) {
    throw new Error(
      `CLOVER_API_HOST is "${cloverConfig.apiHost}", which is not a sandbox host. ` +
        `This script creates a real order. Re-run with --allow-production if that is intended.`,
    );
  }

  console.log(`Clover host:     ${cloverConfig.apiHost}`);
  console.log(`Merchant:        ${cloverMerchantId}`);
  const { source } = await resolveAccessToken(cloverMerchantId, cloverMerchantId);
  console.log(`Auth source:     ${source}\n`);

  // ── 1. Find real inventory to order ──────────────────────────────────────
  console.log("1. Fetching inventory…");
  const items = (await listInventoryItems(cloverMerchantId, cloverMerchantId, 25)).filter((i) => !i.hidden);
  if (items.length === 0) {
    throw new Error(`Merchant ${cloverMerchantId} has no visible inventory items to order.`);
  }
  console.log(`   ${items.length} item(s) available; using:`);

  const lines: InternalOrderLine[] = [
    {
      cloverItemId: items[0].id,
      name: items[0].name,
      priceCents: items[0].price,
      quantity: 2,
      note: "Frontline sandbox test - no cilantro",
      modifiers: [],
    },
  ];
  if (items[1]) {
    lines.push({
      cloverItemId: items[1].id,
      name: items[1].name,
      priceCents: items[1].price,
      quantity: 1,
      modifiers: [],
    });
  }
  for (const line of lines) {
    console.log(`   - ${line.quantity}x ${line.name} @ ${money(line.priceCents)}`);
  }

  // ── 2. Fetch tax rates, then map our cart into Clover's shape ────────────
  console.log("\n2. Fetching each item's effective tax rate(s)…");
  for (const line of lines) {
    line.taxRates = await fetchItemTaxRates(cloverMerchantId, cloverMerchantId, line.cloverItemId);
    const rateNames = line.taxRates.map((r) => `${r.name} (${(r.rate / 100000).toFixed(3)}%)`).join(", ") || "none";
    console.log(`   ${line.name}: ${rateNames}`);
  }

  console.log("\n3. Mapping cart → Clover atomic order…");
  const mapped = mapCartToCloverOrder({
    lines,
    source: "website",
    note: "Frontline pipeline test order",
    requestedTime: "ASAP",
  });
  console.log(`   ${mapped.request.orderCart.lineItems.length} Clover line item(s) from ${lines.length} cart line(s)`);
  console.log(`   our expected subtotal: ${money(mapped.expectedSubtotalCents)}`);
  console.log(`   our expected tax:      ${money(mapped.expectedTaxCents)}`);
  console.log(`   our expected total:    ${money(mapped.expectedTotalCents)}`);
  for (const warning of mapped.warnings) {
    console.log(`   ! ${warning}`);
  }

  // ── 4. Create the order ──────────────────────────────────────────────────
  console.log("\n4. POST /v3/merchants/{mId}/atomic_order/orders …");
  const created = await createAtomicOrder(cloverMerchantId, cloverMerchantId, mapped.request);

  // ── 5. Read it back ──────────────────────────────────────────────────────
  console.log("\n5. Reading the order back from Clover…");
  const fetched = await getOrder(cloverMerchantId, cloverMerchantId, created.id);
  // Clover's order response has no separate tax field -- see clover/types/order.ts.
  const cloverTaxCents = fetched.total - mapped.expectedSubtotalCents;
  const totalsMatch = fetched.total === mapped.expectedTotalCents;

  console.log("\n────────────────────────────────────────────");
  console.log(`CLOVER ORDER ID:  ${created.id}`);
  console.log(`state:            ${fetched.state}`);
  console.log(`line items:       ${fetched.lineItems?.elements.length ?? "n/a"}`);
  console.log(`expected total:   ${money(mapped.expectedTotalCents)} (subtotal ${money(mapped.expectedSubtotalCents)} + tax ${money(mapped.expectedTaxCents)})`);
  console.log(`clover total:     ${money(fetched.total)} (implied tax ${money(cloverTaxCents)})`);
  console.log(`match:            ${totalsMatch ? "PASS -- our expected total matches Clover exactly" : "MISMATCH -- see computeExpectedTax.ts for known gaps"}`);
  console.log("────────────────────────────────────────────");
  console.log(
    `\nConfirm it landed: Clover sandbox dashboard → Orders, or\n` +
      `  https://${cloverConfig.apiHost}/v3/merchants/${cloverMerchantId}/orders/${created.id}`,
  );

  if (!totalsMatch) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
