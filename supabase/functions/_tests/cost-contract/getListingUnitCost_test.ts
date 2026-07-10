// PF-1 regression (2026-06-17): the Deno mirror of getListingUnitCost
// previously returned 0 when cost=0 AND amount=0, silently producing a $0
// floor for the repricer. It must now return null (COST_MISSING) and stay
// in lock-step with the frontend helper in src/lib/cost-contract.ts.
//
// Run: deno test --allow-net --allow-env --allow-read \
//   supabase/functions/_tests/cost-contract/getListingUnitCost_test.ts

import { assertEquals, assertAlmostEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { getListingUnitCost } from '../../_shared/cost-contract.ts';

Deno.test('PF-1: cost=0 AND amount=0 returns null (was 0, the silent-$0 bug)', () => {
  assertEquals(getListingUnitCost({ cost: 0, amount: 0, units: 10 }), null);
});

Deno.test('PF-1: cost=0 AND amount=null AND units=10 returns null (no usable source)', () => {
  assertEquals(getListingUnitCost({ cost: 0, amount: null, units: 10 }), null);
});

Deno.test('positive amount still returned (preferred path unchanged)', () => {
  assertEquals(getListingUnitCost({ cost: 1520, amount: 15.2, units: 100 }), 15.2);
});

Deno.test('positive cost+units derives unit (fallback path unchanged)', () => {
  const u = getListingUnitCost({ cost: 1520, amount: null, units: 100 });
  assertAlmostEquals(u ?? -1, 15.2, 1e-9);
});

Deno.test('cost>0 AND units=0 returns null (no zero-division regression)', () => {
  assertEquals(getListingUnitCost({ cost: 100, amount: null, units: 0 }), null);
});

Deno.test('empty row returns null (no telemetry noise, no value)', () => {
  assertEquals(getListingUnitCost({}), null);
});

Deno.test('the 3 PF-1 production shapes (B01HOAK670 / B0888V5WVS / B07CS4TLCY) all return null', () => {
  // Real shape: cost=0, amount=0, units=0 — these are the 3 enabled+ruled
  // assignments with no fallback cost. Pre-fix they got $0; post-fix they
  // surface COST_MISSING so downstream null-checks kick in.
  assertEquals(getListingUnitCost({ cost: 0, amount: 0, units: 0 }), null);
});
