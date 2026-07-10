import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileText, Copy, Check, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

interface LiveMetrics {
  totalAssignments: number;
  activeWithRules: number;
  eligibleAssignments: number;
  disabledAssignments: number;
  totalActions24h: number;
  priceChanges24h: number;
  errors24h: number;
  uniqueAsinsChecked24h: number;
  coveragePct: number;
  evalsByTrigger: Record<string, number>;
  topErrors: { message: string; count: number }[];
  reconPending: number;
  reconVerified: number;
  reconMismatch: number;
  avgWriteLatencyMs: number | null;
  settingsCapPerMin: number;
  schedulerEnabled: boolean;
  sweepEnabled: boolean;
  sweepBatch: number;
  sweepInterval: number;
  safeMode: boolean;
  queuePaused: boolean;
  writesPerHour: { hour: string; count: number }[];
  constraintBreakdown: Record<string, number>;
  bbWins: number;
  bbLosses: number;
}

function formatNum(n: number): string {
  return n.toLocaleString();
}

function buildReportText(m: LiveMetrics): string {
  const now = new Date().toISOString().split("T")[0];
  const evalLines = Object.entries(m.evalsByTrigger)
    .sort((a, b) => b[1] - a[1])
    .map(([src, cnt]) => `| ${src} | ${formatNum(cnt)} |`)
    .join("\n");

  const errorLines = m.topErrors.length > 0
    ? m.topErrors.map((e) => `| ${e.message.slice(0, 80)} | ${e.count} |`).join("\n")
    : "| No errors in the last 24 hours | — |";

  const constraintLines = Object.entries(m.constraintBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, cnt]) => `| ${reason.slice(0, 60)} | ${cnt} |`)
    .join("\n");

  const throughputLines = m.writesPerHour
    .map((h) => `| ${h.hour} | ${h.count} |`)
    .join("\n");

  return `# Repricer Live Performance Report
Generated: ${now}

## System Configuration
| Setting | Value |
|---------|-------|
| Scheduler Enabled | ${m.schedulerEnabled ? "✅ Yes" : "❌ No"} |
| SP-API Calls/Min Cap | ${m.settingsCapPerMin} |
| Sweep Enabled | ${m.sweepEnabled ? "✅ Yes" : "❌ No"} |
| Sweep Batch Size | ${m.sweepBatch} |
| Sweep Interval | ${m.sweepInterval} min |
| Safe Mode | ${m.safeMode ? "🔴 ACTIVE" : "✅ Off"} |
| Queue Paused | ${m.queuePaused ? "🔴 PAUSED" : "✅ Running"} |

## Catalog Overview
| Metric | Value |
|--------|-------|
| Total Assignments | ${formatNum(m.totalAssignments)} |
| Active with Rules (Eligible) | ${formatNum(m.eligibleAssignments)} |
| Disabled | ${formatNum(m.disabledAssignments)} |
| Active with Rules | ${formatNum(m.activeWithRules)} |

## 24-Hour Performance (Live Data)
| Metric | Value |
|--------|-------|
| Total Actions Logged | ${formatNum(m.totalActions24h)} |
| Price Changes Applied | ${formatNum(m.priceChanges24h)} |
| Errors | ${formatNum(m.errors24h)} |
| Unique ASINs Checked | ${formatNum(m.uniqueAsinsChecked24h)} / ${formatNum(m.eligibleAssignments)} (${m.coveragePct.toFixed(1)}%) |
| Write Conversion Rate | ${m.totalActions24h > 0 ? ((m.priceChanges24h / m.totalActions24h) * 100).toFixed(1) : 0}% |

## Evaluations by Source (24h)
| Trigger Source | Count |
|----------------|-------|
${evalLines || "| No evaluations | — |"}

## Reconciliation Status (24h)
| Status | Count |
|--------|-------|
| Pending | ${formatNum(m.reconPending)} |
| Verified | ${formatNum(m.reconVerified)} |
| Mismatch | ${formatNum(m.reconMismatch)} |

## Buy Box Ownership (Live Snapshot)
| Metric | Count |
|--------|-------|
| Winning Buy Box | ${formatNum(m.bbWins)} |
| Not Winning Buy Box | ${formatNum(m.bbLosses)} |
| Win Rate | ${(m.bbWins + m.bbLosses) > 0 ? ((m.bbWins / (m.bbWins + m.bbLosses)) * 100).toFixed(1) + "%" : "N/A"} |

## Constraint Breakdown (24h — Why Prices Weren't Changed)
| Constraint | Count |
|-----------|-------|
${constraintLines || "| No constraints recorded | — |"}

## Top Errors (24h)
| Error | Count |
|-------|-------|
${errorLines}

## Hourly Write Throughput (Last 12h)
| Hour | Writes |
|------|--------|
${throughputLines || "| No writes | — |"}

---

## Health Assessment

${m.coveragePct >= 90 ? "✅ **Coverage: Excellent** — " + m.coveragePct.toFixed(0) + "% of eligible ASINs checked in 24h" :
  m.coveragePct >= 60 ? "🟡 **Coverage: Moderate** — " + m.coveragePct.toFixed(0) + "% coverage. Consider increasing SP-API cap or sweep batch." :
  "🔴 **Coverage: Low** — Only " + m.coveragePct.toFixed(0) + "% coverage. Increase sp_api_calls_per_minute_cap."}

${m.errors24h === 0 ? "✅ **Error Rate: Clean** — No errors in 24h" :
  m.errors24h < 10 ? "🟡 **Error Rate: Minor** — " + m.errors24h + " errors. Check top errors above." :
  "🔴 **Error Rate: High** — " + m.errors24h + " errors. Investigate immediately."}

${m.reconMismatch === 0 ? "✅ **Reconciliation: Perfect** — All verified prices match submissions" :
  "🟡 **Reconciliation: " + m.reconMismatch + " mismatches** — Amazon may have rejected some price updates"}

${m.safeMode ? "🔴 **Safe Mode is ACTIVE** — The system has throttled itself due to errors" : "✅ **Safe Mode: Off** — System operating normally"}

${m.queuePaused ? "🔴 **Queue is PAUSED** — No new evaluations are being dispatched" : "✅ **Queue: Running** — Evaluations are being dispatched normally"}

${(() => {
  const total = m.bbWins + m.bbLosses;
  if (total === 0) return "⚪ **Buy Box: No data** — No active assignments with BB status";
  const rate = (m.bbWins / total) * 100;
  if (rate >= 70) return "✅ **Buy Box: Strong** — " + rate.toFixed(0) + "% win rate (" + m.bbWins + "/" + total + ")";
  if (rate >= 40) return "🟡 **Buy Box: Moderate** — " + rate.toFixed(0) + "% win rate. Review losing ASINs.";
  return "🔴 **Buy Box: Low** — Only " + rate.toFixed(0) + "% win rate. Check pricing strategy.";
})()}
`;
}

export default function OptimizationReportDialog() {
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [metrics, setMetrics] = useState<LiveMetrics | null>(null);
  const [open, setOpen] = useState(false);

  const fetchMetrics = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const now = new Date();
      const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const h12 = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();

      const [
        assignTotal,
        assignActive,
        assignEligible,
        assignDisabled,
        actions24,
        writes24,
        errors24,
        uniqueAsins,
        evalsByTrigger,
        reconStats,
        settings,
        errorDetails,
        hourlyWrites,
        constraintData,
      ] = await Promise.all([
        supabase.from("repricer_assignments").select("id", { count: "exact", head: true }).eq("user_id", user.id),
        supabase.from("repricer_assignments").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "active").eq("is_enabled", true).not("rule_id", "is", null),
        supabase.from("repricer_assignments").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "active").eq("is_enabled", true),
        supabase.from("repricer_assignments").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("is_enabled", false),
        supabase.from("repricer_price_actions").select("id", { count: "exact", head: true }).eq("user_id", user.id).gte("created_at", h24),
        supabase.from("repricer_price_actions").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("action_type", "price_changed").eq("success", true).gte("created_at", h24),
        supabase.from("repricer_price_actions").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("success", false).gte("created_at", h24),
        supabase.from("repricer_price_actions").select("asin").eq("user_id", user.id).gte("created_at", h24).limit(5000),
        supabase.from("repricer_price_actions").select("trigger_source").eq("user_id", user.id).gte("created_at", h24).limit(5000),
        supabase.from("repricer_price_actions").select("reconciliation_status").eq("user_id", user.id).eq("action_type", "price_changed").gte("created_at", h24).limit(3000),
        supabase.from("repricer_settings").select("sp_api_calls_per_minute_cap, scheduler_enabled, sequential_sweep_enabled, sequential_sweep_batch_size, sequential_sweep_interval_minutes, safe_mode_active, queue_paused").eq("user_id", user.id).single(),
        supabase.from("repricer_price_actions").select("error_message").eq("user_id", user.id).eq("success", false).gte("created_at", h24).not("error_message", "is", null).limit(500),
        supabase.from("repricer_price_actions").select("created_at").eq("user_id", user.id).eq("action_type", "price_changed").eq("success", true).gte("created_at", h12).limit(2000),
        supabase.from("repricer_eval_acks").select("reason, constraint_applied").eq("user_id", user.id).neq("result", "changed").gte("acked_at", h24).limit(2000),
      ]);

      // Unique ASINs
      const uniqueAsinSet = new Set((uniqueAsins.data || []).map((r: any) => r.asin));

      // Evals by trigger
      const triggerMap: Record<string, number> = {};
      for (const r of (evalsByTrigger.data || []) as any[]) {
        const src = r.trigger_source || "unknown";
        triggerMap[src] = (triggerMap[src] || 0) + 1;
      }

      // Recon stats
      let reconPending = 0, reconVerified = 0, reconMismatch = 0;
      for (const r of (reconStats.data || []) as any[]) {
        if (r.reconciliation_status === "pending") reconPending++;
        else if (r.reconciliation_status === "verified") reconVerified++;
        else if (r.reconciliation_status === "mismatch") reconMismatch++;
      }

      // Top errors
      const errMap: Record<string, number> = {};
      for (const r of (errorDetails.data || []) as any[]) {
        const msg = (r.error_message || "Unknown").slice(0, 80);
        errMap[msg] = (errMap[msg] || 0) + 1;
      }
      const topErrors = Object.entries(errMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([message, count]) => ({ message, count }));

      // Hourly writes
      const hourBuckets: Record<string, number> = {};
      for (const r of (hourlyWrites.data || []) as any[]) {
        const h = new Date(r.created_at).toISOString().slice(0, 13) + ":00";
        hourBuckets[h] = (hourBuckets[h] || 0) + 1;
      }
      const writesPerHour = Object.entries(hourBuckets)
        .sort()
        .map(([hour, count]) => ({ hour: hour.slice(5, 16), count }));

      // Constraint breakdown
      const cMap: Record<string, number> = {};
      for (const r of (constraintData.data || []) as any[]) {
        const reason = (r.constraint_applied || r.reason || "unknown").slice(0, 60);
        cMap[reason] = (cMap[reason] || 0) + 1;
      }

      // BB wins/losses — count actual BB state on assignments
      // Win = currently winning/owned BB. Loss = enabled but not winning.
      let bbWins = 0, bbLosses = 0;
      {
        const { data: bbAssignments } = await supabase
          .from("repricer_assignments")
          .select("last_buybox_status")
          .eq("user_id", user.id)
          .eq("is_enabled", true)
          .not("rule_id", "is", null);
        for (const r of (bbAssignments || []) as any[]) {
          const st = (r.last_buybox_status || "").toLowerCase();
          if (st === "winning" || st === "owned") bbWins++;
          else if (st && st !== "unknown") bbLosses++;
        }
      }

      const s = settings.data || {} as any;
      const eligibleCount = assignEligible.count || 0;

      setMetrics({
        totalAssignments: assignTotal.count || 0,
        activeWithRules: assignActive.count || 0,
        eligibleAssignments: eligibleCount,
        disabledAssignments: assignDisabled.count || 0,
        totalActions24h: actions24.count || 0,
        priceChanges24h: writes24.count || 0,
        errors24h: errors24.count || 0,
        uniqueAsinsChecked24h: uniqueAsinSet.size,
        coveragePct: eligibleCount > 0 ? (uniqueAsinSet.size / eligibleCount) * 100 : 0,
        evalsByTrigger: triggerMap,
        topErrors,
        reconPending,
        reconVerified,
        reconMismatch,
        avgWriteLatencyMs: null,
        settingsCapPerMin: s.sp_api_calls_per_minute_cap || 0,
        schedulerEnabled: s.scheduler_enabled ?? false,
        sweepEnabled: s.sequential_sweep_enabled ?? false,
        sweepBatch: s.sequential_sweep_batch_size || 0,
        sweepInterval: s.sequential_sweep_interval_minutes || 0,
        safeMode: s.safe_mode_active ?? false,
        queuePaused: s.queue_paused ?? false,
        writesPerHour,
        constraintBreakdown: cMap,
        bbWins,
        bbLosses,
      });
    } catch (err) {
      console.error("Failed to fetch live metrics:", err);
      toast.error("Failed to load live metrics");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (open) fetchMetrics();
  }, [open, fetchMetrics]);

  const reportText = metrics ? buildReportText(metrics) : "";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(reportText);
      setCopied(true);
      toast.success("Report copied to clipboard!");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = reportText;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      toast.success("Report copied to clipboard!");
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <FileText className="h-4 w-4" />
          Live Performance Report
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader className="flex-row items-center justify-between gap-4 space-y-0">
          <DialogTitle>Repricer Live Performance Report</DialogTitle>
          <div className="flex gap-2 shrink-0">
            <Button size="sm" variant="outline" onClick={fetchMetrics} disabled={loading} className="gap-1.5">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button size="sm" onClick={handleCopy} disabled={!metrics} className="gap-1.5">
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "Copied!" : "Copy All"}
            </Button>
          </div>
        </DialogHeader>
        <ScrollArea className="flex-1 min-h-0 border rounded-md p-4 bg-muted/30">
          {loading && !metrics ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin mr-2" />
              Loading live metrics...
            </div>
          ) : metrics ? (
            <pre className="text-xs leading-relaxed whitespace-pre-wrap font-mono text-foreground">
              {reportText}
            </pre>
          ) : (
            <p className="text-muted-foreground text-center py-12">Open to load live metrics</p>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
