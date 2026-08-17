// Decide whether a newly detected listing is worth an automatic source search.
//
// Every rule here comes from probing 40 REAL detections through SP-API Catalog
// Items on 2026-08-16 (spapi-rank-probe), not from intuition. Two of the
// intuitive versions were measurably wrong and are called out below, because
// they are the ones a future edit is most likely to reintroduce.
//
// Extracted rather than inlined so the thresholds are testable without
// standing up an edge function -- see source-qualification_test.ts.

/** Lowercase verdicts as check-product-eligibility stores them. */
export type EligibilityVerdict = 'approved' | 'approval_required' | 'restricted';

export interface QualificationInput {
  /** SP-API summaries[].websiteDisplayGroupName. Top-level department. */
  productGroup?: string | null;
  /** SP-API salesRanks[].displayGroupRanks[].rank. The BROAD rank. */
  salesRank?: number | null;
  upc?: string | null;
  /**
   * From user_approved_products.approval_status -- the SAME rows that drive
   * the EligibilityBadge, so the filter and the UI cannot disagree.
   * undefined/null means "not checked yet", which is NOT a disqualification.
   */
  eligibility?: EligibilityVerdict | null;
  /** auto_source_config.search_needs_approval. Default true. */
  allowNeedsApproval?: boolean;
  /** SP-API summaries[].brand, falling back to manufacturer. */
  brand?: string | null;
  /**
   * Per-user overrides from source_excluded_terms, already lowercased.
   * Omitted means "use the built-in defaults", which is what keeps the Deno
   * tests and any caller that has not been updated behaving exactly as before.
   */
  excludedGroups?: ReadonlySet<string>;
  excludedBrands?: ReadonlySet<string>;
}

export interface QualificationResult {
  qualified: boolean;
  /** Machine-readable reason, null when qualified. Stored for auditing. */
  reason: string | null;
}

/**
 * Amazon's ACTUAL productGroup strings, which differ from how a person would
 * name these categories. The observed values were 'Book' (not "Books"), and
 * 'DVD' / 'Video' rather than any "Movies & TV". A list written from intuition
 * matches nothing at all -- that mistake was caught only by probing.
 *
 * 'Digital Text' is Kindle; 'Magazine' covers periodicals.
 */
export const EXCLUDED_PRODUCT_GROUPS = new Set([
  'book', 'digital text', 'magazine', 'music', 'digital music',
  'dvd', 'video', 'video dvd', 'blu-ray',
]);

/**
 * Placeholder brand values Amazon actually ships, matched EXACTLY.
 *
 * Deliberately short. 'Universal' and 'OEM' are excluded because they are real
 * brands (Universal Studios/Music; OEM as an automotive-parts label), and
 * substring matching is never used because "Publisher Unknown" -- a genuine
 * publisher observed in live data -- would be caught by a contains-'unknown'
 * rule while failing an exact one.
 */
export const EXCLUDED_BRANDS = new Set([
  'generic', 'unbranded', 'no brand', 'nobrand', 'unknown',
]);

/**
 * Broad-rank ceiling. Measured distribution: p25 28,335 / median 80,142 /
 * p75 511,275 / max 1,886,054. 500,000 trims roughly the worst quartile while
 * leaving the median comfortably through.
 *
 * Applied ONLY when a rank exists. 60% of detections carry no broad rank, and
 * excluding those would reject for missing data rather than for being bad --
 * a filter should act on evidence, not on its absence.
 */
export const MAX_SALES_RANK = 500_000;

export function qualifyListing(input: QualificationInput): QualificationResult {
  // Checked FIRST and unconditionally. A restricted ASIN cannot be sold at
  // any price, so no other property can redeem it -- and reporting
  // "restricted" rather than a downstream reason like no_upc tells the user
  // the actionable fact.
  if (input.eligibility === 'restricted') {
    return { qualified: false, reason: 'restricted' };
  }

  // Gated items stay searchable by default: they are often worth sourcing
  // before deciding whether to apply for approval. Opt-out only.
  if (input.eligibility === 'approval_required' && input.allowNeedsApproval === false) {
    return { qualified: false, reason: 'needs_approval_excluded' };
  }

  // Anything else -- 'approved', or no verdict yet -- falls through. Absence
  // of a verdict must never disqualify: most freshly detected ASINs have not
  // been checked, and treating unknown as restricted would silently empty the
  // queue. Same principle as the rank ceiling only applying when a rank exists.

  const group = (input.productGroup || '').trim().toLowerCase();
  const groups = input.excludedGroups ?? EXCLUDED_PRODUCT_GROUPS;
  if (group && groups.has(group)) {
    return { qualified: false, reason: `excluded_group:${group}` };
  }

  // EXACT match, never substring. Measured against live SP-API data on
  // 2026-08-17: "Publisher Unknown" is a real publisher, so `contains
  // "unknown"` would reject it. The same reasoning keeps 'Universal' and 'OEM'
  // out of the defaults entirely -- Universal Studios and Universal Music are
  // real brands, and OEM is a legitimate label on automotive parts.
  //
  // A MISSING brand is not a generic brand and never disqualifies. Of 20
  // listings stored with brand NULL, SP-API returned a real brand for all 20 --
  // the nulls were a lookup-coverage artefact, not a property of the product.
  // Same principle as the rank ceiling only applying when a rank exists.
  const brand = (input.brand || '').trim().toLowerCase();
  const brands = input.excludedBrands ?? EXCLUDED_BRANDS;
  if (brand && brands.has(brand)) {
    return { qualified: false, reason: `excluded_brand:${brand}` };
  }

  // Strongest single signal (48% of detections). Principled rather than
  // arbitrary: find-source-candidates searches UPC-first and degrades to
  // brand+title without one, which is precisely why untagged items come back
  // "no likely sources" after spending a full verification budget.
  if (!input.upc || !String(input.upc).trim()) {
    return { qualified: false, reason: 'no_upc' };
  }

  if (typeof input.salesRank === 'number' && input.salesRank > MAX_SALES_RANK) {
    return { qualified: false, reason: `rank_over_${MAX_SALES_RANK}:${input.salesRank}` };
  }

  return { qualified: true, reason: null };
}
