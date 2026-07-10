import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Brain, Zap, Settings2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ModeCount {
  smart: number;
  basic: number;
  forceSmartCount: number;
  forceBasicCount: number;
  autoSmartCount: number;
  autoBasicCount: number;
}

export default function EvalModeDistributionPanel() {
  const [counts, setCounts] = useState<ModeCount | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchCounts = async () => {
    setLoading(true);
    try {
      const { data, error } = await (supabase as any)
        .from("repricer_assignments")
        .select("eval_mode, active_eval_mode")
        .eq("status", "active");

      if (error || !data) {
        setCounts(null);
        return;
      }

      const result: ModeCount = {
        smart: 0,
        basic: 0,
        forceSmartCount: 0,
        forceBasicCount: 0,
        autoSmartCount: 0,
        autoBasicCount: 0,
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
      }

      setCounts(result);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCounts();
  }, []);

  if (!counts && !loading) return null;

  const total = counts ? counts.smart + counts.basic : 0;
  const smartPct = total > 0 ? Math.round((counts!.smart / total) * 100) : 0;
  const basicPct = total > 0 ? 100 - smartPct : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Brain className="h-4 w-4 text-violet-500" />
            Eval Mode Distribution
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={fetchCounts} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading && !counts ? (
          <div className="h-16 flex items-center justify-center">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
          </div>
        ) : counts ? (
          <div className="space-y-4">
            {/* Bar */}
            <div className="flex h-4 rounded-full overflow-hidden bg-muted">
              {smartPct > 0 && (
                <div
                  className="bg-violet-500 transition-all"
                  style={{ width: `${smartPct}%` }}
                  title={`Smart: ${counts.smart}`}
                />
              )}
              {basicPct > 0 && (
                <div
                  className="bg-amber-500 transition-all"
                  style={{ width: `${basicPct}%` }}
                  title={`Basic: ${counts.basic}`}
                />
              )}
            </div>

            {/* Counts */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Brain className="h-3.5 w-3.5 text-violet-500" />
                  <span className="text-sm font-medium">Smart</span>
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    {counts.smart}
                  </Badge>
                </div>
                <div className="text-[11px] text-muted-foreground pl-5 space-y-0.5">
                  <div>Auto → Smart: {counts.autoSmartCount}</div>
                  <div>Force Smart: {counts.forceSmartCount}</div>
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Zap className="h-3.5 w-3.5 text-amber-500" />
                  <span className="text-sm font-medium">Basic</span>
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    {counts.basic}
                  </Badge>
                </div>
                <div className="text-[11px] text-muted-foreground pl-5 space-y-0.5">
                  <div>Auto → Basic: {counts.autoBasicCount}</div>
                  <div>Force Basic: {counts.forceBasicCount}</div>
                </div>
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground">
              {smartPct}% Smart / {basicPct}% Basic — {total} active assignments
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
