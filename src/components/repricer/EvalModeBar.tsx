import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Brain, Zap, RefreshCw, ArrowRightLeft } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type Timeframe = "now" | "1h" | "4h" | "24h";

interface ModeCounts {
  smart: number;
  basic: number;
  forceSmartCount: number;
  forceBasicCount: number;
  autoSmartCount: number;
  autoBasicCount: number;
  switchedToBasic: number;
  switchedToSmart: number;
}

interface EvalModeBarProps {
  marketplace: string;
}

export default function EvalModeBar({ marketplace }: EvalModeBarProps) {
  const { user } = useAuth();
  const [timeframe, setTimeframe] = useState<Timeframe>("now");
  const [counts, setCounts] = useState<ModeCounts | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchCounts = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      // Fetch active assignments for this marketplace
      const { data, error } = await (supabase as any)
        .from("repricer_assignments")
        .select("eval_mode, active_eval_mode, eval_mode_switched_at, eval_mode_reason, status")
        .eq("user_id", user.id)
        .eq("marketplace", marketplace)
        .eq("status", "active");

      if (error || !data) {
        setCounts(null);
        return;
      }

      const now = new Date();
      const hoursMap: Record<Timeframe, number | null> = {
        now: null,
        "1h": 1,
        "4h": 4,
        "24h": 24,
      };
      const hours = hoursMap[timeframe];
      const cutoff = hours ? new Date(now.getTime() - hours * 60 * 60 * 1000) : null;

      const result: ModeCounts = {
        smart: 0,
        basic: 0,
        forceSmartCount: 0,
        forceBasicCount: 0,
        autoSmartCount: 0,
        autoBasicCount: 0,
        switchedToBasic: 0,
        switchedToSmart: 0,
      };

      for (const row of data) {
        const active = row.active_eval_mode || "smart";
        const mode = row.eval_mode || "auto";

        if (active === "smart") result.smart++;
        else result.basic++;

        if (mode === "force_smart") result.forceSmartCount++;
        else if (mode === "force_basic") result.forceBasicCount++;
        else if (active === "smart") result.autoSmartCount++;
        else result.autoBasicCount++;

        // Count switches within timeframe
        if (row.eval_mode_switched_at && cutoff) {
          const switchedAt = new Date(row.eval_mode_switched_at);
          if (switchedAt >= cutoff) {
            if (active === "basic") result.switchedToBasic++;
            else result.switchedToSmart++;
          }
        }
      }

      setCounts(result);
    } finally {
      setLoading(false);
    }
  }, [user, marketplace, timeframe]);

  useEffect(() => {
    fetchCounts();
  }, [fetchCounts]);

  // Auto-refresh every 60s
  useEffect(() => {
    const interval = setInterval(fetchCounts, 60_000);
    return () => clearInterval(interval);
  }, [fetchCounts]);

  if (!counts && !loading) return null;

  const total = counts ? counts.smart + counts.basic : 0;
  const smartPct = total > 0 ? Math.round((counts!.smart / total) * 100) : 0;
  const basicPct = total > 0 ? 100 - smartPct : 0;
  const timeframes: Timeframe[] = ["now", "1h", "4h", "24h"];

  return (
    <div className="rounded-lg border bg-card p-3 mb-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        {/* Left: Title + bar */}
        <div className="flex items-center gap-3 flex-1 min-w-[200px]">
          <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
            Eval Mode
          </span>

          {loading && !counts ? (
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />
          ) : counts ? (
            <>
              {/* Mini progress bar */}
              <div className="flex h-2.5 rounded-full overflow-hidden bg-muted flex-1 max-w-[200px]">
                {smartPct > 0 && (
                  <div
                    className="bg-violet-500 transition-all"
                    style={{ width: `${smartPct}%` }}
                  />
                )}
                {basicPct > 0 && (
                  <div
                    className="bg-amber-500 transition-all"
                    style={{ width: `${basicPct}%` }}
                  />
                )}
              </div>

              {/* Smart/Basic counts */}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-2">
                      <span className="flex items-center gap-1 text-xs">
                        <Brain className="h-3 w-3 text-violet-500" />
                        <span className="font-medium">{counts.smart}</span>
                        <span className="text-muted-foreground">({smartPct}%)</span>
                      </span>
                      <span className="flex items-center gap-1 text-xs">
                        <Zap className="h-3 w-3 text-amber-500" />
                        <span className="font-medium">{counts.basic}</span>
                        <span className="text-muted-foreground">({basicPct}%)</span>
                      </span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs space-y-1">
                    <p>Auto → Smart: {counts.autoSmartCount}</p>
                    <p>Auto → Basic: {counts.autoBasicCount}</p>
                    <p>Force Smart: {counts.forceSmartCount}</p>
                    <p>Force Basic: {counts.forceBasicCount}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              {/* Switch activity (only when timeframe != now) */}
              {timeframe !== "now" && (counts.switchedToBasic > 0 || counts.switchedToSmart > 0) && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground border-l pl-2 ml-1">
                        <ArrowRightLeft className="h-3 w-3" />
                        {counts.switchedToBasic + counts.switchedToSmart} switches
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="text-xs space-y-1">
                      <p>→ Basic: {counts.switchedToBasic}</p>
                      <p>→ Smart: {counts.switchedToSmart}</p>
                      <p className="text-muted-foreground">In last {timeframe}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </>
          ) : null}
        </div>

        {/* Right: Timeframe + refresh */}
        <div className="flex items-center gap-1">
          {timeframes.map((tf) => (
            <Button
              key={tf}
              variant={timeframe === tf ? "default" : "ghost"}
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => setTimeframe(tf)}
            >
              {tf === "now" ? "Now" : tf}
            </Button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 ml-1"
            onClick={fetchCounts}
            disabled={loading}
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>
    </div>
  );
}
