// Regression test for VERIFIED BUG (2026-06-17):
// repricer-evaluate FBM fallback previously read `created_listings.cost`
// (batch total) as if it were per-unit cost, inflating the ROI floor by Nx
// for any FBM ASIN without an inventory row.
//
// Run: deno test --allow-net --allow-env --allow-read \
//   supabase/functions/_tests/repricer-evaluate/fbm_cost_resolver_test.ts

import { assertEquals, assertAlmostEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveFbmUnitCost } from '../../_shared/fbm-cost-resolver.ts';

Deno.test('canonical row from incident (cost=125, amount=12.5, units=10) → unit cost MUST be 12.5, NOT 125', () => {
  const r = resolveFbmUnitCost({ cost: 125, amount: 12.5, units: 10 });
  assertEquals(r.unitCost, 12.5, 'unit cost must be per-unit, never batch total');
  assertEquals(r.path, 'amount');
});

Deno.test('large-batch row (cost=870.78, amount=6.91, units=126) → prefers amount', () => {
  const r = resolveFbmUnitCost({ cost: 870.78, amount: 6.910952380952381, units: 126 });
  assertEquals(r.path, 'amount');
  assertAlmostEquals(r.unitCost ?? -1, 6.910952380952381, 1e-9);
});

Deno.test('amount missing but cost+units present → derives per-unit via cost/units', () => {
  const r = resolveFbmUnitCost({ cost: 125, amount: null, units: 10 });
  assertEquals(r.path, 'cost_div_units');
  assertEquals(r.unitCost, 12.5);
});

Deno.test('amount and units both missing → falls back to raw cost (legacy single-unit rows only)', () => {
  const r = resolveFbmUnitCost({ cost: 12.5, amount: null, units: null });
  assertEquals(r.path, 'raw_cost');
  assertEquals(r.unitCost, 12.5);
});

Deno.test('anomalous schema row (amount == cost, units > 1) → still resolves to amount (per-unit) NOT cost (would be wrong)', () => {
  // Real production example: ASIN B07DPWR6ZQ stored cost=30.22, amount=30.22, units=20.
  // The writer put the per-unit cost into BOTH columns; preferring `amount`
  // happens to be correct because amount IS per-unit by contract.
  const r = resolveFbmUnitCost({ cost: 30.22, amount: 30.22, units: 20 });
  assertEquals(r.path, 'amount');
  assertEquals(r.unitCost, 30.22);
});

Deno.test('zero/negative values are rejected at every tier', () => {
  assertEquals(resolveFbmUnitCost({ cost: 0, amount: 0, units: 10 }).path, 'none');
  assertEquals(resolveFbmUnitCost({ cost: -5, amount: -1, units: 10 }).path, 'none');
  assertEquals(resolveFbmUnitCost({ cost: 100, amount: null, units: 0 }).path, 'raw_cost');
});

Deno.test('all-null row returns null with path=none', () => {
  const r = resolveFbmUnitCost({ cost: null, amount: null, units: null });
  assertEquals(r.unitCost, null);
  assertEquals(r.path, 'none');
});

Deno.test('string inputs (Supabase numeric → string in some clients) are coerced safely', () => {
  const r = resolveFbmUnitCost({ cost: '125', amount: '12.5', units: '10' });
  assertEquals(r.unitCost, 12.5);
  assertEquals(r.path, 'amount');
});
