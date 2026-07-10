import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { RefreshCw, Check, Lightbulb, Minus, CheckCheck, Copy, Square, CheckSquare, X, ClipboardList, ShieldAlert, Trophy } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { getMarketplaceConfig } from "@/lib/marketplaceCurrency";
import BbStatusBadge from "./BbStatusBadge";
import { logSettingChange } from "@/lib/repricerChangeLog";

interface SuggestionRow {
  assignment_id: string;
  asin: string;
  sku: string | null;
  marketplace: string;
  image_url: string | null;
  title: string;
  current_price: number | null;
  current_min: number | null;
  max_price: number | null;
  unit_cost: number | null;
  actual_roi: number | null;
  suggestion: {
    competitive_price: number;
    suggested_min: number;
    current_min: number | null;
    gap_amount: number | null;
    gap_percent: number | null;
    projected_roi: number | null;
    unit_cost: number | null;
  } | null;
  last_reason: string | null;
  // BB status context
  bb_status: 'winning' | 'losing' | 'unknown';
  buybox_price: number | null;
  lowest_fba: number | null;
  gap_to_lowest_fba_pct: number | null;
  is_already_lowest_fba: boolean;
  is_upward_suggestion: boolean;
  raise_blocked_reason: string | null;
}

const LOWEST_FBA_TOLERANCE = 0.01;

function getSuggestionMarketContext({
  currentPrice,
  lowestFba,
}: {
  currentPrice: number | null;
  lowestFba: number | null;
}) {
  const hasComparableMarket = currentPrice != null && lowestFba != null && lowestFba > 0;
  const gapToLowestFbaPct = hasComparableMarket
    ? Math.round((Math.abs(currentPrice - lowestFba) / lowestFba) * 1000) / 10
    : null;
  const isAlreadyLowestFba = hasComparableMarket
    ? currentPrice <= lowestFba + LOWEST_FBA_TOLERANCE
    : false;

  return {
    gapToLowestFbaPct,
    isAlreadyLowestFba,
  };
}

function toRoundedMoney(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric * 100) / 100;
}

function buildFallbackSuggestion({
  latestAction,
  currentMin,
  lowestFba,
  buyboxPrice,
}: {
  latestAction: any;
  currentMin: number | null;
  lowestFba: number | null;
  buyboxPrice: number | null;
}): SuggestionRow["suggestion"] {
  if (!latestAction?.reason?.includes("MIN_PRICE_SUGGESTION") || currentMin == null || currentMin <= 0) {
    return null;
  }

  const factors = latestAction.intelligence_factors ?? {};
  const safeguards = factors.safeguards ?? {};
  const profitGuard = factors.profit_guard ?? {};
  const floorBreakdown = profitGuard.floor_breakdown ?? {};
  const bounds = factors.bounds ?? {};
  const undercut = toRoundedMoney(bounds.undercut_amount) ?? 0.01;

  const benchmarkPrice = toRoundedMoney(lowestFba)
    ?? toRoundedMoney(factors.price_trace?.lowest_fba)
    ?? toRoundedMoney(buyboxPrice)
    ?? toRoundedMoney(factors.price_trace?.buybox_price)
    ?? toRoundedMoney(factors.position_proof?.lowest_price_filtered)
    ?? toRoundedMoney(factors.position_proof?.lowest_price_raw);

  if (benchmarkPrice == null) return null;

  const effectiveFloor = toRoundedMoney(safeguards.effective_floor)
    ?? toRoundedMoney(profitGuard.profit_floor_price)
    ?? toRoundedMoney(floorBreakdown.roi)
    ?? toRoundedMoney(latestAction.effective_floor_cents != null ? Number(latestAction.effective_floor_cents) / 100 : null)
    ?? 0.99;

  const rawSuggestedMin = Math.max(benchmarkPrice - undercut, effectiveFloor);
  const suggestedMin = Math.round(rawSuggestedMin * 100) / 100;
  const gapAmount = Math.round((currentMin - suggestedMin) * 100) / 100;

  if (!(gapAmount > 0)) return null;

  return {
    competitive_price: benchmarkPrice,
    suggested_min: suggestedMin,
    current_min: currentMin,
    gap_amount: gapAmount,
    gap_percent: currentMin > 0 ? Math.round((gapAmount / currentMin) * 1000) / 10 : null,
    projected_roi: null,
    unit_cost: null,
  };
}

function getSuggestionBlockReason({
  suggestedMin,
  currentMin,
}: {
  suggestedMin: number | null;
  currentMin: number | null;
}): {
  reason: string | null;
  gapToLowestFbaPct: number | null;
  isAlreadyLowestFba: boolean;
} {
  if (suggestedMin != null && currentMin != null && suggestedMin > currentMin) {
    return {
      reason: "Upward suggestion suppressed — suggestions can only lower Min",
      gapToLowestFbaPct: null,
      isAlreadyLowestFba: false,
    };
  }

  return {
    reason: null,
    gapToLowestFbaPct: null,
    isAlreadyLowestFba: false,
  };
}

interface SuggestionReviewPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  marketplace: string;
  onMinPriceAccepted?: (asin: string, sku: string | null, newMin: number, newPrice?: number) => void;
}

export default function SuggestionReviewPanel({
  open,
  onOpenChange,
  marketplace,
  onMinPriceAccepted,
}: SuggestionReviewPanelProps) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<SuggestionRow[]>([]);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collectedAsins, setCollectedAsins] = useState<string>("");
  const [assignmentCount, setAssignmentCount] = useState(0);
  // shiftPriceOnMinIncrease removed — suggestions only update Min floor, never live price
  const fetchTokenRef = useRef(0);

  const toggleCollectAsin = (asin: string) => {
    setCollectedAsins((prev) => {
      const list = prev.split(",").map((s) => s.trim()).filter(Boolean);
      if (list.includes(asin)) {
        return list.filter((a) => a !== asin).join(", ");
      }
      return [...list, asin].join(", ");
    });
  };

  const collectedSet = new Set(collectedAsins.split(",").map((s) => s.trim()).filter(Boolean));

  const config = getMarketplaceConfig(marketplace);
  const fmt = (v: number | null) =>
    v != null ? `${config.currencySymbol}${v.toFixed(2)}` : "—";

  const fetchSuggestions = useCallback(async () => {
    if (!user) return;

    const fetchToken = ++fetchTokenRef.current;
    setLoading(true);
    setRows([]);

    try {
      // 1. Fetch all assignments for this marketplace (paged)
      const pageSize = 1000;
      let from = 0;
      const allAssignments: any[] = [];

      while (true) {
        const { data, error } = await supabase
          .from("repricer_assignments")
          .select("id, asin, sku, marketplace, min_price_override, max_price_override, is_enabled")
          .eq("user_id", user.id)
          .eq("marketplace", marketplace)
          .eq("is_enabled", true)
          .order("id", { ascending: true })
          .range(from, from + pageSize - 1);

        if (error) throw error;
        allAssignments.push(...(data || []));
        if ((data || []).length < pageSize) break;
        from += pageSize;
      }

      if (fetchToken !== fetchTokenRef.current) return;
      setAssignmentCount(allAssignments.length);

      if (allAssignments.length === 0) {
        setRows([]);
        return;
      }

      // 2. Fetch the TRUE latest action per assignment in large pages (faster than per-chunk scans)
      const latestByAssignment: Record<string, any> = {};
      const assignmentIds = allAssignments.map((a: any) => a.id);
      const unresolved = new Set(assignmentIds);
      const actionSelect = "assignment_id, asin, sku, marketplace, min_price_suggestion, reason, new_price, old_price, action_type, created_at, intelligence_factors, effective_floor_cents";
      const actionPageSize = 2000;
      let actionFrom = 0;

      while (unresolved.size > 0) {
        const { data: actionPage, error: actionErr } = await supabase
          .from("repricer_price_actions")
          .select(actionSelect)
          .eq("user_id", user.id)
          .eq("marketplace", marketplace)
          .in("assignment_id", assignmentIds)
          .order("created_at", { ascending: false })
          .range(actionFrom, actionFrom + actionPageSize - 1);

        if (actionErr) throw actionErr;
        if (!actionPage?.length) break;

        for (const action of actionPage) {
          if (!latestByAssignment[action.assignment_id]) {
            latestByAssignment[action.assignment_id] = action;
            unresolved.delete(action.assignment_id);
          }
        }

        if (actionPage.length < actionPageSize) break;
        actionFrom += actionPageSize;
      }

      for (const assignmentId of assignmentIds) {
        if (!latestByAssignment[assignmentId]) {
          latestByAssignment[assignmentId] = null;
        }
      }

      if (fetchToken !== fetchTokenRef.current) return;

      // 3. Get inventory data for images/titles/cost in chunks (avoid oversized IN query)
      const asins = [...new Set(allAssignments.map((a: any) => a.asin).filter(Boolean))];
      const invRows: any[] = [];
      const asinChunkSize = 200;

      for (let i = 0; i < asins.length; i += asinChunkSize) {
        const asinChunk = asins.slice(i, i + asinChunkSize);
        const { data: invChunk, error: invErr } = await supabase
          .from("inventory")
          .select("asin, sku, title, image_url, price, min_price, cost, fees_json")
          .eq("user_id", user.id)
          .in("asin", asinChunk);

        if (invErr) throw invErr;
        if (invChunk?.length) invRows.push(...invChunk);
      }

      // 3a. Fetch actual fee data from asin_fee_cache (authoritative source)
      const feeCacheMap: Record<string, { referral_rate: number; fba_fee_fixed: number }> = {};
      for (let i = 0; i < asins.length; i += asinChunkSize) {
        const asinChunk = asins.slice(i, i + asinChunkSize);
        const { data: feeChunk } = await supabase
          .from("asin_fee_cache")
          .select("asin, referral_rate, fba_fee_fixed")
          .eq("user_id", user.id)
          .eq("marketplace", marketplace)
          .in("asin", asinChunk);

        for (const fc of feeChunk || []) {
          feeCacheMap[fc.asin] = { referral_rate: fc.referral_rate, fba_fee_fixed: fc.fba_fee_fixed };
        }
      }

      const invMap: Record<string, any> = {};
      for (const inv of invRows) {
        invMap[inv.sku || inv.asin] = inv;
      }

      // 3b. For non-US marketplaces, fetch local currency prices and FX for cost conversion
      const isNonUs = marketplace !== "US";
      const localPriceMap: Record<string, number> = {};
      const fallbackRates: Record<string, number> = {
        CAD: 1.36,
        MXN: 17.5,
        BRL: 5.0,
        GBP: 0.79,
        EUR: 0.92,
      };
      let costFxRate = 1;

      if (isNonUs) {
        const marketplaceId = config.marketplaceId;

        try {
          const { data: fxData } = await supabase.functions.invoke("get-fx-rates", {
            body: { quote: config.currency },
          });
          const fx = Number(fxData?.rate?.rate);
          costFxRate = Number.isFinite(fx) && fx > 0 ? fx : (fallbackRates[config.currency] || 1);
        } catch {
          costFxRate = fallbackRates[config.currency] || 1;
        }

        for (let i = 0; i < asins.length; i += asinChunkSize) {
          const asinChunk = asins.slice(i, i + asinChunkSize);
          const { data: priceChunk, error: priceErr } = await supabase
            .from("asin_my_price_cache")
            .select("asin, seller_sku, my_price")
            .eq("user_id", user.id)
            .eq("marketplace_id", marketplaceId)
            .in("asin", asinChunk);

          if (priceErr) throw priceErr;

          for (const pc of priceChunk || []) {
            if (pc.my_price != null && pc.my_price > 0) {
              if (pc.seller_sku) localPriceMap[pc.seller_sku] = pc.my_price;
              localPriceMap[pc.asin] = pc.my_price;
            }
          }
        }
      }

      const toMarketplaceCost = (rawCost: number | null | undefined) => {
        if (rawCost == null || rawCost <= 0) return null;
        const converted = isNonUs ? rawCost * costFxRate : rawCost;
        return Math.round(converted * 100) / 100;
      };

      // 3c. Fetch BB status from eval_acks for all ASINs
      const bbStatusMap: Record<string, { is_bb_owner: boolean; buybox_price: number | null; lowest_fba: number | null }> = {};
      for (let i = 0; i < asins.length; i += asinChunkSize) {
        const asinChunk = asins.slice(i, i + asinChunkSize);
        const { data: ackChunk } = await supabase
          .from("repricer_eval_acks")
          .select("asin, is_buybox_owner, buybox_price, lowest_fba_price")
          .eq("user_id", user.id)
          .eq("marketplace", marketplace)
          .in("asin", asinChunk);

        for (const ack of ackChunk || []) {
          bbStatusMap[ack.asin] = {
            is_bb_owner: ack.is_buybox_owner ?? false,
            buybox_price: ack.buybox_price,
            lowest_fba: ack.lowest_fba_price,
          };
        }
      }

      if (fetchToken !== fetchTokenRef.current) return;

      // 4. Build rows
      const result: SuggestionRow[] = allAssignments.map((a: any) => {
        const latestAction = latestByAssignment[a.id];
        const inv = invMap[a.sku] || invMap[a.asin] || {};
        const rawUnitCost = latestAction?.min_price_suggestion?.unit_cost || (inv.cost && inv.cost > 0 ? inv.cost : null);
        const unitCost = toMarketplaceCost(rawUnitCost);

        const currentPrice = isNonUs
          ? (localPriceMap[a.sku] || localPriceMap[a.asin] || null)
          : (inv.price || null);

        const currentMin = isNonUs
          ? (a.min_price_override ?? null)
          : (a.min_price_override ?? inv.min_price ?? null);

        // BB status context
        const bbData = bbStatusMap[a.asin];
        const bbStatus: 'winning' | 'losing' | 'unknown' = bbData
          ? (bbData.is_bb_owner ? 'winning' : 'losing')
          : 'unknown';

        const explicitSuggestion = latestAction?.min_price_suggestion;
        const fallbackSuggestion = buildFallbackSuggestion({
          latestAction,
          currentMin,
          lowestFba: bbData?.lowest_fba ?? null,
          buyboxPrice: bbData?.buybox_price ?? null,
        });
        const suggestion = explicitSuggestion ?? fallbackSuggestion;

        // Detect upward suggestion (would raise min price) — BLOCK all upward suggestions
        const suggestedMin = suggestion?.suggested_min ?? null;
        const isUpward = suggestedMin != null && currentMin != null && suggestedMin > currentMin;

        // If suggestion would raise min, suppress it entirely
        const effectiveSuggestion = isUpward ? null : suggestion;

        const suggestionMarket = getSuggestionMarketContext({
          currentPrice,
          lowestFba: bbData?.lowest_fba ?? null,
        });
        const suggestionSafety = getSuggestionBlockReason({
          suggestedMin,
          currentMin,
        });
        const raiseBlockedReason = suggestionSafety.reason;

        return {
          assignment_id: a.id,
          asin: a.asin,
          sku: a.sku,
          marketplace: a.marketplace,
          image_url: inv.image_url || null,
          title: inv.title || a.asin,
          current_price: currentPrice,
          current_min: currentMin,
          max_price: a.max_price_override ?? null,
          unit_cost: unitCost,
          actual_roi: null,
          suggestion: effectiveSuggestion?.suggested_min != null ? {
            ...effectiveSuggestion,
            projected_roi: null,
            unit_cost: unitCost ?? effectiveSuggestion.unit_cost ?? null,
          } : null,
          last_reason: latestAction?.reason || null,
          bb_status: bbStatus,
          buybox_price: bbData?.buybox_price ?? null,
          lowest_fba: bbData?.lowest_fba ?? null,
          gap_to_lowest_fba_pct: suggestionMarket.gapToLowestFbaPct,
          is_already_lowest_fba: suggestionMarket.isAlreadyLowestFba,
          is_upward_suggestion: isUpward,
          raise_blocked_reason: raiseBlockedReason,
        };
      });

      // 5. Helper to compute ROI for a given price using actual fees
      const computeRoi = (price: number, unitCost: number, asin: string, sku: string | null): number => {
        const inv = invMap[sku || ''] || invMap[asin] || {};
        const fj = inv.fees_json;
        const fc = feeCacheMap[asin];

        let totalFees: number;
        if (fc) {
          const rate = fc.referral_rate > 0 && fc.referral_rate < 1 ? fc.referral_rate : 0.15;
          totalFees = price * rate + fc.fba_fee_fixed;
        } else if (fj && typeof fj === 'object') {
          if (fj.referralFee != null && fj.fbaFee != null) {
            const origPrice = inv.price || price;
            const referralFee = origPrice > 0
              ? (Number(fj.referralFee) / origPrice) * price
              : price * 0.15;
            totalFees = referralFee + Number(fj.fbaFee || 0) + Number(fj.variableClosingFee || 0);
          } else if (fj.referral_rate != null || fj.fba_fee_fixed != null) {
            const rate = Number(fj.referral_rate || 0.15);
            totalFees = price * (rate > 0 && rate < 1 ? rate : 0.15) + Number(fj.fba_fee_fixed || 0);
          } else {
            totalFees = price * 0.15 + price * 0.12;
          }
        } else {
          totalFees = price * 0.15 + price * 0.12;
        }

        const profit = price - unitCost - totalFees;
        return unitCost > 0 ? Math.round((profit / unitCost) * 1000) / 10 : 0;
      };

      // 6. Compute ROI BEFORE filtering so ROI guard works
      for (const row of result) {
        if (!row.unit_cost || row.unit_cost <= 0) continue;

        if (row.suggestion) {
          row.suggestion.projected_roi = computeRoi(row.suggestion.suggested_min, row.unit_cost, row.asin, row.sku);
        }

        if (row.current_min != null && row.current_min > 0) {
          row.actual_roi = computeRoi(row.current_min, row.unit_cost, row.asin, row.sku);
        }
      }

      // 7. Keep all assignments for accurate counts; only suppress invalid upward/negative-ROI suggestions.
      const hydrated = result.map((row) => {
        if (!row.suggestion) return row;
        if (row.raise_blocked_reason) {
          return { ...row, suggestion: null };
        }
        if (row.suggestion.projected_roi != null && row.suggestion.projected_roi < 0) {
          return {
            ...row,
            raise_blocked_reason: "Negative ROI — suggestion suppressed",
            suggestion: null,
          };
        }
        return row;
      });

      hydrated.sort((a, b) => {
        if (a.suggestion && !b.suggestion) return -1;
        if (!a.suggestion && b.suggestion) return 1;
        return 0;
      });

      if (fetchToken !== fetchTokenRef.current) return;
      setRows([...hydrated]);
    } catch (err: any) {
      if (fetchToken === fetchTokenRef.current) {
        console.error("Error fetching suggestions:", err);
        toast.error("Failed to load suggestions");
        setRows([]);
      }
    } finally {
      if (fetchToken === fetchTokenRef.current) {
        setLoading(false);
      }
    }
  }, [user, marketplace, config.marketplaceId]);

  useEffect(() => {
    if (open) {
      setAcceptedIds(new Set());
      setDismissedIds(new Set());
      setSelectedIds(new Set());
      fetchSuggestions();
    }
  }, [open, fetchSuggestions]);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (sectionRows: SuggestionRow[]) => {
    const allSelected = sectionRows.every((r) => selectedIds.has(r.assignment_id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const r of sectionRows) {
        if (allSelected) next.delete(r.assignment_id);
        else next.add(r.assignment_id);
      }
      return next;
    });
  };

  const handleAccept = async (row: SuggestionRow, skipParentNotify = false) => {
    if (!user || !row.suggestion) return;
    if (row.raise_blocked_reason) {
      toast.error(row.raise_blocked_reason);
      return;
    }
    // Block upward suggestions — suggestions can only lower min
    if (row.current_min != null && row.suggestion.suggested_min > row.current_min) {
      toast.error("Suggestions can only lower the minimum price, not raise it");
      return;
    }
    setAcceptingId(row.assignment_id);
    const newMin = row.suggestion.suggested_min;
    const oldMin = row.current_min;

    // Suggestions only update Min floor — NO live price changes
    const shiftedPrice: number | null = null;

    try {
      // Update assignment
      const { error: assignErr } = await supabase
        .from("repricer_assignments")
        .update({
          min_price_override: newMin,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.assignment_id)
        .eq("user_id", user.id);

      if (assignErr) throw assignErr;

      // Update inventory min_price for US
      if (marketplace === "US") {
        const updateQ = supabase
          .from("inventory")
          .update({ min_price: newMin })
          .eq("user_id", user.id);

        const { error: invErr } = row.sku
          ? await updateQ.eq("sku", row.sku)
          : await updateQ.eq("asin", row.asin);
        if (invErr) throw invErr;
      }

      // Suggestions only update Min floor — live price is left to the normal repricer cycle

      // Log action
      const shiftNote = shiftedPrice != null ? ` | Price shifted ${fmt(row.current_price)} → ${fmt(shiftedPrice)}` : "";
      const acceptReason = `Accepted smart suggestion (gap: ${config.currencySymbol}${(row.suggestion.gap_amount || 0).toFixed(2)}, ${(row.suggestion.gap_percent || 0).toFixed(1)}%)${shiftNote}`;

      await supabase
        .from("repricer_price_actions")
        .insert({
          user_id: user.id,
          assignment_id: row.assignment_id,
          asin: row.asin,
          sku: row.sku,
          marketplace,
          old_min_price: oldMin,
          new_min_price: newMin,
          old_price: shiftedPrice != null ? row.current_price : undefined,
          new_price: shiftedPrice,
          action_type: "minmax_change",
          trigger_source: "ui",
          reason: acceptReason,
          success: true,
          min_price_suggestion: null,
        });

      // Log applied suggestion to audit table
      (supabase as any).from("repricer_suggestion_log").insert({
        user_id: user.id,
        asin: row.asin,
        sku: row.sku || null,
        title: row.title || null,
        marketplace,
        old_min: oldMin,
        suggested_min: newMin,
        applied_min: newMin,
        old_price: row.current_price,
        new_price: shiftedPrice,
        roi_before: row.actual_roi,
        roi_after: row.suggestion.projected_roi,
        bb_status: row.bb_status,
        decision: "applied",
        skip_reason: null,
        source: "auto_suggestion",
        assignment_id: row.assignment_id,
      }).then(() => {});

      await logSettingChange({
        asin: row.asin,
        sku: row.sku || undefined,
        marketplace,
        fieldChanged: "min_price",
        oldValue: oldMin,
        newValue: newMin,
        reason: acceptReason,
        source: "ui",
      });

      // Mark accepted in UI
      setAcceptedIds((prev) => new Set(prev).add(row.assignment_id));

      // Update row to clear suggestion
      setRows((prev) =>
        prev.map((r) =>
          r.assignment_id === row.assignment_id
            ? { ...r, suggestion: null, current_min: newMin, current_price: shiftedPrice ?? r.current_price }
            : r
        )
      );

      // Notify parent to set green toggle (skip during batch to avoid race conditions)
      if (!skipParentNotify) {
        onMinPriceAccepted?.(row.asin, row.sku, newMin, shiftedPrice ?? undefined);
        const priceMsg = shiftedPrice != null ? ` | Price → ${fmt(shiftedPrice)}` : "";
        toast.success(`Min price set to ${fmt(newMin)}${priceMsg}`, {
          description: row.asin,
        });
      }
    } catch (err: any) {
      toast.error("Failed: " + err.message);
    } finally {
      setAcceptingId(null);
    }
  };

  const [acceptingAll, setAcceptingAll] = useState(false);

  const withSuggestion = rows.filter((r) => r.suggestion && !acceptedIds.has(r.assignment_id) && !dismissedIds.has(r.assignment_id));
  const safeSuggestions = withSuggestion.filter((r) => !r.raise_blocked_reason);
  const riskySuggestions = withSuggestion.filter((r) => r.raise_blocked_reason);
  const withoutSuggestion = rows.filter((r) => !r.suggestion || acceptedIds.has(r.assignment_id) || dismissedIds.has(r.assignment_id));

  const handleAcceptAll = async () => {
    if (!user || safeSuggestions.length === 0) return;
    setAcceptingAll(true);
    const acceptedItems: { asin: string; sku: string | null; newMin: number }[] = [];
    for (const row of safeSuggestions) {
      if (!row.suggestion) continue;
      // Block upward suggestions in batch too
      if (row.current_min != null && row.suggestion.suggested_min > row.current_min) continue;
      try {
        await handleAccept(row, true);
        acceptedItems.push({ asin: row.asin, sku: row.sku, newMin: row.suggestion.suggested_min });
      } catch {
        // handleAccept already toasts errors
      }
    }
    // Batch-notify parent after all DB writes complete
    for (const item of acceptedItems) {
      onMinPriceAccepted?.(item.asin, item.sku, item.newMin);
    }
    setAcceptingAll(false);
    toast.success(`Accepted ${acceptedItems.length} suggestions`);
  };

  const handleCopyAcceptedAsins = () => {
    const asins = rows
      .filter((r) => acceptedIds.has(r.assignment_id))
      .map((r) => r.asin);
    if (asins.length === 0) {
      toast.info("No accepted suggestions to copy");
      return;
    }
    navigator.clipboard.writeText(asins.join(","));
    toast.success(`Copied ${asins.length} ASINs to clipboard`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[95vw] !max-h-[95vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <Lightbulb className="h-5 w-5 text-amber-500" />
            Suggestion Review
            <Badge variant="outline" className="text-xs font-mono">{config.flag} {marketplace}</Badge>
            <Badge variant="default">{withSuggestion.length} pending</Badge>
            <Badge variant="secondary">{withoutSuggestion.length} no suggestion</Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchSuggestions}
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
            {withSuggestion.length > 0 && (
              <>
                <Button
                  size="sm"
                  variant="default"
                  className="h-7 text-xs"
                  disabled={acceptingAll || acceptingId !== null}
                  onClick={handleAcceptAll}
                >
                  {acceptingAll ? (
                    <RefreshCw className="h-3 w-3 animate-spin mr-1" />
                  ) : (
                    <CheckCheck className="h-3 w-3 mr-1" />
                  )}
                  Accept Safe ({safeSuggestions.length}){riskySuggestions.length > 0 ? ` · ${riskySuggestions.length} risky skipped` : ''}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    const asins = withSuggestion.map((r) => r.asin);
                    navigator.clipboard.writeText(asins.join(","));
                    toast.success(`Copied ${asins.length} suggested ASINs`);
                  }}
                >
                  <Copy className="h-3 w-3 mr-1" />
                  Copy Suggested ASINs ({withSuggestion.length})
                </Button>
              </>
            )}
            {selectedIds.size > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => {
                  const asins = rows.filter((r) => selectedIds.has(r.assignment_id)).map((r) => r.asin);
                  navigator.clipboard.writeText(asins.join(","));
                  toast.success(`Copied ${asins.length} selected ASINs`);
                }}
              >
                <Copy className="h-3 w-3 mr-1" />
                Copy Selected ({selectedIds.size})
              </Button>
            )}
            {acceptedIds.size > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={handleCopyAcceptedAsins}
              >
                <Copy className="h-3 w-3 mr-1" />
                Copy Accepted ASINs ({acceptedIds.size})
              </Button>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Info banner: suggestions only change Min floor */}
        <div className="flex items-center gap-3 px-2 py-1.5 rounded-md bg-muted/50 mb-2 text-xs text-muted-foreground">
          <Lightbulb className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          Suggestions only lower the Min floor — live price changes are handled by the normal repricer cycle.
        </div>

        <div className="flex gap-2 items-center mb-3 px-1">
          <ClipboardList className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="relative flex-1">
            <input
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pr-16"
              placeholder="Click ASINs below to collect them here..."
              value={collectedAsins}
              onChange={(e) => setCollectedAsins(e.target.value)}
            />
            {collectedAsins.trim() && (
              <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5">
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setCollectedAsins("")}>
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => {
                  navigator.clipboard.writeText(collectedAsins.trim());
                  toast.success(`Copied ${collectedSet.size} ASINs`);
                }}>
                  <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </div>
            )}
          </div>
          <span className="text-xs text-muted-foreground whitespace-nowrap">{collectedSet.size} ASINs</span>
        </div>

        <ScrollArea className="h-[80vh]">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-6">
              {/* Risk summary banner */}
              {(() => {
                const riskyCount = riskySuggestions.length;
                if (riskyCount === 0) return null;
                return (
                  <div className="flex items-center gap-2 p-2.5 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 text-xs">
                    <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
                    <span className="text-foreground">
                      <strong>{riskyCount}</strong> suggestion{riskyCount !== 1 ? 's' : ''} hidden because it would raise Min.
                    </span>
                  </div>
                );
              })()}

              {/* Suggestions Section */}
              {withSuggestion.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-amber-600 dark:text-amber-400 mb-2 flex items-center gap-1.5">
                    <Lightbulb className="h-4 w-4" />
                    With Suggestion ({withSuggestion.length})
                  </h3>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-7">
                          <Checkbox
                            checked={withSuggestion.length > 0 && withSuggestion.every((r) => selectedIds.has(r.assignment_id))}
                            onCheckedChange={() => toggleSelectAll(withSuggestion)}
                          />
                        </TableHead>
                        <TableHead className="w-9"></TableHead>
                        <TableHead className="w-[180px]">Product</TableHead>
                        <TableHead className="text-right w-[70px]">Cost</TableHead>
                        <TableHead className="text-right w-[75px]">Cur Min</TableHead>
                        <TableHead className="text-right w-[75px]">Sug Min</TableHead>
                        <TableHead className="text-right w-[55px]">Gap</TableHead>
                        <TableHead className="w-[75px]">BB Status</TableHead>
                        <TableHead className="text-right w-[60px]">ROI</TableHead>
                        <TableHead className="text-right w-[65px]">Sug ROI</TableHead>
                        <TableHead className="w-[90px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {withSuggestion.map((row) => (
                        <TableRow key={row.assignment_id}>
                          <TableCell>
                            <Checkbox
                              checked={selectedIds.has(row.assignment_id)}
                              onCheckedChange={() => toggleSelected(row.assignment_id)}
                            />
                          </TableCell>
                          <TableCell>
                            {row.image_url ? (
                              <img
                                src={row.image_url}
                                alt=""
                                className="h-8 w-8 rounded object-contain border border-border bg-muted"
                              />
                            ) : (
                              <div className="h-8 w-8 rounded bg-muted" />
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="max-w-[170px] truncate">
                              <div
                                className={`text-xs font-mono cursor-pointer hover:underline ${
                                  collectedSet.has(row.asin) ? "text-primary font-bold" : "text-muted-foreground"
                                }`}
                                onClick={() => toggleCollectAsin(row.asin)}
                              >
                                {row.asin}
                              </div>
                              <div className="text-xs truncate">{row.title}</div>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs text-muted-foreground">
                            {row.unit_cost != null && row.unit_cost > 0
                              ? fmt(row.unit_cost)
                              : <span className="text-destructive">No COG</span>}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {fmt(row.current_min)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm font-semibold text-amber-600 dark:text-amber-400">
                            {fmt(row.suggestion!.suggested_min)}
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            {row.suggestion!.gap_amount != null && (
                              <span className="text-amber-600 dark:text-amber-400">
                                {config.currencySymbol}{(row.suggestion!.gap_amount).toFixed(2)} ({(row.suggestion!.gap_percent || 0).toFixed(1)}%)
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-col gap-0.5">
                              <BbStatusBadge
                                rawStatus={row.bb_status}
                                myPrice={row.current_price}
                                buyboxPrice={row.buybox_price}
                                compact
                              />
                              {row.raise_blocked_reason && (
                                <span className="text-[9px] text-destructive flex items-center gap-0.5">
                                  <ShieldAlert className="h-2.5 w-2.5 shrink-0" />
                                  {row.raise_blocked_reason}
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            {row.unit_cost == null || row.unit_cost <= 0
                              ? <span className="text-muted-foreground">—</span>
                              : row.actual_roi != null
                                ? <span className={row.actual_roi >= 0 ? 'text-green-600 dark:text-green-400' : 'text-destructive'}>
                                    {row.actual_roi.toFixed(1)}%
                                  </span>
                                : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className="text-right text-xs">
                            {row.unit_cost == null || row.unit_cost <= 0
                              ? <span className="text-muted-foreground">—</span>
                              : row.suggestion!.projected_roi != null
                                ? <span className={row.suggestion!.projected_roi >= 0 ? 'text-green-600 dark:text-green-400' : 'text-destructive'}>
                                    {row.suggestion!.projected_roi.toFixed(1)}%
                                  </span>
                                : <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground inline" />}
                          </TableCell>
                          <TableCell>
                          <div className="flex gap-1">
                            {(() => {
                              const canAcceptSuggestion = !row.raise_blocked_reason;
                              const actionTitle = row.raise_blocked_reason || (!canAcceptSuggestion ? "Suggestion blocked" : undefined);
                              return (
                                <Button
                                  size="sm"
                                  variant="default"
                                  className="h-7 text-xs"
                                  disabled={acceptingId === row.assignment_id || !canAcceptSuggestion}
                                  onClick={() => handleAccept(row)}
                                  title={actionTitle}
                                >
                                  {acceptingId === row.assignment_id ? (
                                    <RefreshCw className="h-3 w-3 animate-spin mr-1" />
                                  ) : !canAcceptSuggestion ? (
                                    <ShieldAlert className="h-3 w-3 mr-1" />
                                  ) : (
                                    <Check className="h-3 w-3 mr-1" />
                                  )}
                                  {canAcceptSuggestion ? 'Accept' : 'Blocked'}
                                </Button>
                              );
                            })()}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                              onClick={() => setDismissedIds((prev) => new Set(prev).add(row.assignment_id))}
                              title="Dismiss suggestion"
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* No Suggestion Section */}
              {withoutSuggestion.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
                    <Minus className="h-4 w-4" />
                    No Suggestion ({withoutSuggestion.length})
                  </h3>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-7">
                          <Checkbox
                            checked={withoutSuggestion.length > 0 && withoutSuggestion.every((r) => selectedIds.has(r.assignment_id))}
                            onCheckedChange={() => toggleSelectAll(withoutSuggestion)}
                          />
                        </TableHead>
                        <TableHead className="w-9"></TableHead>
                        <TableHead className="w-[180px]">Product</TableHead>
                        <TableHead className="text-right w-[75px]">Cur Min</TableHead>
                        <TableHead>Last Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {withoutSuggestion.map((row) => (
                        <TableRow key={row.assignment_id}>
                          <TableCell>
                            <Checkbox
                              checked={selectedIds.has(row.assignment_id)}
                              onCheckedChange={() => toggleSelected(row.assignment_id)}
                            />
                          </TableCell>
                          <TableCell>
                            {row.image_url ? (
                              <img
                                src={row.image_url}
                                alt=""
                                className="h-8 w-8 rounded object-contain border border-border bg-muted"
                              />
                            ) : (
                              <div className="h-8 w-8 rounded bg-muted" />
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="max-w-[280px]">
                              <div
                                className={`text-xs font-mono cursor-pointer hover:underline ${
                                  collectedSet.has(row.asin) ? "text-primary font-bold" : "text-muted-foreground"
                                }`}
                                onClick={() => toggleCollectAsin(row.asin)}
                              >
                                {row.asin}
                              </div>
                              <div className="text-xs truncate">{row.title}</div>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {fmt(row.current_min)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                          {acceptedIds.has(row.assignment_id) ? (
                              <Badge variant="default" className="text-[10px]">
                                <Check className="h-3 w-3 mr-0.5" /> Accepted
                              </Badge>
                            ) : dismissedIds.has(row.assignment_id) ? (
                              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                                <X className="h-3 w-3 mr-0.5" /> Dismissed
                              </Badge>
                            ) : (
                              row.last_reason || "—"
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {rows.length === 0 && !loading && (
                <div className="text-center py-12 text-muted-foreground">
                  {assignmentCount === 0 ? "No enabled assignments found" : "No current Min-lowering suggestions"}
                </div>
              )}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
