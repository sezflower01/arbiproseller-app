// Phase 1B – Self-Learning Proof: unnecessary-undercut tagger.
//
// Inspects a price-change decision in context and returns:
//   - was_unnecessary_undercut (bool)
//   - primary reason (single enum, kept for backward-compat with the existing
//     `unnecessary_undercut_reason` text column)
//   - all matched reasons (array → stored in the new
//     `unnecessary_undercut_reasons` jsonb column)
//
// A drop can satisfy MULTIPLE conditions at once (e.g. both "suppressed_bb"
// and "no_position_change"); we record every match so analytics can break the
// data down without losing information.
//
// All four conditions are evaluated:
//   1. already_lowest_fba       → user was already the cheapest eligible FBA
//   2. suppressed_bb            → no valid Buy Box on the listing
//   3. low_quality_competitor   → only competitor below us is filtered/low feedback
//   4. no_position_change       → after the cut we are still not the BB winner
//
// We try to be conservative: if data needed for a check is missing we DO NOT
// flag that condition (avoids false positives that would corrupt the metric).

export type UndercutReason =
  | "already_lowest_fba"
  | "suppressed_bb"
  | "low_quality_competitor"
  | "no_position_change";

export interface UndercutTagInput {
  oldPriceCents: number | null;
  newPriceCents: number;
  buyboxPriceCents: number | null;
  lowestFbaPriceCents: number | null;
  isBuyboxOwner: boolean;       // were WE the BB owner before this change?
  buyboxIsValid?: boolean | null; // null = unknown; false = suppressed/invalid
  lowestCompetitorIsFiltered?: boolean | null; // SP-API "filtered" / low-feedback
  // If we can know post-state (rare in scheduler — most often we have to infer
  // from the new vs old position), pass it here:
  isBuyboxOwnerAfterChange?: boolean | null;
}

export interface UndercutTagResult {
  was_unnecessary_undercut: boolean;
  primary_reason: UndercutReason | null;
  reasons: UndercutReason[];
}

/**
 * Priority ordering when picking the single "primary" enum. The earlier the
 * stronger / more defensible. Matches the Phase 1B marketing-claim ranking.
 */
const PRIORITY: UndercutReason[] = [
  "already_lowest_fba",
  "suppressed_bb",
  "no_position_change",
  "low_quality_competitor",
];

export function tagUnnecessaryUndercut(input: UndercutTagInput): UndercutTagResult {
  const reasons = new Set<UndercutReason>();

  // Only consider DOWNWARD price changes — raising can never be an undercut.
  if (input.oldPriceCents == null || input.newPriceCents >= input.oldPriceCents) {
    return { was_unnecessary_undercut: false, primary_reason: null, reasons: [] };
  }

  // 1. already_lowest_fba — user was already the cheapest eligible FBA before
  //    the cut (so going lower can't improve their FBA position).
  if (
    input.lowestFbaPriceCents != null &&
    input.oldPriceCents <= input.lowestFbaPriceCents
  ) {
    reasons.add("already_lowest_fba");
  }

  // 2. suppressed_bb — Buy Box reported invalid / no valid winner. Cutting in
  //    a suppressed market doesn't earn the Buy Box.
  if (
    input.buyboxIsValid === false ||
    (input.buyboxIsValid !== true && input.buyboxPriceCents == null)
  ) {
    // We require buyboxPriceCents == null AND buyboxIsValid not explicitly true
    // to avoid false positives on transient missing data. The explicit
    // buyboxIsValid === false is the strongest signal.
    if (input.buyboxIsValid === false) {
      reasons.add("suppressed_bb");
    }
  }

  // 3. low_quality_competitor — the only competitor strictly below us is
  //    filtered / low feedback. Matching them surrenders margin to a non-BB
  //    candidate.
  if (
    input.lowestCompetitorIsFiltered === true &&
    input.lowestFbaPriceCents != null &&
    input.oldPriceCents > input.lowestFbaPriceCents
  ) {
    reasons.add("low_quality_competitor");
  }

  // 4. no_position_change — after the cut we still aren't the BB winner. We
  //    only record this if the post-state is known. Otherwise we infer:
  //    if pre-state showed BB ownership AND newPrice still ≥ buybox, position
  //    did not improve.
  if (input.isBuyboxOwnerAfterChange === false && !input.isBuyboxOwner) {
    reasons.add("no_position_change");
  } else if (
    input.isBuyboxOwnerAfterChange == null &&
    !input.isBuyboxOwner &&
    input.buyboxPriceCents != null &&
    input.newPriceCents >= input.buyboxPriceCents
  ) {
    reasons.add("no_position_change");
  }

  const ordered = PRIORITY.filter((r) => reasons.has(r));
  return {
    was_unnecessary_undercut: ordered.length > 0,
    primary_reason: ordered[0] ?? null,
    reasons: ordered,
  };
}
