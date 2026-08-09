/**
 * GAP-3 verification: sets up real tax-rate-bearing sandbox items and
 * confirms our expected total (mapCartToCloverOrder + computeExpectedTax)
 * matches Clover's actual order total exactly, for both a single shared tax
 * rate across repeated lines and multiple distinct rates in one order.
 *
 *   pnpm test-clover-tax
 *
 * Idempotent: looks up its fixtures by name before creating them, so re-runs
 * don't pile up duplicate tax rates/items in the sandbox catalog.
 *
 * Requires in .env: CLOVER_PILOT_MERCHANT_ID, CLOVER_PILOT_API_TOKEN.
 */
import "dotenv/config";
import { cloverRequest } from "../clover/client/httpClient";
import { cloverConfig, pilotCredentials } from "../clover/config";
import { createAtomicOrder, getOrder } from "../clover/orders/createAtomicOrder";
import { fetchItemTaxRates } from "../clover/tax/fetchItemTaxRates";
import { mapCartToCloverOrder, type InternalOrderLine } from "../orders/order-gateway/mapCartToCloverOrder";

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

async function findOrCreateTaxRate(mid: string, name: string, rate: number): Promise<{ id: string }> {
  const existing = await cloverRequest<{ elements: { id: string; name: string }[] }>(mid, mid, "/tax_rates");
  const found = existing.elements.find((r) => r.name === name);
  if (found) return found;
  return cloverRequest(mid, mid, "/tax_rates", { method: "POST", body: { name, rate, isDefault: false } });
}

async function findOrCreateItem(
  mid: string,
  name: string,
  priceCents: number,
  taxRateId: string,
): Promise<{ id: string }> {
  const existing = await cloverRequest<{ elements: { id: string; name: string }[] }>(mid, mid, "/items", {
    query: { filter: `name=${name}` },
  });
  const found = existing.elements[0];
  const item = found ?? (await cloverRequest<{ id: string }>(mid, mid, "/items", {
    method: "POST",
    body: { name, price: priceCents, priceType: "FIXED", defaultTaxRates: false },
  }));

  const withRates = await cloverRequest<{ taxRates?: { elements: { id: string }[] } }>(mid, mid, `/items/${item.id}`, {
    query: { expand: "taxRates" },
  });
  const alreadyLinked = withRates.taxRates?.elements.some((r) => r.id === taxRateId);
  if (!alreadyLinked) {
    await cloverRequest(mid, mid, "/tax_rate_items", {
      method: "POST",
      body: { elements: [{ item: { id: item.id }, taxRate: { id: taxRateId } }] },
    });
  }
  return item;
}

async function runCase(
  mid: string,
  label: string,
  lines: InternalOrderLine[],
  prediction: string,
): Promise<boolean> {
  console.log(`\n── ${label} ──`);
  console.log(`  prediction: ${prediction}`);

  for (const line of lines) {
    line.taxRates = await fetchItemTaxRates(mid, mid, line.cloverItemId);
  }

  const mapped = mapCartToCloverOrder({ lines, source: "website" });
  const created = await createAtomicOrder(mid, mid, mapped.request);
  const fetched = await getOrder(mid, mid, created.id);

  const pass = fetched.total === mapped.expectedTotalCents;
  console.log(`  expected: ${money(mapped.expectedTotalCents)} (subtotal ${money(mapped.expectedSubtotalCents)} + tax ${money(mapped.expectedTaxCents)})`);
  console.log(`  clover:   ${money(fetched.total)}`);
  console.log(`  ${pass ? "PASS" : "FAIL"} (order ${created.id})`);
  return pass;
}

async function main() {
  const mid = pilotCredentials.cloverMerchantId ?? cloverConfig.sandboxMerchantId;
  if (!mid) throw new Error("Set CLOVER_PILOT_MERCHANT_ID (or CLOVER_SANDBOX_MERCHANT_ID) in .env");
  if (!pilotCredentials.apiToken) throw new Error("Set CLOVER_PILOT_API_TOKEN in .env");

  const isSandbox = cloverConfig.apiHost.includes("sandbox");
  if (!isSandbox && !process.argv.includes("--allow-production")) {
    throw new Error(`CLOVER_API_HOST "${cloverConfig.apiHost}" is not a sandbox host. Re-run with --allow-production if intended.`);
  }

  console.log(`Clover host: ${cloverConfig.apiHost}`);
  console.log(`Merchant:    ${mid}`);

  // 7.3% chosen so a single $1.00 unit's tax (7.3c) is unambiguous when
  // rounded alone (7c) but distinguishable from the exact sum across many
  // units (73.0c for ten) -- see computeExpectedTax.ts for why this matters.
  const rateSingle = await findOrCreateTaxRate(mid, "GAP-3 Test Rate 7.3pct", 730000);
  const itemSingle = await findOrCreateItem(mid, "GAP-3 Test Item ($1.00, 7.3pct)", 100, rateSingle.id);

  const rateA = await findOrCreateTaxRate(mid, "GAP-3 Test Rate A 7.4pct", 740000);
  const itemA = await findOrCreateItem(mid, "GAP-3 Test Item A ($1.00, 7.4pct)", 100, rateA.id);
  const rateB = await findOrCreateTaxRate(mid, "GAP-3 Test Rate B 8.4pct", 840000);
  const itemB = await findOrCreateItem(mid, "GAP-3 Test Item B ($1.00, 8.4pct)", 100, rateB.id);

  const results: boolean[] = [];

  results.push(
    await runCase(
      mid,
      "Same rate, repeated lines (proves sum-then-round-per-group)",
      Array.from({ length: 10 }, () => ({
        cloverItemId: itemSingle.id,
        name: itemSingle.id,
        priceCents: 100,
        quantity: 1,
        modifiers: [],
      })),
      "round(10 * 7.3) = round(73.0) = 73c tax, NOT 10 * round(7.3) = 70c",
    ),
  );

  results.push(
    await runCase(
      mid,
      "Mixed rates in one order (proves rounding is per-rate-group, not global)",
      [
        { cloverItemId: itemA.id, name: itemA.id, priceCents: 100, quantity: 1, modifiers: [] },
        { cloverItemId: itemB.id, name: itemB.id, priceCents: 100, quantity: 1, modifiers: [] },
      ],
      "round(7.4) + round(8.4) = 7 + 8 = 15c tax, NOT round(7.4 + 8.4) = 16c",
    ),
  );

  console.log("\n────────────────────────────────────────────");
  const allPassed = results.every(Boolean);
  console.log(allPassed ? "ALL TAX CASES PASSED" : "SOME TAX CASES FAILED");
  console.log("────────────────────────────────────────────");
  if (!allPassed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
