import { cloverRequest } from "../client/httpClient";

export interface CloverTaxRate {
  id: string;
  name: string;
  // Fixed-point: percentage * 100000 (e.g. 725000 = 7.25%). Confirmed
  // empirically against the sandbox 2026-08-05: a $6.50 item with a rate of
  // 725000 taxed at exactly 47 cents (650 * 0.0725 = 47.125 -> 47).
  rate: number;
}

interface CacheEntry {
  rates: CloverTaxRate[];
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

// Tax rates change rarely, so a lightweight in-process TTL cache avoids a
// Clover round-trip per line item on every checkout. Deliberately NOT part of
// the menu-sync pipeline (out of scope for this change) and holds nothing in
// Postgres -- this only saves calls within one server process's lifetime.
//
// `GET /items/{id}?expand=taxRates` resolves the item's *effective* tax
// rate(s) regardless of whether they came from an explicit tax_rate_items
// association or from the item's `defaultTaxRates: true` flag -- confirmed
// empirically, so callers don't need to special-case either configuration.
export async function fetchItemTaxRates(
  merchantId: string,
  cloverMerchantId: string,
  cloverItemId: string,
): Promise<CloverTaxRate[]> {
  const cacheKey = `${cloverMerchantId}:${cloverItemId}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.rates;
  }

  const item = await cloverRequest<{ taxRates?: { elements: CloverTaxRate[] } }>(
    merchantId,
    cloverMerchantId,
    `/items/${cloverItemId}`,
    { query: { expand: "taxRates" } },
  );
  const rates = item.taxRates?.elements ?? [];
  cache.set(cacheKey, { rates, expiresAt: Date.now() + CACHE_TTL_MS });
  return rates;
}

export function clearItemTaxRateCache(): void {
  cache.clear();
}
