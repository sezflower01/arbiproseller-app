// Tests for auto-source qualification.
//
// Cases are built from the ACTUAL probe output of 2026-08-16 rather than
// invented, so the thresholds stay anchored to observed data.
//
// Run:
//   deno test --allow-net --allow-env --allow-read \
//     supabase/functions/_shared/source-qualification_test.ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { qualifyListing, MAX_SALES_RANK } from './source-qualification.ts';

Deno.test('qualifies a ranked, UPC-bearing, non-media item', () => {
  // Skyrim PS4 from the probe: productGroup "Video Games", broad rank 4,540.
  const r = qualifyListing({ productGroup: 'Video Games', salesRank: 4540, upc: '093155171244' });
  assertEquals(r.qualified, true);
  assertEquals(r.reason, null);
});

Deno.test('excludes Amazon\'s real media group strings, not the intuitive ones', () => {
  for (const g of ['Book', 'DVD', 'Video', 'Music', 'Digital Text', 'Magazine']) {
    const r = qualifyListing({ productGroup: g, salesRank: 100, upc: '123456789012' });
    assertEquals(r.qualified, false, `${g} should be excluded`);
  }
});

Deno.test('group matching is case-insensitive', () => {
  assertEquals(qualifyListing({ productGroup: 'book', upc: '1' }).qualified, false);
  assertEquals(qualifyListing({ productGroup: 'BOOK', upc: '1' }).qualified, false);
});

Deno.test('non-media groups seen in the probe still pass', () => {
  for (const g of ['BISS Basic', 'Personal Computer', 'Toy', 'Kitchen', 'Sports', 'Home Improvement']) {
    const r = qualifyListing({ productGroup: g, salesRank: 50_000, upc: '123456789012' });
    assertEquals(r.qualified, true, `${g} should qualify`);
  }
});

Deno.test('missing UPC disqualifies -- search is UPC-first', () => {
  assertEquals(qualifyListing({ productGroup: 'Toy', salesRank: 100, upc: null }).reason, 'no_upc');
  assertEquals(qualifyListing({ productGroup: 'Toy', salesRank: 100, upc: '   ' }).reason, 'no_upc');
});

Deno.test('rank ceiling applies only when a rank EXISTS', () => {
  // 60% of real detections have no broad rank; absence must not disqualify.
  assertEquals(qualifyListing({ productGroup: 'Toy', salesRank: null, upc: '1234' }).qualified, true);
  assertEquals(qualifyListing({ productGroup: 'Toy', upc: '1234' }).qualified, true);
});

Deno.test('rank ceiling boundary', () => {
  assertEquals(qualifyListing({ productGroup: 'Toy', salesRank: MAX_SALES_RANK, upc: '1' }).qualified, true);
  assertEquals(qualifyListing({ productGroup: 'Toy', salesRank: MAX_SALES_RANK + 1, upc: '1' }).qualified, false);
});

Deno.test('observed p75/p90/max ranks are rejected, median accepted', () => {
  assertEquals(qualifyListing({ productGroup: 'Toy', salesRank: 80_142, upc: '1' }).qualified, true);   // median
  assertEquals(qualifyListing({ productGroup: 'Toy', salesRank: 511_275, upc: '1' }).qualified, false); // p75
  assertEquals(qualifyListing({ productGroup: 'Toy', salesRank: 1_886_054, upc: '1' }).qualified, false); // max
});

Deno.test('unknown product group does not disqualify on its own', () => {
  // 4/40 probed items returned no group; treat as unknown, not as excluded.
  assertEquals(qualifyListing({ productGroup: null, salesRank: 1000, upc: '1' }).qualified, true);
});

Deno.test('group exclusion is checked before UPC, so the reason is the useful one', () => {
  // A book with no UPC is excluded for BEING a book -- the actionable fact.
  assertEquals(qualifyListing({ productGroup: 'Book', upc: null }).reason, 'excluded_group:book');
});

Deno.test('restricted is excluded regardless of everything else', () => {
  // A perfect listing on every other axis still fails: it cannot be sold.
  const r = qualifyListing({
    productGroup: 'Toy', salesRank: 100, upc: '123456789012', eligibility: 'restricted',
  });
  assertEquals(r.qualified, false);
  assertEquals(r.reason, 'restricted');
});

Deno.test('restricted wins over other disqualifiers, so the reason is actionable', () => {
  // Also has no UPC. "restricted" is the fact worth surfacing -- fixing the
  // UPC would not make this searchable.
  assertEquals(qualifyListing({ eligibility: 'restricted', upc: null }).reason, 'restricted');
  assertEquals(qualifyListing({ eligibility: 'restricted', productGroup: 'Book' }).reason, 'restricted');
});

Deno.test('needs-approval qualifies by DEFAULT', () => {
  const r = qualifyListing({ productGroup: 'Toy', upc: '1', eligibility: 'approval_required' });
  assertEquals(r.qualified, true);
});

Deno.test('needs-approval is excluded only when the toggle is off', () => {
  const off = qualifyListing({
    productGroup: 'Toy', upc: '1', eligibility: 'approval_required', allowNeedsApproval: false,
  });
  assertEquals(off.qualified, false);
  assertEquals(off.reason, 'needs_approval_excluded');

  const on = qualifyListing({
    productGroup: 'Toy', upc: '1', eligibility: 'approval_required', allowNeedsApproval: true,
  });
  assertEquals(on.qualified, true);
});

Deno.test('the toggle does NOT affect restricted or approved', () => {
  assertEquals(qualifyListing({ upc: '1', eligibility: 'restricted', allowNeedsApproval: true }).reason, 'restricted');
  assertEquals(qualifyListing({ upc: '1', eligibility: 'approved', allowNeedsApproval: false }).qualified, true);
});

Deno.test('UNKNOWN eligibility never disqualifies', () => {
  // Most freshly detected ASINs have no verdict yet. Treating absence as
  // restricted would silently empty the queue.
  assertEquals(qualifyListing({ productGroup: 'Toy', upc: '1' }).qualified, true);
  assertEquals(qualifyListing({ productGroup: 'Toy', upc: '1', eligibility: null }).qualified, true);
  assertEquals(
    qualifyListing({ productGroup: 'Toy', upc: '1', eligibility: null, allowNeedsApproval: false }).qualified,
    true,
  );
});
