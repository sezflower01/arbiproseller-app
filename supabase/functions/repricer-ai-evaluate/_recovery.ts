// Underpriced recovery + market anomaly detection helpers — extracted so the
// behavior can be unit-tested directly (the engine's index.ts is too heavy to
// import in a Deno test runner — Supabase imports, serve(), etc.).
//
// IMPORTANT: index.ts must IMPORT these helpers (not re-declare them). Any
// drift means the tests no longer prove engine behavior. A divergence test
// in `recovery_test.ts` enforces this contractually.

// ═══════════════════════════════════════════════════════════════════
// MARKET ANOMALY DETECTION — flags low-confidence / inconsistent data
// so downstream decisions can be tagged for the UI instead of silently
// reduced to a generic "HOLD" / "BLOCKED". Pure function, no side effects.
// ═══════════════════════════════════════════════════════════════════
export interface AnomalyInput {
  currentPrice: number | null;
  buyboxPrice: number | null;
  lowestFbaPrice: number | null;
  lowestOverallPrice: number | null;
  rawTargetPrice: number | null;
  isBuyboxSuppressed: boolean;
  effectiveFloor: number;
}
export function detectMarketAnomalies(i: AnomalyInput): { tags: string[]; notes: string[] } {
  const tags: string[] = [];
  const notes: string[] = [];
  const cur = i.currentPrice;
  const lowest = i.lowestFbaPrice ?? i.lowestOverallPrice ?? null;

  // (1) Unrealistic target — proposed target wildly above current (>5x AND >+$50 absolute)
  if (cur && cur > 0 && i.rawTargetPrice != null && i.rawTargetPrice > 0) {
    const ratio = i.rawTargetPrice / cur;
    const absGap = i.rawTargetPrice - cur;
    if (ratio > 5 && absGap > 50) {
      tags.push('data_low_confidence');
      notes.push(`unrealistic_target(current=$${cur.toFixed(2)},target=$${i.rawTargetPrice.toFixed(2)},ratio=${ratio.toFixed(1)}x)`);
    }
  }

  // (2) Suppressed BB with high competitor pricing — typical "ghost market".
  // Lowest competitor >50% above current AND >$20 absolute suggests stale data,
  // FBM-only field, or condition mismatch. Don't auto-chase.
  if (i.isBuyboxSuppressed && cur && lowest && lowest > cur * 1.5 && (lowest - cur) > 20) {
    tags.push('market_inconsistent');
    notes.push(`suppressed_bb_high_competition(current=$${cur.toFixed(2)},lowest=$${lowest.toFixed(2)})`);
  }

  // (3) Lowest FBA wildly above current AND no BB — likely FBM/used vs FBA/new mismatch
  if (!i.buyboxPrice && cur && i.lowestFbaPrice && i.lowestFbaPrice > cur * 2 && (i.lowestFbaPrice - cur) > 20) {
    tags.push('market_inconsistent');
    notes.push(`no_bb_wide_spread(current=$${cur.toFixed(2)},lowestFba=$${i.lowestFbaPrice.toFixed(2)})`);
  }

  return { tags, notes };
}

// ═══════════════════════════════════════════════════════════════════
// UNDERPRICED RECOVERY — when our price is significantly below the
// market cluster, step UP toward the lowest eligible competitor instead
// of holding. Preset-driven step size (uses max_raise_step_dollars /
// max_raise_step_percent). Always respects effective floor + max.
// Returns null when not applicable.
// ═══════════════════════════════════════════════════════════════════
export interface UnderpricedRecoveryInput {
  currentPrice: number | null;
  buyboxPrice: number | null;
  lowestFbaPrice: number | null;
  lowestEligibleCompetitorPrice: number | null;
  isBuyboxOwner: boolean;
  isBuyboxSuppressed: boolean;
  maxRaiseStepDollars: number;
  maxRaiseStepPercent: number;
  smartRaiseEnabled: boolean;
  effectiveFloor: number;
  maxPrice: number | null;
  // Min gap thresholds:
  // - severeGapPct: gap considered "severe" (qualifies for fast-lane cooldown reduction)
  // - minGapPct: minimum gap to qualify for recovery at all
  severeGapPct?: number;
  minGapPct?: number;
}
export interface UnderpricedRecoveryResult {
  applies: boolean;
  targetPrice: number;
  marketAnchor: number;
  gapAbsolute: number;
  gapPct: number;
  isSevere: boolean;
  reason: string;
  guardTag: string;
  // Diagnostic: when applies=false, surfaces *why* — surfaced via debug log so
  // production behavior is observable, not opaque.
  skipReason?: string;
}
export function computeUnderpricedRecovery(i: UnderpricedRecoveryInput): UnderpricedRecoveryResult | null {
  // Helper to return a non-applying result with a skipReason. Returning the
  // structured object (instead of null) lets callers log *why* recovery skipped
  // — the original null-return swallowed that signal.
  const skip = (reason: string): UnderpricedRecoveryResult => ({
    applies: false, targetPrice: 0, marketAnchor: 0, gapAbsolute: 0, gapPct: 0,
    isSevere: false, reason: '', guardTag: '', skipReason: reason,
  });

  // Hard preconditions.
  if (!i.currentPrice || i.currentPrice <= 0) return skip('no_current_price');
  if (i.isBuyboxOwner) return skip('bb_owner_has_own_raise_path');
  if (i.isBuyboxSuppressed) return skip('bb_suppressed_uses_own_anchor');

  // ═══════════════════════════════════════════════════════════════════
  // CRITICAL GUARD: OVERPRICED-VS-VALID-LOWER-MARKET BLOCK
  // If the Buy Box (or lowest FBA) is BELOW our current price, we are
  // OVERPRICED relative to the real market — not underpriced. Recovery
  // must NOT fire and pull us further away from a winnable BB. The
  // match/undercut path should run instead. This fixes the bug where
  // `lowestEligibleCompetitorPrice` (next competitor *above* us) was
  // mistaken for a market anchor when a valid lower FBA BB existed.
  // ═══════════════════════════════════════════════════════════════════
  const validLowerBb = i.buyboxPrice != null && i.buyboxPrice > 0 && i.buyboxPrice < i.currentPrice;
  const validLowerFba = i.lowestFbaPrice != null && i.lowestFbaPrice > 0 && i.lowestFbaPrice < i.currentPrice;
  if (validLowerBb || validLowerFba) {
    return skip(`overpriced_vs_valid_lower_market(current=$${i.currentPrice.toFixed(2)},bb=$${i.buyboxPrice?.toFixed(2) ?? 'null'},lowestFba=$${i.lowestFbaPrice?.toFixed(2) ?? 'null'})`);
  }

  // NOTE: smartRaiseEnabled check removed as a hard block — recovery is a
  // profit-recapture path, not an aggressive raise. We still respect the flag
  // for non-severe gaps (gentler behavior), but allow severe underpricing
  // (≥severeGapPct) to recover regardless. This prevents the LIQUIDATION /
  // smart-raise-off presets from leaving 60%+ gaps on the table.

  // Determine the market anchor — prefer eligible competitor, fall back to BB, then lowest FBA.
  // (At this point both BB and lowestFBA are confirmed >= currentPrice or null.)
  const anchor = i.lowestEligibleCompetitorPrice ?? i.buyboxPrice ?? i.lowestFbaPrice ?? null;
  if (!anchor || anchor <= 0) return skip('no_market_anchor');
  if (anchor <= i.currentPrice) return skip('not_underpriced');

  const gap = anchor - i.currentPrice;
  const gapPct = (gap / anchor) * 100;
  const minGapPct = i.minGapPct ?? 5;        // need ≥5% gap to call it "underpriced"
  const severeGapPct = i.severeGapPct ?? 20; // ≥20% triggers fast-lane cooldown reduction

  if (gapPct < minGapPct) return skip(`gap_below_threshold(${gapPct.toFixed(1)}%<${minGapPct}%)`);

  // smart_raise OFF + non-severe gap → respect the preset (e.g. LIQUIDATION).
  // smart_raise OFF + severe gap → still recover (don't leave 20%+ on the table).
  if (!i.smartRaiseEnabled && gapPct < severeGapPct) {
    return skip(`smart_raise_disabled_and_gap_not_severe(${gapPct.toFixed(1)}%<${severeGapPct}%)`);
  }

  // Preset-driven step: cap by both dollar and % step caps.
  const dollarCap = Number(i.maxRaiseStepDollars) > 0 ? Number(i.maxRaiseStepDollars) : 0.50;
  const pctCap = Number(i.maxRaiseStepPercent) > 0 ? i.currentPrice * (Number(i.maxRaiseStepPercent) / 100) : 0;
  const stepCap = pctCap > 0 ? Math.min(dollarCap, pctCap) : dollarCap;
  const step = Math.min(gap, stepCap);
  let target = Math.round((i.currentPrice + step) * 100) / 100;

  // Clamp to floor (can't go below) and max (can't exceed cap).
  if (i.effectiveFloor > 0 && target < i.effectiveFloor) target = i.effectiveFloor;
  if (i.maxPrice && target > i.maxPrice) target = i.maxPrice;

  // If clamping erased the move, bail with a reason so we can see it in logs.
  if (target <= i.currentPrice + 0.005) {
    return skip(`clamped_no_move(target=$${target.toFixed(2)}<=current=$${i.currentPrice.toFixed(2)},floor=$${i.effectiveFloor.toFixed(2)},max=$${i.maxPrice?.toFixed(2) ?? 'null'})`);
  }

  const isSevere = gapPct >= severeGapPct;
  return {
    applies: true,
    targetPrice: target,
    marketAnchor: anchor,
    gapAbsolute: gap,
    gapPct,
    isSevere,
    reason: `Underpriced recovery: $${i.currentPrice.toFixed(2)} → $${target.toFixed(2)} (anchor $${anchor.toFixed(2)}, gap ${gapPct.toFixed(1)}%${isSevere ? ', SEVERE' : ''}, step cap $${stepCap.toFixed(2)})`,
    guardTag: isSevere ? 'underpriced_recovery_severe' : 'underpriced_recovery',
  };
}

// ═══════════════════════════════════════════════════════════════════
// FAST-LANE COOLDOWN REDUCTION — when an ASIN is severely underpriced
// (gap ≥ severeGapPct), we DO NOT bypass cooldown entirely. We reduce
// it to a fast-lane cap (default 2 min). This matches the agreed spec
// of "faster cooldown when gap > 20%" — NOT a blanket bypass.
//
// Returns the effective cooldown in minutes after fast-lane reduction.
// If isSevere is false, returns the input unchanged.
// ═══════════════════════════════════════════════════════════════════
export function computeFastLaneCooldown(
  baseCooldownMinutes: number,
  isSevere: boolean,
  fastLaneCapMinutes = 2,
): number {
  if (!isSevere) return baseCooldownMinutes;
  if (baseCooldownMinutes <= fastLaneCapMinutes) return baseCooldownMinutes;
  return fastLaneCapMinutes;
}
