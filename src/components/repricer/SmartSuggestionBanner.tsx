import { useState } from "react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowDown,
  TrendingDown,
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
  | "profit_guard_block";

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

  // Priority 3: Blocked by min floor while losing BB
  const isLosingBB =
    bb != null
      ? currentPrice > bb * 1.005
      : lowestCompetitor != null && currentPrice > lowestCompetitor;
  const isClampedByFloor =
    reason.includes("clamped") ||
    reason.includes("holding at floor") ||
    reason.includes("floor prevents") ||
    reason.includes("clamped by floor") ||
    reason.includes("clamped to min") ||
    reason.includes("effective_floor") ||
    reason.includes("constrained_by");

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

  // Priority 4: BB suppressed
  const isBbSuppressed =
    reason.includes("buy box suppressed") ||
    (bb == null && lowestCompetitor != null && reason.includes("suppressed"));
  if (
    isBbSuppressed &&
    lowestCompetitor != null &&
    currentPrice > lowestCompetitor &&
    !isClampedByFloor
  ) {
    return {
      type: "bb_suppressed",
      severity: "blue",
      message: "Buy Box suppressed — competing on lowest price",
      detail: `No active Buy Box. System is targeting lowest competitor at ${formatPrice(lowestCompetitor, item.marketplace)}.`,
      actions: [],
    };
  }

  // Priority 5: Profit guard blocked
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

  const liquidationRule = rules.find(
    (r) =>
      (r as any).smart_profile === "LIQUIDATION" ||
      r.name?.toLowerCase().includes("liquidation")
  );

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

  const handleSwitchLiquidation = async () => {
    if (!liquidationRule) {
      toast.error(
        "No Liquidation rule found. Create one first in the Rules tab."
      );
      return;
    }
    onAssignRule(item as any, liquidationRule.id);
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
      className={`rounded-md border px-2 py-1.5 text-[11px] space-y-1 ${severityColors[suggestion.severity]}`}
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
                {liquidationRule && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-5 text-[10px] px-1.5 gap-0.5"
                    disabled={loading}
                    onClick={handleSwitchLiquidation}
                  >
                    <TrendingDown className="h-2.5 w-2.5" />
                    Switch to Liquidation
                  </Button>
                )}
              </>
            )}

            {suggestion.type === "profit_guard_block" && liquidationRule && (
              <Button
                size="sm"
                variant="outline"
                className="h-5 text-[10px] px-1.5 gap-0.5"
                disabled={loading}
                onClick={handleSwitchLiquidation}
              >
                <TrendingDown className="h-2.5 w-2.5" />
                Switch to Liquidation
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
