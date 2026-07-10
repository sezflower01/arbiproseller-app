/**
 * Phase 2 of Learned International Fee Estimation.
 *
 * Read-path helper that adjusts a raw SP-API fee USD number using the multiplier
 * learned by `learn-intl-fee-multipliers` (settled FEC fees ÷ SP-API estimate).
 *
 * Contract (DO NOT loosen):
 *   1. Only applies to marketplace ∈ {CA, MX, BR}.
 *   2. Only applies to PENDING rows — confirmed sales (sold_price>0 or
 *      total_sale_amount>0 or price_confidence='CONFIRMED') always use stored
 *      fees, never a learned multiplier.
 *   3. Per-user master switch `intl_learned_fees_enabled` + per-marketplace
 *      flags `intl_learned_fees_{ca,mx,br}` gate the adjustment.
 *   4. Multiplier confidence must be at least 'low'. 'insufficient' is ignored.
 *   5. Never mutates the row. Never overwrites `referral_fee`, `fba_fee`,
 *      `closing_fee`, `total_fees`, `sold_price`, `total_sale_amount`. The raw
 *      SP-API estimate stays on `sales_orders` untouched.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type IntlMarketplace = "CA" | "MX" | "BR";
export type LearnedFeeConfidence = "insufficient" | "low" | "medium" | "high";

export interface LearnedFeeMultiplier {
  marketplace: IntlMarketplace;
  referral: number | null;
  fba: number | null;
  closing: number | null;
  total: number | null;
  confidence: LearnedFeeConfidence;
  sampleSize: number;
}

export interface LearnedFeeSettings {
  enabled: boolean;
  perMarketplace: Record<IntlMarketplace, boolean>;
}

export const DEFAULT_LEARNED_FEE_SETTINGS: LearnedFeeSettings = {
  enabled: true,
  perMarketplace: { CA: true, MX: true, BR: true },
};

const INTL_MARKETPLACES = new Set<IntlMarketplace>(["CA", "MX", "BR"]);

export type LearnedFeeMultiplierMap = Map<IntlMarketplace, LearnedFeeMultiplier>;

export async function loadLearnedFeeSettings(
  supabase: SupabaseClient,
  userId: string,
): Promise<LearnedFeeSettings> {
  const { data } = await supabase
    .from("user_settings")
    .select(
      "intl_learned_fees_enabled, intl_learned_fees_ca, intl_learned_fees_mx, intl_learned_fees_br",
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return DEFAULT_LEARNED_FEE_SETTINGS;
  return {
    enabled: data.intl_learned_fees_enabled !== false,
    perMarketplace: {
      CA: data.intl_learned_fees_ca !== false,
      MX: data.intl_learned_fees_mx !== false,
      BR: data.intl_learned_fees_br !== false,
    },
  };
}

export async function loadLearnedFeeMultipliers(
  supabase: SupabaseClient,
  userId: string,
): Promise<LearnedFeeMultiplierMap> {
  const out: LearnedFeeMultiplierMap = new Map();
  // Schema: one row per (marketplace, fee_component). We aggregate the
  // per-component rows (referral/fba/closing/total) into a single per-
  // marketplace entry, using the `total` component for the headline multiplier.
  const { data, error } = await supabase
    .from("learned_fee_multipliers")
    .select("marketplace, fee_component, multiplier, confidence, sample_count")
    .eq("user_id", userId);
  if (error || !data) return out;
  type Acc = Partial<LearnedFeeMultiplier> & { marketplace: IntlMarketplace };
  const acc = new Map<IntlMarketplace, Acc>();
  for (const row of data as any[]) {
    const mp = String(row.marketplace || "").toUpperCase();
    if (!INTL_MARKETPLACES.has(mp as IntlMarketplace)) continue;
    const comp = String(row.fee_component || "").toLowerCase();
    const mult = row.multiplier == null ? null : Number(row.multiplier);
    const cur = acc.get(mp as IntlMarketplace) || {
      marketplace: mp as IntlMarketplace,
      referral: null, fba: null, closing: null, total: null,
      confidence: "insufficient" as LearnedFeeConfidence,
      sampleSize: 0,
    };
    if (comp === "referral") cur.referral = mult;
    else if (comp === "fba") cur.fba = mult;
    else if (comp === "closing") cur.closing = mult;
    else if (comp === "total") {
      cur.total = mult;
      cur.confidence = (row.confidence || "insufficient") as LearnedFeeConfidence;
      cur.sampleSize = Number(row.sample_count || 0);
    }
    acc.set(mp as IntlMarketplace, cur);
  }
  for (const [mp, v] of acc) {
    out.set(mp, {
      marketplace: mp,
      referral: v.referral ?? null,
      fba: v.fba ?? null,
      closing: v.closing ?? null,
      total: v.total ?? null,
      confidence: v.confidence ?? "insufficient",
      sampleSize: v.sampleSize ?? 0,
    });
  }
  return out;
}

function isIntlMarketplace(mp: string | null | undefined): mp is IntlMarketplace {
  const norm = String(mp || "").trim().toUpperCase();
  return INTL_MARKETPLACES.has(norm as IntlMarketplace);
}

/**
 * Pending = no confirmed sale value yet.
 * sold_price/total_sale_amount come from Orders API or FEC settlement, so
 * either being > 0 means we already have authoritative pricing → don't adjust.
 * price_confidence='CONFIRMED' is also a hard "do not touch".
 */
export function isPendingRowForLearnedFee(row: {
  sold_price?: number | null;
  total_sale_amount?: number | null;
  price_confidence?: string | null;
}): boolean {
  if (Number(row.sold_price || 0) > 0) return false;
  if (Number(row.total_sale_amount || 0) > 0) return false;
  if (String(row.price_confidence || "").toUpperCase() === "CONFIRMED") return false;
  return true;
}

export interface LearnedFeeResult {
  /** USD fee value after applying learned multiplier. */
  feesUsd: number;
  /** USD fee value before applying learned multiplier (raw SP-API estimate). */
  rawFeesUsd: number;
  /** Multiplier applied (null when none applied). */
  multiplier: number | null;
  /** Confidence tier of the learned multiplier (when applied). */
  confidence: LearnedFeeConfidence | null;
  /** Marketplace key when applied. */
  marketplace: IntlMarketplace | null;
  /** True when the learned multiplier was applied. */
  applied: boolean;
}

const CONFIDENCE_RANK: Record<LearnedFeeConfidence, number> = {
  insufficient: 0, low: 1, medium: 2, high: 3,
};

/**
 * Apply the learned `total` multiplier to a USD fee estimate for a pending
 * international row. Returns the original fee unchanged when:
 *   - settings disabled (master or per-marketplace)
 *   - row is not international CA/MX/BR
 *   - row is not pending (has confirmed sold_price / total_sale_amount)
 *   - no learned multiplier with confidence ≥ 'low'
 *   - rawFeesUsd <= 0 (nothing to scale)
 */
export function applyLearnedFeeMultiplier(params: {
  row: {
    marketplace?: string | null;
    sold_price?: number | null;
    total_sale_amount?: number | null;
    price_confidence?: string | null;
  };
  rawFeesUsd: number;
  settings: LearnedFeeSettings;
  multipliers: LearnedFeeMultiplierMap;
  minConfidence?: LearnedFeeConfidence;
}): LearnedFeeResult {
  const { row, rawFeesUsd, settings, multipliers } = params;
  const minConfidence = params.minConfidence || "low";

  const base: LearnedFeeResult = {
    feesUsd: rawFeesUsd,
    rawFeesUsd,
    multiplier: null,
    confidence: null,
    marketplace: null,
    applied: false,
  };

  if (!settings.enabled) return base;
  if (rawFeesUsd <= 0) return base;
  const mp = String(row.marketplace || "").trim().toUpperCase();
  if (!isIntlMarketplace(mp)) return base;
  if (!settings.perMarketplace[mp]) return base;
  if (!isPendingRowForLearnedFee(row)) return base;

  const m = multipliers.get(mp);
  if (!m) return base;
  if (m.total == null || !(m.total > 0)) return base;
  if (CONFIDENCE_RANK[m.confidence] < CONFIDENCE_RANK[minConfidence]) return base;

  return {
    feesUsd: rawFeesUsd * m.total,
    rawFeesUsd,
    multiplier: m.total,
    confidence: m.confidence,
    marketplace: mp,
    applied: true,
  };
}

/** Human-facing label for tooltips / debug. */
export function formatLearnedFeeBadge(result: LearnedFeeResult): string {
  if (!result.applied || !result.marketplace || result.multiplier == null) {
    return "Raw SP-API estimate";
  }
  return `${result.marketplace} learned ×${result.multiplier.toFixed(2)} (${result.confidence}) — based on settled history. Final fees update after settlement.`;
}
