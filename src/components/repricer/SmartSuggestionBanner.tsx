import { useState } from "react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowDown,
  Loader2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { formatPrice } from "@/lib/marketplaceCurrency";
import type { RepricerRule } from "./RuleBuilder";

interface SuggestionItem {
  id: string;
  asin: string;
  sku: string;
  assignment_id: string | null;
  rule_id: string | null;
  rule_name: string | null;
  is_enabled: boolean;
  my_price: number | null;
  price: number | null;
  cost: number | null;
  min_price_override: number | null;
  inv_min_price: number | null;
  max_price_override: number | null;
  inv_max_price: number | null;
  buybox_price: number | null;
  lowest_fba_price: number | null;
  lowest_overall_price: number | null;
  last_recommendation_reason: string | null;
  marketplace: string;
  fulfillment_type: "FBA" | "FBM";
  oscillation_state?: string | null;
  oscillation_cooldown_until?: string | null;
}

interface SmartSuggestionBannerProps {
  item: SuggestionItem;
  rules: RepricerRule[];
  marketplace: string;
  onItemUpdate: (itemId: string, updates: Partial<SuggestionItem>) => void;
  onAssignRule: (item: SuggestionItem, ruleId: string) => void;
}

type SuggestionType =
  | "blocked_by_min"
  | "no_rule"
  | "missing_min_max"
  | "bb_suppressed"
  | "profit_guard_block"
  | "cooldown"
  | "oscillation_pause";

interface Suggestion {
  type: SuggestionType;
  severity: "red" | "amber" | "blue";
  message: string;
  detail: string;
  actions: SuggestionAction[];
}

interface SuggestionAction {
  label: string;
  variant: "default" | "outline" | "destructive";
  onClick: () => Promise<void>;
}

export function detectSuggestion(
  item: SuggestionItem,
  rules: RepricerRule[]
): Suggestion | null {
  const currentPrice = Number(item.my_price ?? item.price ?? 0);
  const minPrice = item.min_price_override ?? item.inv_min_price;
  const maxPrice = item.max_price_override ?? item.inv_max_price;
  const reason = item.last_recommendation_reason?.toLowerCase() || "";
  const lowestCompetitor = item.lowest_fba_price ?? item.lowest_overall_price;
  const bb = item.buybox_price;

  // Priority 1: No rule assigned
  if (!item.rule_id) return null;

  // Priority 2: Missing min or max
  if (minPrice == null || maxPrice == null) return null;

  // Priority 3: Oscillation cooldown active — read directly from the live
  // oscillation_cooldown_until/oscillation_state columns (same fields the
  // admin diagnostics panel uses), not from last_recommendation_reason.
  // The reason string is a snapshot written at the last evaluation and can
  // go stale (e.g. still says "blocked by min floor $18" after the user
  // already lowered the min to $17) — checked here, before the reason-text
  // heuristics below, so a live cooldown always wins over a stale reason.
  const oscCooldownUntilMs = item.oscillation_cooldown_until
    ? new Date(item.oscillation_cooldown_until).getTime()
    : 0;
  const oscState = (item.oscillation_state || "").toLowerCase();
  const oscCooldownActive =
    (oscState.includes("cooldown") || oscState === "blocked") &&
    oscCooldownUntilMs > Date.now();

  if (oscCooldownActive) {
    const minsLeft = Math.max(1, Math.ceil((oscCooldownUntilMs - Date.now()) / 60000));
    return {
      type: "oscillation_pause",
      severity: "blue",
      message: `Price on hold — recent Buy Box back-and-forth (~${minsLeft} min)`,
      detail: `The system noticed this listing losing the Buy Box repeatedly and is briefly pausing (about ${minsLeft} more minute${minsLeft === 1 ? "" : "s"}) instead of chasing it back and forth, which would just trigger a price war. It will try again automatically once the pause clears. Don't want to wait? Type your desired price in Set Price and use the toggle to push it now.`,
      actions: [],
    };
  }

  // Priority 4: Blocked by min floor while losing BB
  const isLosingBB =
    bb != null
      ? currentPrice > bb * 1.005
      : lowestCompetitor != null && currentPrice > lowestCompetitor;

  // The reason text may quote a floor dollar amount (e.g. "user min floor
  // $18.00") from a stale evaluation. Only trust floor-language in the
  // reason if that quoted amount still matches the CURRENT min — otherwise
  // the user has already changed the min and this reason no longer applies.
  const reasonFloorMatch = reason.match(/floor\s*\$?\s*([\d.]+)/);
  const reasonFloorAmount = reasonFloorMatch ? parseFloat(reasonFloorMatch[1]) : null;
  const reasonFloorStillCurrent =
    reasonFloorAmount == null ||
    minPrice == null ||
    Math.abs(reasonFloorAmount - Number(minPrice)) < 0.02;

  const isClampedByFloor =
    reasonFloorStillCurrent &&
    (reason.includes("clamped") ||
      reason.includes("holding at floor") ||
      reason.includes("floor prevents") ||
      reason.includes("clamped by floor") ||
      reason.includes("clamped to min") ||
      reason.includes("effective_floor") ||
      reason.includes("constrained_by"));

  const isAtMinFloor =
    minPrice != null && Math.abs(currentPrice - Number(minPrice)) < 0.02;
  const isBlockedByMin =
    isLosingBB &&
    lowestCompetitor != null &&
    minPrice != null &&
    (isClampedByFloor || (isAtMinFloor && currentPrice > lowestCompetitor));

  if (isBlockedByMin) {
    return {
      type: "blocked_by_min",
      severity: "red",
      message: "Not competitive — blocked by your minimum price",
      detail: `Market is at ${formatPrice(lowestCompetitor, item.marketplace)} but your min floor (${formatPrice(Number(minPrice), item.marketplace)}) prevents lowering.`,
      actions: [],
    };
  }

  // Priority 5: BB suppressed
  // Previously required the literal word "suppressed" in the free-text
  // last_recommendation_reason -- but that string is written by many
  // different code paths with different wording ("Stock-gated hold...",
  // "Lowest filtered protection...", "Target ($X) - $0.00 undercut", etc.),
  // none of which use that word even though bb is genuinely null. Confirmed
  // live: 416 of 649 US assignments had bb == null, but only 1 matched the
  // old substring check. Key off bb == null directly instead -- that's the
  // actual ground truth (matches the "-" shown in the BB column), not a
  // guess about specific wording.
  // Show every BB-null listing, not just the subset where price is also
  // above the lowest competitor -- per request, this should surface ALL
  // suppressed listings, including ones already competitively priced
  // (nothing to fix, but still worth seeing as "suppressed").
  const isBbSuppressed = bb == null;
  if (isBbSuppressed) {
    const detail = lowestCompetitor != null
      ? (currentPrice > lowestCompetitor
        ? `No active Buy Box. System is targeting lowest competitor at ${formatPrice(lowestCompetitor, item.marketplace)}.`
        : `No active Buy Box. Already at or below lowest competitor (${formatPrice(lowestCompetitor, item.marketplace)}) — holding current price.`)
      : `No active Buy Box, and no competitor price data available.`;
    return {
      type: "bb_suppressed",
      severity: "blue",
      message: "Buy Box suppressed — competing on lowest price",
      detail,
      actions: [],
    };
  }

  // Priority 6: Profit guard blocked
  if (
    reason.includes("profit guard") ||
    reason.includes("profit_guard") ||
    reason.includes("roi guard")
  ) {
    return {
      type: "profit_guard_block",
      severity: "amber",
      message: "Profit protection blocking price drop",
      detail:
        "The system wants to lower your price but your profit rules prevent it. Consider switching to a liquidation rule if you need to sell faster.",
      actions: [],
    };
  }

  // Priority 7: Oscillation guard pause (reason-text fallback) — only reached
  // if the live oscillation_cooldown_until/oscillation_state check above
  // (Priority 3) didn't fire, e.g. for older rows where those columns aren't
  // populated yet. Falls back to matching the "Guard: OSCILLATION_..." reason.
  if (reason.includes("guard:") && reason.includes("oscillation")) {
    return {
      type: "oscillation_pause",
      severity: "blue",
      message: "Price on hold — recent Buy Box back-and-forth",
      detail:
        "The system noticed this listing losing the Buy Box repeatedly and is briefly pausing instead of chasing it back and forth (which would just trigger a price war). It will try again shortly on its own. Don't want to wait? Type your desired price in Set Price and use the toggle to push it now.",
      actions: [],
    };
  }

  // Priority 8: Cooldown active — not a problem, just a short wait between
  // price moves (prevents rapid back-and-forth changes). Informational, but
  // the user should know why the price hasn't moved yet and that they can
  // set their own price instead of waiting it out.
  if (reason.includes("cooldown")) {
    const minsMatch = reason.match(/(\d+)\s*min(?:ute)?s?\s*remaining/i);
    const mins = minsMatch ? minsMatch[1] : null;
    return {
      type: "cooldown",
      severity: "blue",
      message: mins
        ? `Price on hold — cooling down (~${mins} min left)`
        : "Price on hold — cooling down",
      detail:
        "To avoid rapid back-and-forth price changes, the system briefly pauses between price moves on this listing. Don't want to wait? Type your desired price in Set Price and use the toggle to push it now.",
      actions: [],
    };
  }

  return null;
}

export default function SmartSuggestionBanner({
  item,
  rules,
  marketplace,
  onItemUpdate,
  onAssignRule,
}: SmartSuggestionBannerProps) {
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const suggestion = detectSuggestion(item, rules);
  if (!suggestion) return null;

  const lowestCompetitor =
    item.lowest_fba_price ?? item.lowest_overall_price;

  const suggestedMin =
    lowestCompetitor != null
      ? Math.max(Math.round((lowestCompetitor - 0.02) * 100) / 100, 0.99)
      : null;

  const handleLowerMin = async () => {
    if (!item.assignment_id || suggestedMin == null) return;
    setLoading(true);
    try {
      const { error } = await supabase
        .from("repricer_assignments")
        .update({
          min_price_override: suggestedMin,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.assignment_id);
      if (error) throw error;

      if (marketplace === "US" && item.sku) {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (session) {
          await supabase
            .from("inventory")
            .update({ min_price: suggestedMin })
            .eq("user_id", session.user.id)
            .eq("sku", item.sku);
        }
      }

      onItemUpdate(item.id, { min_price_override: suggestedMin });
      toast.success(
        `Min lowered to ${formatPrice(suggestedMin, marketplace)} for ${item.asin}`
      );
    } catch (e: any) {
      toast.error("Failed to lower min: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const severityColors = {
    red: "bg-[hsl(0,55%,15%)] border-destructive/40 text-white",
    amber: "bg-[hsl(35,55%,14%)] border-amber-500/40 text-white",
    blue: "bg-[hsl(220,70%,14%)] border-blue-400/40 text-white",
  };

  const iconColor = {
    red: "text-destructive",
    amber: "text-amber-500",
    blue: "text-blue-500",
  };

  return (
    <div
      className={`rounded-md border px-1 py-1.5 text-[11px] space-y-1 max-w-[180px] ${severityColors[suggestion.severity]}`}
    >
      <div className="flex items-center gap-1.5">
        <AlertTriangle
          className={`h-3 w-3 shrink-0 ${iconColor[suggestion.severity]}`}
        />
        <span className="font-semibold flex-1 leading-tight">
          {suggestion.message}
        </span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="shrink-0 hover:opacity-70"
        >
          {expanded ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
        </button>
      </div>

      {expanded && (
        <div className="space-y-1.5 pt-0.5">
          <p className="text-[10px] opacity-80 leading-relaxed">
            {suggestion.detail}
          </p>

          <div className="flex flex-wrap gap-1">
            {suggestion.type === "blocked_by_min" && (
              <>
                {suggestedMin != null && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-5 text-[10px] px-1.5 gap-0.5 border-destructive/40 text-destructive hover:bg-destructive/10"
                    disabled={loading}
                    onClick={handleLowerMin}
                  >
                    {loading ? (
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    ) : (
                      <ArrowDown className="h-2.5 w-2.5" />
                    )}
                    Lower min to {formatPrice(suggestedMin, marketplace)}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
