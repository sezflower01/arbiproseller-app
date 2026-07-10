import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClipboardCheck, Play, RefreshCw, CheckCircle2, XCircle, Info } from "lucide-react";
import { toast } from "sonner";
import type { MonitorData } from "@/hooks/use-monitor-data";

const CHECKLIST_STEPS = [
  { key: "scheduler_ran", label: "Confirm scheduler ran in last 60 minutes" },
  { key: "feed_out_of_queue", label: "Confirm latest feed moved out of IN_QUEUE" },
  { key: "verification_rate", label: "Confirm verification rate is above target" },
  { key: "review_errors", label: 'Review "Top errors today" list' },
  { key: "run_test", label: "Run one dry-run test on a sample SKU" },
  { key: "escalate_if_needed", label: "If issues found, escalate with notes" },
];

interface DryRunResult {
  asin: string;
  sku: string;
  marketplace: string;
  currentPrice: number | null;
  recommendedPrice: number | null;
  reason: string;
  ruleName: string | null;
  strategy: string | null;
  snapshot: {
    buybox_price: number | null;
    lowest_fba_price: number | null;
    lowest_overall_price: number | null;
    offers_count: number;
  } | null;
  safeguards: {
    min_price: number | null;
    max_price: number | null;
    applied: string[];
  };
  timestamp: string;
  success: boolean;
  error?: string;
}

interface Props {
  data: MonitorData;
}

export default function DailyChecklist({ data }: Props) {
  const { user } = useAuth();
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [dryRunning, setDryRunning] = useState(false);
  const [lastDryRun, setLastDryRun] = useState<DryRunResult | null>(null);
  const [dryRunHistory, setDryRunHistory] = useState<DryRunResult[]>([]);

  const today = new Date().toISOString().split("T")[0];

  const fetchChecks = useCallback(async () => {
    if (!user) return;
    const { data: rows } = await supabase
      .from("repricer_monitor_checks")
      .select("step_key, is_checked")
      .eq("user_id", user.id)
      .eq("check_date", today);

    const map: Record<string, boolean> = {};
    (rows || []).forEach((r: any) => { map[r.step_key] = r.is_checked; });
    setChecks(map);
    setLoading(false);
  }, [user, today]);

  useEffect(() => { fetchChecks(); }, [fetchChecks]);

  const toggleCheck = async (stepKey: string, checked: boolean) => {
    if (!user) return;
    setChecks((prev) => ({ ...prev, [stepKey]: checked }));

    const { error } = await supabase
      .from("repricer_monitor_checks")
      .upsert(
        {
          user_id: user.id,
          check_date: today,
          step_key: stepKey,
          is_checked: checked,
          checked_at: checked ? new Date().toISOString() : null,
        },
        { onConflict: "user_id,check_date,step_key" }
      );

    if (error) {
      toast.error("Failed to save check");
      setChecks((prev) => ({ ...prev, [stepKey]: !checked }));
    }
  };

  const runDryTest = async () => {
    if (!user) return;
    setDryRunning(true);
    setLastDryRun(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      // Fetch active assignments that have reserved stock (real activity)
      const { data: inventoryWithStock } = await supabase
        .from("inventory")
        .select("sku")
        .eq("user_id", user.id)
        .gt("reserved", 0);

      const skusWithReserved = (inventoryWithStock || []).map((i: any) => i.sku);

      if (skusWithReserved.length === 0) {
        const errorResult: DryRunResult = {
          asin: "—", sku: "—", marketplace: "—",
          currentPrice: null, recommendedPrice: null,
          reason: "No inventory items with reserved units found",
          ruleName: null, strategy: null, snapshot: null,
          safeguards: { min_price: null, max_price: null, applied: [] },
          timestamp: new Date().toISOString(),
          success: false, error: "No SKUs with reserved stock to test",
        };
        setLastDryRun(errorResult);
        setDryRunHistory((prev) => [errorResult, ...prev].slice(0, 20));
        toast.warning("No SKUs with reserved stock to test");
        return;
      }

      const { data: assignments } = await supabase
        .from("repricer_assignments")
        .select("id, asin, sku, marketplace, rule_id, repricer_rules(rule_type)")
        .eq("is_enabled", true)
        .not("rule_id", "is", null)
        .in("sku", skusWithReserved)
        .limit(10);

      if (!assignments || assignments.length === 0) {
        const errorResult: DryRunResult = {
          asin: "—", sku: "—", marketplace: "—",
          currentPrice: null, recommendedPrice: null,
          reason: "No active assignments with rules to test",
          ruleName: null, strategy: null, snapshot: null,
          safeguards: { min_price: null, max_price: null, applied: [] },
          timestamp: new Date().toISOString(),
          success: false, error: "No active assignments found",
        };
        setLastDryRun(errorResult);
        setDryRunHistory((prev) => [errorResult, ...prev].slice(0, 20));
        toast.warning("No active assignments with rules to test");
        return;
      }

      const pick = assignments[Math.floor(Math.random() * assignments.length)] as any;
      const ruleType = pick.repricer_rules?.rule_type;
      const functionName = ruleType === "ai" ? "repricer-ai-evaluate" : "repricer-evaluate";

      const { data: result, error } = await supabase.functions.invoke(functionName, {
        body: { assignmentId: pick.id, asin: pick.asin, marketplace: pick.marketplace, ruleId: pick.rule_id, dry_run: true },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (error) throw error;

      const dryResult: DryRunResult = {
        asin: result?.asin || pick.asin,
        sku: pick.sku,
        marketplace: result?.marketplace || pick.marketplace,
        currentPrice: result?.currentPrice,
        recommendedPrice: result?.recommendedPrice,
        reason: result?.reason || "No change recommended",
        ruleName: result?.ruleName,
        strategy: result?.strategy,
        snapshot: result?.snapshot ? {
          buybox_price: result.snapshot.buybox_price,
          lowest_fba_price: result.snapshot.lowest_fba_price,
          lowest_overall_price: result.snapshot.lowest_overall_price,
          offers_count: result.snapshot.offers_count,
        } : null,
        safeguards: result?.safeguards ? {
          min_price: result.safeguards.min_price,
          max_price: result.safeguards.max_price,
          applied: result.safeguards.applied || [],
        } : { min_price: null, max_price: null, applied: [] },
        timestamp: new Date().toISOString(),
        success: true,
      };

      setLastDryRun(dryResult);
      setDryRunHistory((prev) => [dryResult, ...prev].slice(0, 20));
      toast.success("Dry run completed — no Amazon update sent.", { duration: 5000 });
      await toggleCheck("run_test", true);
    } catch (err: any) {
      const errorResult: DryRunResult = {
        asin: "—", sku: "—", marketplace: "—",
        currentPrice: null, recommendedPrice: null,
        reason: err.message, ruleName: null, strategy: null,
        snapshot: null, safeguards: { min_price: null, max_price: null, applied: [] },
        timestamp: new Date().toISOString(),
        success: false, error: err.message,
      };
      setLastDryRun(errorResult);
      setDryRunHistory((prev) => [errorResult, ...prev].slice(0, 20));
      toast.error("Dry run failed: " + err.message);
    } finally {
      setDryRunning(false);
    }
  };

  const checkedCount = Object.values(checks).filter(Boolean).length;
  const completionPct = Math.round((checkedCount / CHECKLIST_STEPS.length) * 100);

  const fmt = (v: number | null) => v != null ? `$${v.toFixed(2)}` : "—";
  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-lg flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5" />
            Daily Checklist
          </CardTitle>
          <Badge variant={completionPct === 100 ? "default" : "secondary"}>
            {completionPct}% Complete
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <Progress value={completionPct} className="h-2" />

          {loading ? (
            <div className="text-center py-4 text-muted-foreground">Loading...</div>
          ) : (
            <div className="space-y-3">
              {CHECKLIST_STEPS.map((step, idx) => (
                <div key={step.key} className="flex items-start gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors">
                  <Checkbox
                    id={step.key}
                    checked={checks[step.key] || false}
                    onCheckedChange={(checked) => toggleCheck(step.key, !!checked)}
                  />
                  <label
                    htmlFor={step.key}
                    className={`text-sm cursor-pointer flex-1 ${
                      checks[step.key] ? "line-through text-muted-foreground" : "text-foreground"
                    }`}
                  >
                    <span className="text-muted-foreground mr-2">#{idx + 1}</span>
                    {step.label}
                  </label>
                  {step.key === "run_test" && (
                    <div className="flex flex-col items-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={runDryTest}
                        disabled={dryRunning}
                      >
                        {dryRunning ? (
                          <>
                            <RefreshCw className="h-3 w-3 animate-spin mr-1" />
                            Running…
                          </>
                        ) : (
                          <>
                            <Play className="h-3 w-3 mr-1" />
                            Dry Run (Safe)
                          </>
                        )}
                      </Button>
                      <span className="text-[10px] text-muted-foreground">Simulates 1 SKU. Does not change Amazon.</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dry Run Result Card */}
      {lastDryRun && (
        <Card className={lastDryRun.success ? "border-green-500/50" : "border-destructive/50"}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              {lastDryRun.success ? (
                <CheckCircle2 className="h-5 w-5 text-green-500" />
              ) : (
                <XCircle className="h-5 w-5 text-destructive" />
              )}
              {lastDryRun.success ? "Dry Run Completed ✅" : "Dry Run Failed ❌"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {lastDryRun.success ? (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
                <div><span className="text-muted-foreground">SKU:</span> <span className="font-mono">{lastDryRun.sku}</span></div>
                <div><span className="text-muted-foreground">ASIN:</span> <span className="font-mono">{lastDryRun.asin}</span></div>
                <div><span className="text-muted-foreground">Marketplace:</span> {lastDryRun.marketplace}</div>
                <div><span className="text-muted-foreground">Current Price:</span> {fmt(lastDryRun.currentPrice)}</div>
                <div><span className="text-muted-foreground">Recommended:</span> <span className="font-semibold">{fmt(lastDryRun.recommendedPrice)}</span></div>
                <div><span className="text-muted-foreground">Rule:</span> {lastDryRun.ruleName || "—"}</div>
                <div><span className="text-muted-foreground">Min/Max:</span> {fmt(lastDryRun.safeguards.min_price)} / {fmt(lastDryRun.safeguards.max_price)}</div>
                <div><span className="text-muted-foreground">Buy Box:</span> {lastDryRun.snapshot ? fmt(lastDryRun.snapshot.buybox_price) : "—"}</div>
                <div><span className="text-muted-foreground">Offers:</span> {lastDryRun.snapshot?.offers_count ?? "—"}</div>
                <div className="col-span-2 md:col-span-3">
                  <span className="text-muted-foreground">Reason:</span> {lastDryRun.reason}
                </div>
                {lastDryRun.safeguards.applied.length > 0 && (
                  <div className="col-span-2 md:col-span-3">
                    <span className="text-muted-foreground">Safeguards:</span>{" "}
                    {lastDryRun.safeguards.applied.map((s, i) => (
                      <Badge key={i} variant="outline" className="mr-1 text-xs">{s}</Badge>
                    ))}
                  </div>
                )}
                <div className="col-span-2 md:col-span-3 text-xs text-muted-foreground flex items-center gap-1">
                  <Info className="h-3 w-3" />
                  {new Date(lastDryRun.timestamp).toLocaleString()} — No Amazon update sent
                </div>
              </div>
            ) : (
              <div className="text-sm text-destructive">{lastDryRun.error}</div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Dry Run History */}
      {dryRunHistory.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Dry Run History</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>SKU / ASIN</TableHead>
                    <TableHead>Recommended</TableHead>
                    <TableHead>Rule</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dryRunHistory.map((run, idx) => (
                    <TableRow key={idx}>
                      <TableCell className="text-xs whitespace-nowrap">{fmtTime(run.timestamp)}</TableCell>
                      <TableCell className="font-mono text-xs">
                        <div>{run.sku}</div>
                        <div className="text-muted-foreground">{run.asin}</div>
                      </TableCell>
                      <TableCell>{fmt(run.recommendedPrice)}</TableCell>
                      <TableCell className="text-xs">{run.ruleName || "—"}</TableCell>
                      <TableCell className="text-xs max-w-[200px] truncate">{run.reason}</TableCell>
                      <TableCell>
                        {run.success ? (
                          <Badge variant="default" className="text-xs">OK</Badge>
                        ) : (
                          <Badge variant="destructive" className="text-xs">Error</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
