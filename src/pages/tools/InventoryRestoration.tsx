import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  CheckCircle2,
  Circle,
  Loader2,
  AlertTriangle,
  RefreshCw,
  Database,
  FileText,
  ShieldCheck,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import MissingCogsReview from "@/components/inventory/MissingCogsReview";

type StepStatus = "pending" | "running" | "complete" | "error";

interface StepState {
  status: StepStatus;
  message?: string;
  startedAt?: number;
  finishedAt?: number;
}

const initialStep: StepState = { status: "pending" };

export default function InventoryRestoration() {
  const { toast } = useToast();
  const [running, setRunning] = useState(false);
  const [summariesStep, setSummariesStep] = useState<StepState>(initialStep);
  const [reportStep, setReportStep] = useState<StepState>(initialStep);
  const [reportProgress, setReportProgress] = useState<{
    current: number;
    total: number;
    message: string;
  } | null>(null);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);

  // Persist last run timestamp locally so the page survives reloads
  useEffect(() => {
    const stored = localStorage.getItem("inventory_restoration_last_run");
    if (stored) setLastRunAt(stored);
  }, []);

  const resetSteps = () => {
    setSummariesStep(initialStep);
    setReportStep(initialStep);
    setReportProgress(null);
  };

  const runSummariesSync = async (): Promise<boolean> => {
    setSummariesStep({ status: "running", startedAt: Date.now(), message: "Calling Summaries API..." });
    try {
      const { data, error } = await supabase.functions.invoke("sync-amazon-inventory", {});
      if (error) throw error;
      const updated = (data as any)?.updated ?? (data as any)?.count ?? null;
      setSummariesStep({
        status: "complete",
        finishedAt: Date.now(),
        message: updated != null
          ? `Updated ${updated} SKU${updated === 1 ? "" : "s"} (available + reserved).`
          : "Available + reserved refreshed from Summaries.",
      });
      return true;
    } catch (err: any) {
      console.error("Summaries sync failed:", err);
      setSummariesStep({
        status: "error",
        finishedAt: Date.now(),
        message: err?.message || "Summaries sync failed.",
      });
      return false;
    }
  };

  const runReportSync = async (): Promise<boolean> => {
    setReportStep({ status: "running", startedAt: Date.now(), message: "Requesting FBA inventory report..." });
    setReportProgress({ current: 0, total: 6, message: "Starting..." });
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("Not authenticated");

      const response = await supabase.functions.invoke("sync-inventory-report", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (response.error) throw response.error;

      const progressId = (response.data as any)?.progressId;
      if (!progressId) {
        // Function completed synchronously
        setReportStep({
          status: "complete",
          finishedAt: Date.now(),
          message: "Inbound quantities refreshed from FBA report.",
        });
        setReportProgress(null);
        return true;
      }

      // Poll progress
      return await new Promise<boolean>((resolve) => {
        const pollInterval = setInterval(async () => {
          try {
            const { data: progress } = await supabase
              .from("pl_sync_progress")
              .select("status, message, current_chunk, total_chunks, error")
              .eq("id", progressId)
              .single();
            if (!progress) return;

            setReportProgress({
              current: progress.current_chunk || 0,
              total: progress.total_chunks || 6,
              message: progress.message || "Syncing...",
            });

            if (progress.status === "complete") {
              clearInterval(pollInterval);
              setReportStep({
                status: "complete",
                finishedAt: Date.now(),
                message: progress.message || "Inbound refreshed from FBA report.",
              });
              setReportProgress(null);
              resolve(true);
            } else if (progress.status === "error") {
              clearInterval(pollInterval);
              setReportStep({
                status: "error",
                finishedAt: Date.now(),
                message: progress.error || progress.message || "Report sync failed.",
              });
              setReportProgress(null);
              resolve(false);
            }
          } catch (e) {
            console.error("Progress poll error:", e);
          }
        }, 3000);

        // Safety timeout (15 min)
        setTimeout(() => {
          clearInterval(pollInterval);
          setReportStep((prev) =>
            prev.status === "running"
              ? { status: "error", finishedAt: Date.now(), message: "Timed out waiting for report." }
              : prev
          );
          setReportProgress(null);
          resolve(false);
        }, 15 * 60 * 1000);
      });
    } catch (err: any) {
      console.error("Report sync failed:", err);
      setReportStep({
        status: "error",
        finishedAt: Date.now(),
        message: err?.message || "Inventory report sync failed.",
      });
      setReportProgress(null);
      return false;
    }
  };

  const runFullReconcile = async () => {
    if (running) return;
    setRunning(true);
    resetSteps();
    try {
      // Step 1: Summaries (truth for available + reserved)
      const okSummaries = await runSummariesSync();
      if (!okSummaries) {
        toast({
          variant: "destructive",
          title: "Reconcile stopped",
          description: "Summaries sync failed. Fix the connection and retry before running the report.",
        });
        return;
      }

      // Tiny gap between calls
      await new Promise((r) => setTimeout(r, 1000));

      // Step 2: Report (truth for inbound)
      const okReport = await runReportSync();
      if (!okReport) {
        toast({
          variant: "destructive",
          title: "Inventory report failed",
          description: "Available/reserved are updated, but inbound did not refresh.",
        });
        return;
      }

      const ts = new Date().toISOString();
      localStorage.setItem("inventory_restoration_last_run", ts);
      setLastRunAt(ts);
      toast({
        title: "Restoration complete",
        description: "Available, reserved, and inbound have been refreshed from Amazon.",
      });
    } finally {
      setRunning(false);
    }
  };

  const StepIcon = ({ state }: { state: StepState }) => {
    if (state.status === "running") return <Loader2 className="h-5 w-5 animate-spin text-blue-400" />;
    if (state.status === "complete") return <CheckCircle2 className="h-5 w-5 text-emerald-400" />;
    if (state.status === "error") return <AlertTriangle className="h-5 w-5 text-red-400" />;
    return <Circle className="h-5 w-5 text-muted-foreground" />;
  };

  return (
    <div className="min-h-screen bg-[#0f1c3f] text-white">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <ShieldCheck className="h-6 w-6 text-blue-400" />
              <h1 className="text-2xl font-bold">Inventory Restoration</h1>
              <Badge variant="outline" className="border-amber-500/40 text-amber-200 bg-amber-500/10">
                One-time clean reset
              </Badge>
              <Badge
                variant="outline"
                className="border-slate-400/40 text-slate-200 bg-slate-500/10"
                title="Auto sync (full-inventory-refresh-2h cron) now covers this automatically every 2h. Kept as an on-demand escape hatch + for the Missing COGS Review block below."
              >
                Flag: Not important — kept as manual escape hatch
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground max-w-2xl">
              Auto sync is disabled. Use this page to restore accurate inventory in one
              guided run: pull <span className="text-white font-medium">available + reserved</span> from Summaries,
              then <span className="text-white font-medium">inbound</span> from the FBA report.
            </p>
          </div>
        </div>

        {/* Safety status */}
        <Card className="bg-emerald-500/5 border-emerald-500/30 p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-400 mt-0.5" />
            <div className="text-sm leading-snug">
              <div className="font-semibold text-emerald-200 mb-1">System is safe</div>
              <ul className="text-emerald-100/80 space-y-1 list-disc list-inside">
                <li>Auto sync edge functions are disabled (kill switches active).</li>
                <li>Freshness guard rejects stale overwrites at the database layer.</li>
                <li>Summaries is the only writer for available/reserved. Report is the only writer for inbound.</li>
              </ul>
            </div>
          </div>
        </Card>

        {/* Run button */}
        <Card className="bg-card/40 border-border p-6">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h2 className="text-lg font-semibold mb-1">Full Reconcile</h2>
              <p className="text-sm text-muted-foreground">
                Runs Summaries first, then the FBA inventory report. Takes a few minutes.
              </p>
              {lastRunAt && (
                <p className="text-xs text-muted-foreground mt-2">
                  Last successful run: {new Date(lastRunAt).toLocaleString()}
                </p>
              )}
            </div>
            <Button
              size="lg"
              onClick={runFullReconcile}
              disabled={running}
              className="bg-blue-600 hover:bg-blue-500 text-white"
            >
              {running ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Restoring...
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Start Full Reconcile
                </>
              )}
            </Button>
          </div>
        </Card>

        {/* Step 1 */}
        <Card className="bg-card/40 border-border p-5">
          <div className="flex items-start gap-4">
            <StepIcon state={summariesStep} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Database className="h-4 w-4 text-blue-400" />
                <h3 className="font-semibold">Step 1 — Summaries (available + reserved)</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                Pulls FBA Summaries API for every connected SKU. Stamps <code className="text-xs">last_summaries_at</code> so
                future stale writes are rejected.
              </p>
              {summariesStep.message && (
                <p className={`text-sm mt-2 ${summariesStep.status === "error" ? "text-red-300" : "text-emerald-200"}`}>
                  {summariesStep.message}
                </p>
              )}
            </div>
          </div>
        </Card>

        {/* Step 2 */}
        <Card className="bg-card/40 border-border p-5">
          <div className="flex items-start gap-4">
            <StepIcon state={reportStep} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <FileText className="h-4 w-4 text-blue-400" />
                <h3 className="font-semibold">Step 2 — FBA Inventory Report (inbound)</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                Requests the FBA inventory report and writes only the <code className="text-xs">inbound</code> field. Catches
                zero-quantity SKUs that Summaries skips.
              </p>
              {reportProgress && (
                <div className="mt-3 space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{reportProgress.message}</span>
                    <span>
                      {reportProgress.current} / {reportProgress.total}
                    </span>
                  </div>
                  <Progress
                    value={
                      reportProgress.total > 0
                        ? (reportProgress.current / reportProgress.total) * 100
                        : 5
                    }
                  />
                </div>
              )}
              {reportStep.message && !reportProgress && (
                <p className={`text-sm mt-2 ${reportStep.status === "error" ? "text-red-300" : "text-emerald-200"}`}>
                  {reportStep.message}
                </p>
              )}
            </div>
          </div>
        </Card>

        {/* Verify */}
        <Card className="bg-card/40 border-border p-5">
          <div className="flex items-start gap-4">
            <StepIcon
              state={
                summariesStep.status === "complete" && reportStep.status === "complete"
                  ? { status: "complete" }
                  : { status: "pending" }
              }
            />
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold mb-1">Step 3 — Verify (manual)</h3>
              <p className="text-sm text-muted-foreground mb-3">
                Spot-check 5–10 ASINs in Seller Central → Inventory → Manage FBA Inventory. Compare available, reserved,
                and inbound to what you see here.
              </p>
              <div className="flex gap-2 flex-wrap">
                <Button asChild variant="outline" size="sm">
                  <Link to="/tools/synced-inventory">
                    Open Synced Inventory
                    <ExternalLink className="h-3 w-3 ml-1.5" />
                  </Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link to="/tools/inventory">
                    Open Inventory Valuation
                    <ExternalLink className="h-3 w-3 ml-1.5" />
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        </Card>

        {/* Missing COGS review */}
        <MissingCogsReview />

        {/* Phase 2 note */}
        <Card className="bg-blue-500/5 border-blue-500/30 p-5">
          <h3 className="font-semibold text-blue-200 mb-2">What's next (Phase 2)</h3>
          <p className="text-sm text-blue-100/80 mb-2">
            Once data is clean, we'll re-enable a safe automatic sync with these guarantees:
          </p>
          <ul className="text-sm text-blue-100/70 space-y-1 list-disc list-inside">
            <li>Active ASINs only (not all 1,500 SKUs)</li>
            <li>Marketplace-aware per row (no US/CA/MX mismatch)</li>
            <li>Zero-protection: never overwrite positive stock with 0</li>
            <li>Strict source separation: Summaries → available/reserved, Report → inbound</li>
            <li>Rate-limited batches with logged before/after values</li>
            <li>Stays disabled until manually verified</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
