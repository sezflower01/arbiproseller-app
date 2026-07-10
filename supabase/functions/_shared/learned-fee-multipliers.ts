// Deno mirror of src/lib/sales/learnedFeeMultipliers.ts. Keep both in sync.
// Used by _shared/live-sales-core.ts (Sales Report + period summaries server path).

export type IntlMarketplace = "CA" | "MX" | "BR";
export type LearnedFeeConfidence = "insufficient" | "low" | "medium" | "high";

export interface LearnedFeeMultiplier {
  marketplace: IntlMarketplace;
  total: number | null;
  confidence: LearnedFeeConfidence;
}

export interface LearnedFeeSettings {
  enabled: boolean;
  perMarketplace: Record<IntlMarketplace, boolean>;
}

export const DEFAULT_LEARNED_FEE_SETTINGS: LearnedFeeSettings = {
  enabled: true,
  perMarketplace: { CA: true, MX: true, BR: true },
};

const INTL = new Set<IntlMarketplace>(["CA", "MX", "BR"]);
const RANK: Record<LearnedFeeConfidence, number> = {
  insufficient: 0, low: 1, medium: 2, high: 3,
};

export type LearnedFeeMultiplierMap = Map<IntlMarketplace, LearnedFeeMultiplier>;

export async function loadLearnedFeeSettings(admin: any, userId: string): Promise<LearnedFeeSettings> {
  const { data } = await admin
    .from("user_settings")
    .select("intl_learned_fees_enabled, intl_learned_fees_ca, intl_learned_fees_mx, intl_learned_fees_br")
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

export async function loadLearnedFeeMultipliers(admin: any, userId: string): Promise<LearnedFeeMultiplierMap> {
  const out: LearnedFeeMultiplierMap = new Map();
  // Schema is long-format: one row per (marketplace, fee_component) with
  // `multiplier` + `confidence`. We only consume fee_component='total'.
  const { data } = await admin
    .from("learned_fee_multipliers")
    .select("marketplace, multiplier, confidence, fee_component")
    .eq("user_id", userId)
    .eq("fee_component", "total");
  for (const row of (data || []) as any[]) {
    const mp = String(row.marketplace || "").toUpperCase();
    if (!INTL.has(mp as IntlMarketplace)) continue;
    out.set(mp as IntlMarketplace, {
      marketplace: mp as IntlMarketplace,
      total: row.multiplier == null ? null : Number(row.multiplier),
      confidence: (row.confidence || "insufficient") as LearnedFeeConfidence,
    });
  }
  return out;
}

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

export function applyLearnedFeeMultiplier(params: {
  row: { marketplace?: string | null; sold_price?: number | null; total_sale_amount?: number | null; price_confidence?: string | null };
  rawFeesUsd: number;
  settings: LearnedFeeSettings;
  multipliers: LearnedFeeMultiplierMap;
  minConfidence?: LearnedFeeConfidence;
}): number {
  const { row, rawFeesUsd, settings, multipliers } = params;
  const minConfidence = params.minConfidence || "low";
  if (!settings.enabled) return rawFeesUsd;
  if (rawFeesUsd <= 0) return rawFeesUsd;
  const mp = String(row.marketplace || "").trim().toUpperCase();
  if (!INTL.has(mp as IntlMarketplace)) return rawFeesUsd;
  if (!settings.perMarketplace[mp as IntlMarketplace]) return rawFeesUsd;
  if (!isPendingRowForLearnedFee(row)) return rawFeesUsd;
  const m = multipliers.get(mp as IntlMarketplace);
  if (!m || m.total == null || !(m.total > 0)) return rawFeesUsd;
  if (RANK[m.confidence] < RANK[minConfidence]) return rawFeesUsd;
  return rawFeesUsd * m.total;
}
