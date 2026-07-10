/**
 * Classification logic for Smart Engine Review.
 * Categorizes repricer price actions into review categories with judgments.
 */

import { translateGuardBadge } from "@/lib/repricerReasonTranslator";

export type ReviewCategory = "bb_loss" | "raised" | "constrained" | "floor_hit" | "winner";
export type Judgment = "correct" | "contextual_correct" | "needs_review";

export interface ClassificationResult {
  category: ReviewCategory;
  judgment: Judgment;
  judgmentReason: string;
  tuningSignals: string[];
  blockers: string[];
}

export function classifyAction(action: any, invData: any, recentForAsin: any[]): ClassificationResult {
  const intel = (action.intelligence_factors as Record<string, any>) || {};
  const trace = intel?.price_trace || {};
  const posProof = intel?.position_proof || {};
  const profitGuard = intel?.profit_guard || {};
  const guards: string[] = intel?.guards_applied || [];
  const delta = (action.new_price ?? 0) - (action.old_price ?? 0);

  // Determine category
  let category: ReviewCategory = "constrained";
  if (action.success === false || action.error_message) {
    category = "constrained";
  } else if (guards.includes("min_floor") || guards.includes("floor_clamp") || guards.includes("profit_guard_block")) {
    category = "floor_hit";
  } else if (posProof.buy_box_owner_is_me === false && delta < -0.005) {
    category = "bb_loss";
  } else if (delta > 0.005) {
    category = "raised";
  } else if (posProof.buy_box_owner_is_me === true && delta >= -0.005) {
    category = "winner";
  }

  const result: ClassificationResult = {
    category,
    judgment: "correct",
    judgmentReason: "",
    tuningSignals: [],
    blockers: [],
  };

  // Extract blockers from guards
  const blockerMap: Record<string, string> = {
    min_floor: "Min floor",
    floor_clamp: "Min floor",
    profit_guard_block: "Profit guard",
    profit_guard_warn: "Profit guard",
    bb_owner_hold: "Buy Box owner hold",
    bb_owner_protection: "Buy Box owner hold",
    fbm_gap_recapture_raise: "FBM gap recapture",
    fbm_gap_recapture: "FBM gap recapture",
    suppressed_bb_filtered_hold: "Suppressed BB filtered hold",
    already_lowest: "Already lowest",
    self_undercut: "Already lowest",
    lowest_filtered_fba: "Filtered FBM/low-quality",
    lowest_filtered: "Filtered FBM/low-quality",
    cooldown: "Cooldown",
    no_competitors: "No competitors",
    no_bb_data: "No competitor data",
    above_bb: "Above Buy Box",
    ceiling_clamp: "Max ceiling",
    max_ceiling: "Max ceiling",
  };

  for (const g of guards) {
    const gl = g.toLowerCase();
    for (const [key, label] of Object.entries(blockerMap)) {
      if (gl.includes(key)) {
        if (!result.blockers.includes(label)) result.blockers.push(label);
      }
    }
  }

  const hasLowestFbaProtection = guards.some((g: string) => g.toLowerCase().includes("lowest_filtered_fba") || g.toLowerCase().includes("lowest filtered"));
  const hasSelfUndercutGuard = guards.some((g: string) => g.toLowerCase().includes("already_lowest") || g.toLowerCase().includes("self_undercut"));
  const hasBbOwnerProtection = guards.some((g: string) => g.toLowerCase().includes("bb_owner_protection") || g.toLowerCase().includes("bb owner"));
  const isAboveBbHold = guards.some((g: string) => g.toLowerCase().includes("above_bb") || g.toLowerCase().includes("higher than the buy box"));

  // Category-specific judgment
  if (category === "bb_loss") {
    classifyBbLoss(result, action, invData, recentForAsin, posProof, trace, guards, hasSelfUndercutGuard, hasLowestFbaProtection);
  } else if (category === "floor_hit") {
    if (profitGuard.blocked) {
      result.judgment = "contextual_correct";
      result.judgmentReason = "Hold: below profit threshold — floor protection active";
      result.tuningSignals.push("Floor protection activated — verify floor price is still appropriate");
    } else {
      result.judgment = "correct";
      result.judgmentReason = "Correct: floor guard prevented unprofitable pricing";
      result.tuningSignals.push("Floor guard correctly prevented unprofitable pricing");
    }
  } else if (category === "raised") {
    const gap = (posProof.next_competitor_price ?? 0) - (action.new_price ?? 0);
    if (gap > 2) {
      result.judgment = "needs_review";
      result.judgmentReason = "Raise too conservative — large gap remaining";
      result.tuningSignals.push("Large gap to next competitor — raise may be too conservative");
    } else if (gap > 0.5) {
      result.judgment = "contextual_correct";
      result.judgmentReason = "Raise progressing — moderate gap remaining";
      result.tuningSignals.push("Moderate gap remaining — raise is progressing");
    } else {
      result.judgment = "correct";
      result.judgmentReason = "Optimal raise — margin captured near competitor ceiling";
      result.tuningSignals.push("Price raised optimally near competitor ceiling");
    }
  } else if (category === "winner") {
    result.judgment = "correct";
    result.judgmentReason = "Correct: stable BB ownership — price is optimal";
    result.tuningSignals.push("Winning Buy Box at competitive price — position is strong");
  } else if (category === "constrained" && Math.abs(delta) < 0.005) {
    classifyConstrained(result, action, invData, posProof, trace, guards, hasLowestFbaProtection, hasSelfUndercutGuard, hasBbOwnerProtection, isAboveBbHold);
  }

  // BB owner price discrepancy check
  const bbOwner = posProof.buy_box_owner_is_me ?? false;
  const currentPrice = action.new_price ?? invData?.my_price;
  const bbPrice = trace.buybox_price ?? null;
  if (bbOwner && currentPrice != null && bbPrice != null && currentPrice > bbPrice * 1.05) {
    if (result.judgment === "correct") {
      result.judgment = "contextual_correct";
      result.judgmentReason = "Hold: BB owner but price above snapshot — pending update";
    }
    result.tuningSignals.push("BB ownership confirmed but displayed price is significantly above BB — snapshot timing gap likely");
  }

  // Fallback signal
  if (result.tuningSignals.length === 0) {
    const myPrice = action.new_price ?? invData?.my_price;
    const bbPrice2 = trace.buybox_price ?? posProof.buybox_price;
    const profitFloor2 = trace.profit_guard?.floor ?? 0;
    if (myPrice != null && profitFloor2 > 0 && myPrice <= profitFloor2 * 1.02) {
      result.tuningSignals.push("Hold: near profit floor — limited room to maneuver");
    } else if (myPrice != null && bbPrice2 != null && myPrice > bbPrice2 * 1.15) {
      result.tuningSignals.push("Hold: priced out of BB — market too competitive at this cost");
    } else if (!bbPrice2 && !posProof.next_competitor_price) {
      result.tuningSignals.push("Hold: no competitor data — monitoring only");
    } else {
      result.tuningSignals.push("Stable — no tuning needed");
    }
  }

  if (!result.judgmentReason) {
    result.judgmentReason = result.judgment === "correct" ? "Correct" : "Needs review";
  }

  return result;
}

function classifyBbLoss(
  result: ClassificationResult, action: any, invData: any, recentForAsin: any[],
  posProof: any, trace: any, guards: string[],
  hasSelfUndercutGuard: boolean, hasLowestFbaProtection: boolean
) {
  const lowerActions = recentForAsin.filter(a => (a.new_price ?? 0) < (a.old_price ?? 0));
  const hasNoCompetitors = !posProof.next_competitor_price && (posProof.competitor_count ?? 0) <= 1;
  const isAtMax = guards.some((g: string) => g.toLowerCase().includes("at_max") || g.toLowerCase().includes("at max"));
  const bbSuppressed = !posProof.buybox_price && !trace.buybox_price;

  if (hasNoCompetitors && isAtMax) {
    result.judgment = "contextual_correct";
    result.judgmentReason = "Hold: at max price — no competitor signal, BB likely suppressed";
    result.tuningSignals.push("At max price with no visible competitors — BB may be suppressed or rotating");
  } else if (hasNoCompetitors && bbSuppressed) {
    result.judgment = "contextual_correct";
    result.judgmentReason = "Hold: Buy Box suppressed — no competitor data available";
    result.tuningSignals.push("Buy Box suppressed and no competitor data — hold is safest action");
  } else {
    const currentP = action.new_price ?? invData?.my_price ?? 0;
    const bbP = trace.buybox_price ?? posProof.buybox_price ?? 0;
    const minP = action.old_min_price ?? invData?.min_price ?? 0;
    const floor = trace.profit_guard?.floor ?? 0;
    const isUnprofitableMarket = bbP > 0 && currentP > 0 && (minP >= floor * 0.95 || currentP <= minP * 1.01) && currentP > bbP * 1.15;

    if (isUnprofitableMarket) {
      result.judgment = "contextual_correct";
      result.judgmentReason = "Hold: unprofitable market — no viable recapture";
      result.tuningSignals.push("BB is below cost/floor — market is not profitable to chase");
    } else if (lowerActions.length === 0) {
      const isFloorBlocked = guards.some((g: string) => g.toLowerCase().includes("floor_blocked") || g.toLowerCase().includes("floor blocked"));
      const isAboveBb = guards.some((g: string) => g.toLowerCase().includes("higher than the buy box") || g.toLowerCase().includes("above_bb"));
      if (hasSelfUndercutGuard || hasLowestFbaProtection) {
        result.judgment = "contextual_correct";
        result.judgmentReason = "Hold: already lowest FBA — self-undercut prevented";
        result.tuningSignals.push("Already lowest FBA seller — lowering further would be self-destructive");
      } else if (isFloorBlocked && isAboveBb) {
        result.judgment = "contextual_correct";
        result.judgmentReason = "Hold: floor prevents recapture — competitor outside viable range";
        result.tuningSignals.push("Floor blocks further lowering and BB is outside viable range — no pricing path available");
      } else if (isFloorBlocked) {
        result.judgment = "contextual_correct";
        result.judgmentReason = "Hold: floor prevents recapture — at minimum boundary";
        result.tuningSignals.push("Floor guard blocks lowering — already near minimum viable price");
      } else if (isAboveBb) {
        result.judgment = "contextual_correct";
        result.judgmentReason = "Hold: above BB but no viable pricing path";
        result.tuningSignals.push("Price above BB — constraints prevent recapture attempt");
      } else {
        result.judgment = "needs_review";
        result.judgmentReason = "Recapture slow — no competitive moves detected";
        result.tuningSignals.push("Recapture may be too slow — no competitive moves detected");
      }
    } else {
      result.judgment = "correct";
      result.judgmentReason = "Correct: BB loss detected, competitive response active";
      result.tuningSignals.push("BB loss detected and competitive response found");
    }
  }
}

function classifyConstrained(
  result: ClassificationResult, action: any, invData: any,
  posProof: any, trace: any, guards: string[],
  hasLowestFbaProtection: boolean, hasSelfUndercutGuard: boolean,
  hasBbOwnerProtection: boolean, isAboveBbHold: boolean
) {
  const hasMarketData = posProof.buybox_price != null || posProof.next_competitor_price != null || trace.buybox_price != null;

  if (hasLowestFbaProtection) {
    result.judgment = "contextual_correct";
    result.judgmentReason = "Hold: filtered competitor — not worth chasing";
    result.tuningSignals.push("BB winner is filtered (low quality / FBM) — holding is correct");
  } else if (hasSelfUndercutGuard) {
    result.judgment = "contextual_correct";
    result.judgmentReason = "Hold: already lowest — self-undercut prevented";
    result.tuningSignals.push("Already lowest seller — no safe downward move");
  } else if (hasBbOwnerProtection) {
    result.judgment = "correct";
    result.judgmentReason = "Correct: BB owner protected — no action needed";
    result.tuningSignals.push("BB owner protection — price is optimal");
  } else if (isAboveBbHold) {
    result.judgment = "contextual_correct";
    result.judgmentReason = "Hold: above BB but no safe recapture path";
    result.tuningSignals.push("Price above BB — engine holding due to constraints");
  } else if (!hasMarketData) {
    result.judgment = "contextual_correct";
    result.judgmentReason = "Hold: no competitor data available";
    result.tuningSignals.push("No competitor data — hold is the safest action");
  } else if ((action.new_price ?? invData?.my_price) != null && (trace.buybox_price ?? posProof.buybox_price) != null && (action.new_price ?? invData?.my_price ?? 0) > (trace.buybox_price ?? posProof.buybox_price ?? 0) * 1.2) {
    result.judgment = "contextual_correct";
    result.judgmentReason = "Hold: unprofitable market — no viable recapture";
    result.tuningSignals.push("Price significantly above BB — market is not profitable to chase");
  } else {
    const cPrice = action.new_price ?? invData?.my_price ?? 0;
    const cFloor = trace.profit_guard?.floor ?? 0;
    const cLowestFba = trace.lowest_fba ?? posProof.lowest_fba_price ?? 0;
    if (cFloor > 0 && cLowestFba > 0 && cPrice <= cFloor * 1.05 && cLowestFba < cPrice) {
      result.judgment = "contextual_correct";
      result.judgmentReason = "Hold: constrained by profit floor and competitor position";
      result.tuningSignals.push("Near profit floor with cheaper competitors — no room to maneuver");
    } else {
      result.judgment = "correct";
      result.judgmentReason = "Correct: stable position — no action needed";
      result.tuningSignals.push("Engine determined no action needed — position is optimal");
    }
  }
  if (guards.length > 0) {
    result.tuningSignals.push(`Constraints: ${guards.map(translateGuardBadge).join(", ")}`);
  }
}

// Category pool assignment for batch generation
export function categorizeActions(actions: any[]): Record<ReviewCategory, any[]> {
  const pools: Record<ReviewCategory, any[]> = {
    bb_loss: [], raised: [], constrained: [], floor_hit: [], winner: [],
  };
  const seen = new Set<string>();
  for (const a of actions) {
    const key = `${a.asin}-${a.marketplace}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const intel = (a.intelligence_factors as Record<string, any>) || {};
    const guards = intel?.guards_applied || [];
    const posProof = intel?.position_proof || {};
    const delta = (a.new_price ?? 0) - (a.old_price ?? 0);

    if (a.success === false || a.error_message) pools.constrained.push(a);
    else if (guards.includes("min_floor") || guards.includes("floor_clamp") || guards.includes("profit_guard_block")) pools.floor_hit.push(a);
    else if (posProof.buy_box_owner_is_me === false && delta < -0.005) pools.bb_loss.push(a);
    else if (delta > 0.005) pools.raised.push(a);
    else if (posProof.buy_box_owner_is_me === true && delta >= -0.005) pools.winner.push(a);
    else pools.constrained.push(a);
  }
  return pools;
}

export function selectDiverseBatch(pools: Record<ReviewCategory, any[]>, maxSize = 5): { action: any; category: ReviewCategory }[] {
  const selected: { action: any; category: ReviewCategory }[] = [];
  const usedKeys = new Set<string>();
  const categories: ReviewCategory[] = ["bb_loss", "raised", "constrained", "floor_hit", "winner"];

  const pickMost = (arr: any[], exclude: Set<string>) => {
    const filtered = arr.filter(a => !exclude.has(`${a.asin}-${a.marketplace}`));
    if (filtered.length === 0) return null;
    return [...filtered].sort((a, b) =>
      Math.abs((b.new_price ?? 0) - (b.old_price ?? 0)) - Math.abs((a.new_price ?? 0) - (a.old_price ?? 0))
    )[0];
  };

  // Round 1: most significant per category
  for (const cat of categories) {
    const item = pickMost(pools[cat], usedKeys);
    if (item) {
      selected.push({ action: item, category: cat });
      usedKeys.add(`${item.asin}-${item.marketplace}`);
    }
  }

  // Round 2: fill to maxSize
  if (selected.length < maxSize) {
    for (const cat of categories) {
      if (selected.length >= maxSize) break;
      const item = pickMost(pools[cat], usedKeys);
      if (item) {
        selected.push({ action: item, category: cat });
        usedKeys.add(`${item.asin}-${item.marketplace}`);
      }
    }
  }

  return selected;
}
