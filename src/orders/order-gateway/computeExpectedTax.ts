import type { InternalOrderLine } from "./mapCartToCloverOrder";

export interface TaxRateRef {
  id: string;
  name?: string;
  /** Fixed-point: percentage * 100000 (725000 = 7.25%). See fetchItemTaxRates.ts. */
  rate: number;
}

export interface TaxBreakdownEntry {
  taxRateId: string;
  taxRateName?: string;
  /** Sum of taxable cents (price + modifiers, across all units) this rate applied to. */
  taxableCents: number;
  /** This rate's rounded contribution to the order's total tax. */
  taxCents: number;
}

export interface ExpectedTax {
  taxCents: number;
  breakdown: TaxBreakdownEntry[];
}

// Replicates Clover's own tax computation so our expected total can be
// compared bit-for-bit against what Clover returns, instead of guessed at.
//
// Confirmed empirically against the sandbox (2026-08-05):
//   - Clover groups by tax-rate id ACROSS THE WHOLE ORDER, sums the exact
//     (unrounded) tax contribution of every taxable cent in that group, and
//     rounds ONCE PER GROUP -- not per line item, not on the order's grand
//     total. 10x $1.00 lines all taxed at 7.3% totalled 73c tax (round of the
//     exact sum 73.0), not 70c (10 * round(7.3)). Two $1.00 lines taxed at
//     7.4% and 8.4% totalled 15c (round(7.4) + round(8.4)), not 16c
//     (round(7.4 + 8.4)) -- so mixed rates are NOT blended into one number
//     before rounding either.
//
// UNVERIFIED, flagged rather than guessed:
//   - The tie-break rule at an exact .5-cent boundary (round half up vs round
//     half to even). Nothing we could construct in the sandbox catalog landed
//     exactly on the boundary. This implementation uses round-half-up (the
//     common convention, and what Math.round does for positive numbers), but
//     callers MUST compare the result against Clover's actual returned total
//     rather than trust it blindly -- see submitOrder.ts, which logs an error
//     (not just a warning) on any mismatch.
//   - Whether a modifier's price is taxed at its parent line item's rate(s),
//     a rate of its own, or not at all. We assume "same as parent item" here;
//     nothing in the sandbox catalog let us configure a taxed modifier to
//     check. Orders with priced modifiers should be watched for the same
//     mismatch-logging above until this is confirmed.
export function computeExpectedTax(lines: InternalOrderLine[]): ExpectedTax {
  const groups = new Map<string, { rate: number; name?: string; taxableCents: number; rawTaxSum: number }>();

  for (const line of lines) {
    const rates = line.taxRates ?? [];
    if (rates.length === 0) continue;

    // Every unit of quantity becomes a separate Clover line item (see
    // mapCartToCloverOrder), each carrying its own copy of the modifiers, so
    // the taxable amount is (price + modifiers) once per unit of quantity.
    const perUnitTaxableCents = line.priceCents + line.modifiers.reduce((sum, m) => sum + m.priceCents, 0);
    const lineTaxableCents = perUnitTaxableCents * line.quantity;

    for (const rate of rates) {
      const group = groups.get(rate.id) ?? { rate: rate.rate, name: rate.name, taxableCents: 0, rawTaxSum: 0 };
      group.taxableCents += lineTaxableCents;
      // rawTaxSum accumulates taxableCents * rate as an integer (both inputs
      // are integers) so no fractional cent is lost to rounding before the
      // group total is known. Realistic cart sizes keep this well within
      // Number.MAX_SAFE_INTEGER (taxableCents ~10^5-10^6, rate ~10^6-10^7).
      group.rawTaxSum += lineTaxableCents * rate.rate;
      groups.set(rate.id, group);
    }
  }

  const breakdown: TaxBreakdownEntry[] = [];
  let taxCents = 0;
  for (const [taxRateId, group] of groups) {
    // rawTaxSum = taxableCents * (percent * 100000). Dividing by 100000 gives
    // taxableCents * percent; dividing by another 100 converts percent to a
    // fraction, landing in cents. Round once per group, matching Clover.
    const groupTaxCents = Math.round(group.rawTaxSum / 10_000_000);
    breakdown.push({
      taxRateId,
      taxRateName: group.name,
      taxableCents: group.taxableCents,
      taxCents: groupTaxCents,
    });
    taxCents += groupTaxCents;
  }

  return { taxCents, breakdown };
}
