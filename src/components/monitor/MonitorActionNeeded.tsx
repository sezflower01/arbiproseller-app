import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ChevronRight, Zap, Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type { MonitorData, QuotaTimeWindow } from "@/hooks/use-monitor-data";

interface ActionItem {
  severity: "red" | "amber" | "gray";
  label: string;
  count: number;
  section?: string;
  fixAction?: () => Promise<void>;
  fixLabel?: string;
  explain: string;
  actionHint: "fix" | "review" | "none";
}

interface Props {
  data: MonitorData;
  freshnessData?: { hotSlaBreachCount: number; hotTrulyStalCount: number; hotEvaluatedButBlockedCount: number };
  stalledCount?: number;
  missingMinCount?: number;
  notCheckedTodayCount?: number;
  floorBlockedManualCount?: number;
  floorBlockedAutoCount?: number;
  onNavigate?: (section: string) => void;
  onRefresh?: () => void;
  timeWindow: QuotaTimeWindow;
  onTimeWindowChange: (w: QuotaTimeWindow) => void;
}

const TIME_LABELS: Record<QuotaTimeWindow, string> = { "1h": "Last 1h", "4h": "Last 4h", "12h": "Last 12h", "24h": "Last 24h" };

export default function MonitorActionNeeded({
  data,
  freshnessData,
  stalledCount = 0,
  missingMinCount = 0,
  notCheckedTodayCount = 0,
  floorBlockedManualCount = 0,
  floorBlockedAutoCount = 0,
  onNavigate,
  onRefresh,
  timeWindow,
  onTimeWindowChange,
}: Props) {
  const [fixingMin, setFixingMin] = useState(false);

  const handleQuickFillMin = async () => {
    setFixingMin(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      // First preview
      const preview = await supabase.functions.invoke("backfill-repricer-min-max", {
        body: { dryRun: true },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (preview.error) throw new Error(preview.error.message);
      
      const safeCount = (preview.data?.rows || []).filter((r: any) => !r.isInvalidSuggestion).length;
      if (safeCount === 0) {
        toast.info("No safe updates available — all need manual review. Go to Setup Readiness for details.");
        return;
      }

      // Apply safe ones
      const apply = await supabase.functions.invoke("backfill-repricer-min-max", {
        body: { dryRun: false },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (apply.error) throw new Error(apply.error.message);
      
      const { applied, invalidExcluded, skipped } = apply.data;
      toast.success(`Auto-filled ${applied} assignments. ${invalidExcluded > 0 ? `${invalidExcluded} need manual review.` : ""} ${skipped > 0 ? `${skipped} skipped (no data).` : ""}`);
      onRefresh?.();
    } catch (err: any) {
      toast.error(`Auto-fill failed: ${err.message}`);
    } finally {
      setFixingMin(false);
    }
  };

  const actions: ActionItem[] = [];

  if (freshnessData && freshnessData.hotTrulyStalCount > 0) {
    actions.push({
      severity: "red",
      label: "HOT ASINs truly stale (missed by scheduler)",
      count: freshnessData.hotTrulyStalCount,
      section: "freshness",
      explain: "These urgent items were NOT evaluated recently — the scheduler missed them. This is a real SLA breach.",
      actionHint: "review",
    });
  }

  if (freshnessData && freshnessData.hotEvaluatedButBlockedCount > 0) {
    actions.push({
      severity: "gray",
      label: "HOT ASINs evaluated but blocked >30m",
      count: freshnessData.hotEvaluatedButBlockedCount,
      section: "freshness",
      explain: "These items were checked by the scheduler but no price change was possible (guard/filter/no-comp). Not a scheduler miss — this is normal.",
      actionHint: "none",
    });
  }

  if (missingMinCount > 0) {
    actions.push({
      severity: "amber",
      label: "Assignments missing min_price",
      count: missingMinCount,
      section: "setup",
      fixAction: handleQuickFillMin,
      fixLabel: "Auto-Fill",
      explain: "These items can't be repriced because no minimum price is set. Without a floor, the system won't risk lowering your price.",
      actionHint: "fix",
    });
  }

  if (floorBlockedManualCount > 0) {
    actions.push({
      severity: "red",
      label: "Floor-blocked — needs your action (auto-floor OFF or exhausted)",
      count: floorBlockedManualCount,
      section: "setup",
      explain: "These ASINs are losing the Buy Box because your min price is too high, and auto-floor is either disabled or has hit its safety limit. You need to manually lower the min price to compete.",
      actionHint: "fix",
    });
  }

  if (floorBlockedAutoCount > 0) {
    actions.push({
      severity: "gray",
      label: "Floor-blocked — auto-floor is handling it",
      count: floorBlockedAutoCount,
      section: "setup",
      explain: "These ASINs are blocked by the min floor, but auto-floor is active or waiting to lower automatically. No action needed — the system will adjust.",
      actionHint: "none",
    });
  }

  if (stalledCount > 0) {
    actions.push({
      severity: "amber",
      label: "Constrained assignments (delta collapsed by guards)",
      count: stalledCount,
      section: "stalled",
      explain: "The system evaluated these items but your profit rules or market conditions prevented a price change. This usually means your protections are working correctly.",
      actionHint: "none",
    });
  }

  const windowKey = timeWindow === "1h" ? "h1" : timeWindow === "4h" ? "h4" : timeWindow === "12h" ? "h12" : "h24";
  const quotaErrorsInWindow = data.quotaHealth.quotaErrorWindows?.[windowKey] ?? data.quotaHealth.quotaErrors24h;

  if (quotaErrorsInWindow > 0) {
    actions.push({
      severity: quotaErrorsInWindow > 5 ? "red" : "amber",
      label: `Quota / throttle errors (${TIME_LABELS[timeWindow]})`,
      count: quotaErrorsInWindow,
      section: "quota",
      explain: "Amazon temporarily limited API requests. The system retries automatically — this usually resolves on its own within minutes.",
      actionHint: quotaErrorsInWindow > 5 ? "review" : "none",
    });
  }

  if (data.profitGuardBlocks > 0) {
    actions.push({
      severity: "amber",
      label: "Profit Guard blocked",
      count: data.profitGuardBlocks,
      section: "health",
      explain: "The system wanted to lower prices on these items but stopped because it would reduce your profit below the minimum. Your money is being protected.",
      actionHint: "none",
    });
  }

  if (notCheckedTodayCount > 0) {
    actions.push({
      severity: "gray",
      label: "Eligible not checked today",
      count: notCheckedTodayCount,
      section: "coverage",
      explain: "These items haven't been evaluated yet today. They'll be checked as the system rotates through your catalog.",
      actionHint: "none",
    });
  }

  const order = { red: 0, amber: 1, gray: 2 };
  actions.sort((a, b) => order[a.severity] - order[b.severity]);

  if (actions.length === 0) {
    return (
      <Card className="border-green-500/20 bg-green-500/5">
        <CardContent className="p-4 text-sm text-green-700 dark:text-green-400 font-medium">
          ✅ No action items right now — system is clean.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-amber-500/25 bg-amber-500/5">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Action Needed
          <Select value={timeWindow} onValueChange={(v) => onTimeWindowChange(v as QuotaTimeWindow)}>
            <SelectTrigger className="h-6 w-[100px] text-[10px] ml-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1h">Last 1h</SelectItem>
              <SelectItem value="4h">Last 4h</SelectItem>
              <SelectItem value="12h">Last 12h</SelectItem>
              <SelectItem value="24h">Last 24h</SelectItem>
            </SelectContent>
          </Select>
          <Badge variant="outline" className="ml-auto text-[10px]">{actions.length} items</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-1">
        {actions.map((a, i) => (
          <div
            key={i}
            className={`rounded-md px-3 py-2 text-sm cursor-pointer hover:bg-muted/50 transition-colors ${
              a.severity === "red"
                ? "bg-destructive/5"
                : a.severity === "amber"
                ? "bg-amber-500/5"
                : "bg-muted/20"
            }`}
            onClick={() => a.section && onNavigate?.(a.section)}
          >
            <div className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  a.severity === "red" ? "bg-destructive" : a.severity === "amber" ? "bg-amber-500" : "bg-muted-foreground"
                }`}
              />
              <span className="font-medium text-foreground">{a.count}</span>
              <span className="text-muted-foreground flex-1">{a.label}</span>
              {a.fixAction && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-xs px-2"
                  disabled={fixingMin}
                  onClick={(e) => {
                    e.stopPropagation();
                    a.fixAction?.();
                  }}
                >
                  {fixingMin ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3 mr-1" />}
                  {a.fixLabel}
                </Button>
              )}
              {a.actionHint === "fix" && <span className="text-[9px] font-bold text-destructive">FIX NOW</span>}
              {a.actionHint === "review" && <span className="text-[9px] font-bold text-amber-600 dark:text-amber-400">REVIEW</span>}
              {a.actionHint === "none" && <span className="text-[9px] text-muted-foreground">NO ACTION</span>}
              {a.section && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1 ml-4 leading-relaxed">{a.explain}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
