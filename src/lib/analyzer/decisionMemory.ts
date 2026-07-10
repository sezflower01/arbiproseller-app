// Analyzer Decision Memory — Phase 1 (data capture only).
// Writes a snapshot of every analyzer scan + user buy/skip/watch actions.
// No AI calls, no rules engine. Pure data collection for future learning.

import { supabase } from "@/integrations/supabase/client";

export type AnalyzerSource = "web" | "extension";
export type AnalyzerActionKind = "buy" | "skip" | "watch" | "bought_units";

export interface DecisionSnapshotInput {
  asin: string;
  marketplace?: string;
  source?: AnalyzerSource;
  cost?: number | null;
  fees?: number | null;
  sale_price?: number | null;
  roi?: number | null;
  profit?: number | null;
  margin?: number | null;
  bsr?: number | null;
  est_sales_month?: number | null;
  buy_box?: number | null;
  lowest_fba?: number | null;
  lowest_fbm?: number | null;
  seller_count?: number | null;
  swing_3m?: number | null;
  swing_6m?: number | null;
  swing_1y?: number | null;
  eligibility?: string | null;
  hazmat?: boolean | null;
  prep_required?: boolean | null;
  pl_risk?: string | null;
  ip_risk?: string | null;
  competition_level?: string | null;
  final_decision?: string | null;
  confidence?: string | null;
  ai_reasoning?: string | null;
  raw_snapshot?: unknown;
  // Lightweight metadata for future pattern mining (all optional).
  category?: string | null;
  brand?: string | null;
  size_tier?: string | null;
  amazon_presence?: string | null; // "present" | "absent" | "unknown"
  source_surface?: string | null;  // "web" | "extension" | "mobile"
  active_range_viewed?: string | null; // "3M" | "6M" | "1Y"
  scan_duration_ms?: number | null;
  retrieval_state?: string | null; // "ok" | "partial" | "timeout" | "error"
  data_freshness?: string | null;  // "live" | "cached" | "stale"
}


// 10 minute dedup window per asin+marketplace so re-opens don't spam.
const DEDUP_WINDOW_MS = 10 * 60 * 1000;
const dedupCache = new Map<string, number>();

function dedupKey(asin: string, marketplace: string, source: AnalyzerSource) {
  return `${source}:${marketplace.toUpperCase()}:${asin.toUpperCase()}`;
}

export async function logAnalyzerDecision(
  input: DecisionSnapshotInput,
): Promise<{ id: string | null; skipped: boolean }> {
  const asin = (input.asin || "").toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) return { id: null, skipped: true };
  const marketplace = (input.marketplace || "US").toUpperCase();
  const source: AnalyzerSource = input.source || "web";

  const key = dedupKey(asin, marketplace, source);
  const last = dedupCache.get(key) || 0;
  if (Date.now() - last < DEDUP_WINDOW_MS) {
    return { id: null, skipped: true };
  }

  const { data: u } = await supabase.auth.getUser();
  if (!u?.user) return { id: null, skipped: true };

  const row = {
    user_id: u.user.id,
    asin,
    marketplace,
    source,
    cost: input.cost ?? null,
    fees: input.fees ?? null,
    sale_price: input.sale_price ?? null,
    roi: input.roi ?? null,
    profit: input.profit ?? null,
    margin: input.margin ?? null,
    bsr: input.bsr ?? null,
    est_sales_month: input.est_sales_month ?? null,
    buy_box: input.buy_box ?? null,
    lowest_fba: input.lowest_fba ?? null,
    lowest_fbm: input.lowest_fbm ?? null,
    seller_count: input.seller_count ?? null,
    swing_3m: input.swing_3m ?? null,
    swing_6m: input.swing_6m ?? null,
    swing_1y: input.swing_1y ?? null,
    eligibility: input.eligibility ?? null,
    hazmat: input.hazmat ?? null,
    prep_required: input.prep_required ?? null,
    pl_risk: input.pl_risk ?? null,
    ip_risk: input.ip_risk ?? null,
    competition_level: input.competition_level ?? null,
    final_decision: input.final_decision ?? null,
    confidence: input.confidence ?? null,
    ai_reasoning: input.ai_reasoning ?? null,
    raw_snapshot: (input.raw_snapshot ?? null) as any,
    category: input.category ?? null,
    brand: input.brand ?? null,
    size_tier: input.size_tier ?? null,
    amazon_presence: input.amazon_presence ?? null,
    source_surface: input.source_surface ?? source,
    active_range_viewed: input.active_range_viewed ?? null,
    scan_duration_ms: input.scan_duration_ms ?? null,
    retrieval_state: input.retrieval_state ?? null,
    data_freshness: input.data_freshness ?? null,
  };


  const { data, error } = await supabase
    .from("analyzer_decision_log")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    console.warn("[decisionMemory] insert error", error);
    return { id: null, skipped: false };
  }
  dedupCache.set(key, Date.now());
  return { id: data?.id ?? null, skipped: false };
}

export async function recordAnalyzerAction(params: {
  decisionId: string;
  asin: string;
  marketplace?: string;
  action: AnalyzerActionKind;
  units?: number | null;
  notes?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const { data: u } = await supabase.auth.getUser();
  if (!u?.user) return { ok: false, error: "Not signed in" };
  const { error } = await supabase.from("analyzer_decision_action").insert({
    user_id: u.user.id,
    decision_id: params.decisionId,
    asin: (params.asin || "").toUpperCase(),
    marketplace: (params.marketplace || "US").toUpperCase(),
    action: params.action,
    units: params.units ?? null,
    notes: params.notes ?? null,
  });
  if (error) {
    console.warn("[decisionMemory] action insert error", error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
