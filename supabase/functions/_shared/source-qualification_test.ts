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

// ---- brand exclusion -------------------------------------------------------
// Every case below is drawn from live SP-API data observed 2026-08-17, because
// the intuitive version of this rule (substring match, treat null as generic)
// is wrong in both directions and is exactly what a future edit would restore.

Deno.test('excludes placeholder brands, matched exactly', () => {
  for (const b of ['Generic', 'generic', '  Unbranded  ', 'No Brand', 'NoBrand', 'Unknown']) {
    const r = qualifyListing({ productGroup: 'Toy', upc: '1', brand: b });
    assertEquals(r.qualified, false, `${b} should be excluded`);
    assertEquals(r.reason?.startsWith('excluded_brand:'), true);
  }
});

Deno.test('NEVER substring-matches a brand', () => {
  // "Publisher Unknown" is a real publisher seen in live data. A
  // contains-'unknown' rule rejects it; an exact match must not.
  // productGroup deliberately NOT 'Book' here: Book is itself an excluded
  // category, so it would mask whatever the brand rule did.
  assertEquals(qualifyListing({ productGroup: 'Toy', upc: '1', brand: 'Publisher Unknown' }).qualified, true);
  assertEquals(qualifyListing({ productGroup: 'Toy', upc: '1', brand: 'Generic Electric' }).qualified, true);
  assertEquals(qualifyListing({ productGroup: 'Toy', upc: '1', brand: 'Unbranded Co.' }).qualified, true);
});

Deno.test('real brands with generic-sounding names survive', () => {
  // Deliberately absent from the defaults: Universal Studios / Universal Music
  // are real brands, and OEM is a legitimate automotive-parts label.
  for (const b of ['Universal', 'OEM', 'Universal Music', 'None The Richer']) {
    assertEquals(qualifyListing({ productGroup: 'Toy', upc: '1', brand: b }).qualified, true, `${b} must survive`);
  }
});

Deno.test('a MISSING brand never disqualifies', () => {
  // Measured: of 20 listings stored with brand NULL, SP-API returned a real
  // brand for 20 of 20. Null is a coverage artefact, not "unbranded".
  assertEquals(qualifyListing({ productGroup: 'Toy', upc: '1', brand: null }).qualified, true);
  assertEquals(qualifyListing({ productGroup: 'Toy', upc: '1', brand: '   ' }).qualified, true);
  assertEquals(qualifyListing({ productGroup: 'Toy', upc: '1' }).qualified, true);
});

Deno.test('per-user lists override the built-in defaults', () => {
  // User removed 'generic' and added 'acme'.
  const brands = new Set(['acme']);
  assertEquals(qualifyListing({ productGroup: 'Toy', upc: '1', brand: 'Generic', excludedBrands: brands }).qualified, true);
  assertEquals(qualifyListing({ productGroup: 'Toy', upc: '1', brand: 'ACME', excludedBrands: brands }).reason, 'excluded_brand:acme');

  // User no longer excludes Book, but does exclude Toy.
  const groups = new Set(['toy']);
  assertEquals(qualifyListing({ productGroup: 'Book', upc: '1', excludedGroups: groups }).qualified, true);
  assertEquals(qualifyListing({ productGroup: 'Toy', upc: '1', excludedGroups: groups }).reason, 'excluded_group:toy');
});

// ── Title keyword exclusions ──

const OK = { productGroup: 'Toy', upc: '1' };

Deno.test('a title keyword disqualifies and the reason names the term', () => {
  const r = qualifyListing({ ...OK, title: 'Pokémon TCG Elite Trainer Box', excludedTitleTerms: ['pokemon'] });
  assertEquals(r.qualified, false);
  assertEquals(r.reason, 'excluded_title:pokemon');
});

Deno.test('word boundary applies here too, not just in the helper', () => {
  // The false positive that would silently over-exclude.
  assertEquals(
    qualifyListing({ ...OK, title: 'Standing Desk Converter', excludedTitleTerms: ['stand'] }).qualified,
    true,
  );
});

Deno.test('no title rules configured excludes nothing', () => {
  // Unlike brands and groups there is NO built-in default list, so an omitted
  // or empty set must be a no-op rather than falling back to something.
  assertEquals(qualifyListing({ ...OK, title: 'Pokémon TCG' }).qualified, true);
  assertEquals(qualifyListing({ ...OK, title: 'Pokémon TCG', excludedTitleTerms: [] }).qualified, true);
});

Deno.test('a MISSING title never disqualifies', () => {
  assertEquals(qualifyListing({ ...OK, title: null, excludedTitleTerms: ['pokemon'] }).qualified, true);
  assertEquals(qualifyListing({ ...OK, excludedTitleTerms: ['pokemon'] }).qualified, true);
});

Deno.test('restricted still outranks a title rule', () => {
  const r = qualifyListing({
    ...OK, eligibility: 'restricted', title: 'Pokémon TCG', excludedTitleTerms: ['pokemon'],
  });
  assertEquals(r.reason, 'restricted');
});

Deno.test('the title rule is reported ahead of no_upc when both trip', () => {
  // The user's own rule is the actionable fact; no_upc is a technicality.
  const r = qualifyListing({ productGroup: 'Toy', title: 'Pokémon TCG', excludedTitleTerms: ['pokemon'] });
  assertEquals(r.reason, 'excluded_title:pokemon');
});
