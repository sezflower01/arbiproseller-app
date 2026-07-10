/**
 * Repricer terminology translation map (Phase 9).
 * Maps internal engine terms to plain business language used in Simple mode.
 * Advanced mode may still show the technical term in tooltips.
 */

export const REPRICER_COPY: Record<string, { business: string; tooltip?: string }> = {
  // Engine internals
  "delta_collapsed_by_guards": { business: "Protected by your pricing rules", tooltip: "delta collapsed by guards" },
  "dispatchable_hot": { business: "Urgent listings ready for action", tooltip: "dispatchable HOT" },
  "oscillation_detected": { business: "Unstable market pricing", tooltip: "oscillation detected" },
  "constraint_pressure": { business: "Pricing protection activity", tooltip: "constraint pressure" },
  "severity_tier": { business: "Urgency level", tooltip: "severity tier" },
  "shadow_analysis": { business: "Background quality checks", tooltip: "shadow analysis" },
  "tail_freshness": { business: "Slow-moving listing freshness", tooltip: "tail freshness" },
  "hot_p90": { business: "Urgent listing response time", tooltip: "HOT p90" },

  // Skip / block reasons
  "AT_MIN_FLOOR": { business: "Hit your minimum price" },
  "MIN_FLOOR": { business: "Hit your minimum price" },
  "PROFIT_GUARD": { business: "Profit protection active" },
  "ROI_GUARD": { business: "ROI protection active" },
  "OSCILLATION_DETECTED": { business: "Market is unstable — pausing changes" },
  "RAPID_PRICE_INSTABILITY": { business: "Market is unstable — pausing changes" },
  "BB_OWNER_HOLD": { business: "You own the Buy Box — holding price" },
  "BUYBOX_SUPPRESSED": { business: "Amazon hid the Buy Box" },
  "NO_COMPETITORS": { business: "No competitors to react to" },
  "NOT_BB_ELIGIBLE": { business: "Not Buy Box eligible right now" },
  "MARKET_STABLE": { business: "Market is calm — no change needed" },
  "DELTA_TOO_SMALL": { business: "Change too small to matter" },
  "COOLDOWN": { business: "Cooling down after a recent change" },
  "MONOPOLY_COOLDOWN": { business: "Cooling down (no competition)" },
  "SAFEGUARD_CLAMP": { business: "Safety limit applied" },
  "QUALITY_FILTER": { business: "Skipped low-quality competitor" },
  "FBM_IGNORED": { business: "Ignored merchant-fulfilled competitor" },
  "INVENTORY_PRESSURE": { business: "Adjusting for slow-moving inventory" },
};

export function translate(key: string): string {
  if (!key) return "";
  const direct = REPRICER_COPY[key];
  if (direct) return direct.business;
  // Heuristic for compound technical strings
  const upper = key.toUpperCase();
  for (const k of Object.keys(REPRICER_COPY)) {
    if (upper.includes(k.toUpperCase())) return REPRICER_COPY[k].business;
  }
  return key.replace(/_/g, " ").toLowerCase();
}

export function urgencyLabel(tier: string | number): string {
  const s = String(tier).toLowerCase();
  if (s.includes("hot") || s === "1" || s === "high") return "Urgent";
  if (s.includes("warm") || s === "2" || s === "medium") return "Soon";
  if (s.includes("cool") || s === "3" || s === "low") return "Routine";
  return "Routine";
}
