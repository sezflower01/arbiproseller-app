import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Helmet } from "react-helmet-async";
import { Card, CardContent } from "@/components/ui/card";
import { Shield, Download, ExternalLink, BarChart3, RefreshCw } from "lucide-react";
import { emitMonitorRefresh } from "@/lib/monitor/refreshBus";
import { Link } from "react-router-dom";
import EdgeFunctionDiagnosticsPanel from "@/components/monitor/EdgeFunctionDiagnosticsPanel";
import CoverageBreakdownPanel from "@/components/monitor/CoverageBreakdownPanel";
import EmptySnapshotBreakdownPanel from "@/components/monitor/EmptySnapshotBreakdownPanel";
import ThroughputRecommendationCard from "@/components/monitor/ThroughputRecommendationCard";
import MarketplaceCoveragePanel from "@/components/monitor/MarketplaceCoveragePanel";
import ReconciliationBreakdownPanel from "@/components/monitor/ReconciliationBreakdownPanel";
import ReconciliationTruthPanel from "@/components/monitor/ReconciliationTruthPanel";
import OscillationStatusPanel from "@/components/monitor/OscillationStatusPanel";
import BuyBoxWinsPanel from "@/components/monitor/BuyBoxWinsPanel";

import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import HealthSummaryCards from "@/components/monitor/HealthSummaryCards";
import DailyChecklist from "@/components/monitor/DailyChecklist";
import FeedSubmissionsTable from "@/components/monitor/FeedSubmissionsTable";
import MismatchSkusTable from "@/components/monitor/MismatchSkusTable";
import EscalationPanel from "@/components/monitor/EscalationPanel";
import QuotaHealthPanel from "@/components/monitor/QuotaHealthPanel";
import LaneBudgetPanel from "@/components/monitor/LaneBudgetPanel";
import StalledAsinsPanel from "@/components/monitor/StalledAsinsPanel";
import CoverageSlaPanel from "@/components/monitor/CoverageSlaPanel";
import SweepProgressPanel from "@/components/monitor/SweepProgressPanel";
import { useMonitorData } from "@/hooks/use-monitor-data";
import KeepaUsagePanel from "@/components/monitor/KeepaUsagePanel";
import SkippedAsinWorkQueue from "@/components/monitor/SkippedAsinWorkQueue";
import TierDistributionPanel from "@/components/monitor/TierDistributionPanel";
import KeyMetricsSnapshot from "@/components/monitor/KeyMetricsSnapshot";
import SetupIncompletePanel from "@/components/monitor/SetupIncompletePanel";
import SafeModeRecoveryPanel from "@/components/monitor/SafeModeRecoveryPanel";
import RecoveryTrendCards from "@/components/monitor/RecoveryTrendCards";
import ReconciliationDetailPanel from "@/components/monitor/ReconciliationDetailPanel";
import UniverseSegmentationPanel from "@/components/monitor/UniverseSegmentationPanel";
import MetricValidationPanel from "@/components/monitor/MetricValidationPanel";
import EligibleFreshnessPanel from "@/components/monitor/EligibleFreshnessPanel";
import StuckAssignmentsPanel from "@/components/monitor/StuckAssignmentsPanel";
import EvalModeDistributionPanel from "@/components/monitor/EvalModeDistributionPanel";
import HistoricalGraphsPanel from "@/components/monitor/HistoricalGraphsPanel";
import PushBoundsToAmazonButton from "@/components/repricer/PushBoundsToAmazonButton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useUiMode } from "@/contexts/UiModeContext";
import UiModeToggle from "@/components/UiModeToggle";
import SimpleMonitor from "@/components/monitor/SimpleMonitor";
import ExecutiveSummaryCard from "@/components/monitor/ExecutiveSummaryCard";

function AdvancedSection({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="w-full flex items-center justify-between rounded-md border border-border bg-card/50 px-4 py-2.5 hover:bg-card/80 transition-colors">
          <span className="text-sm font-semibold text-foreground flex items-center gap-2">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            {title}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {open ? "Hide" : "Show"}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pt-3">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function RepricerMonitor() {
  const { user } = useAuth();
  const { mode } = useUiMode();
  const [hasAccess, setHasAccess] = useState<boolean | null>(null);
  const data = useMonitorData();

  useEffect(() => {
    const checkAccess = async () => {
      if (!user) { setHasAccess(false); return; }
      const { data: role } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .in("role", ["monitor", "admin"])
        .maybeSingle();
      setHasAccess(!!role);
    };
    checkAccess();
  }, [user]);

  if (hasAccess === null) {
    return (
      <div className="dark min-h-screen flex items-center justify-center bg-[hsl(222,84%,4.9%)]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!hasAccess) {
    return (
      <>
        <Navbar />
        <div className="dark min-h-screen flex flex-col items-center justify-center gap-4 bg-[hsl(222,84%,4.9%)]">
          <Shield className="h-16 w-16 text-muted-foreground" />
          <h1 className="text-2xl font-bold text-foreground">Access Restricted</h1>
          <p className="text-muted-foreground">You need the <strong>monitor</strong> or <strong>admin</strong> role to view this page.</p>
        </div>
        <Footer />
      </>
    );
  }

  const handleExportDigest = () => {
    const lines = [
      `Repricer Monitor Digest - ${new Date().toLocaleDateString()}`,
      "",
      "=== Health Summary ===",
      `Scheduler Runs Today: ${data.schedulerRuns}`,
      `Last Run: ${data.lastRunTime || "Never"}`,
      `Feeds Submitted: ${data.feedsSubmitted}`,
      `Feed Completion Rate: ${data.feedCompletionRate}%`,
      `Verification Success Rate: ${data.verificationRate}%`,
      `Unverified/Mismatch SKUs: ${data.mismatchCount}`,
      `Profit Guard Blocks: ${data.profitGuardBlocks}`,
      "",
      "=== Top Mismatch ASINs (30d Sales) ===",
      ...(data.topMismatchAsins.length > 0
        ? data.topMismatchAsins.map((asin) => `  ${asin}`)
        : ["  None"]),
      "",
      "=== Checklist Completion ===",
      `${data.checklistCompletion}%`,
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `repricer-digest-${new Date().toISOString().split("T")[0]}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Digest exported");
  };

  return (
    <>
      <Helmet>
        <title>Repricer Monitor - ArbiPro Seller</title>
      </Helmet>
      <div className="dark min-h-screen flex flex-col bg-[hsl(222,84%,4.9%)] text-white">
        <Navbar />
        <main className="flex-1 container mx-auto px-4 py-8 pt-24 space-y-6">
          {/* Header — always visible */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
                <Shield className="h-8 w-8 text-primary" />
                Repricer Monitor
              </h1>
              <p className="text-muted-foreground mt-1">
                {mode === "simple"
                  ? "Your daily business overview — what needs attention right now."
                  : "Engineering view — full diagnostics and internals."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <UiModeToggle compact />
              <Button
                variant="default"
                size="sm"
                onClick={() => {
                  emitMonitorRefresh();
                  toast.success("Refreshing monitor panels…");
                }}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              {mode === "advanced" && <PushBoundsToAmazonButton label="Push Bounds→AMZ" />}
              <Button variant="outline" size="sm" asChild>
                <Link to="/tools/repricer/analytics">
                  <BarChart3 className="h-4 w-4 mr-2" />
                  Analytics
                </Link>
              </Button>
              {mode === "advanced" && (
                <Button variant="outline" size="sm" onClick={handleExportDigest}>
                  <Download className="h-4 w-4 mr-2" />
                  Export Digest
                </Button>
              )}
            </div>
          </div>

          {mode === "simple" ? (
            <SimpleMonitor />
          ) : (
            <>
              <ExecutiveSummaryCard />

              {/* Historical Graphs — keep visible at top of advanced view */}
              <HistoricalGraphsPanel />

              <div className="space-y-4 rounded-2xl border border-primary/25 bg-primary/5 p-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary/80">Monitor Overview</p>
                  <h2 className="text-lg font-semibold text-foreground">Universe & Metric Validation</h2>
                </div>
                <UniverseSegmentationPanel data={data.quotaHealth} />
                <MetricValidationPanel data={data.quotaHealth} />
                <EligibleFreshnessPanel />
              </div>

              {/* Always-visible operational essentials */}
              <KeyMetricsSnapshot data={data} />
              <HealthSummaryCards data={data} />
              <SafeModeRecoveryPanel />
              <RecoveryTrendCards />

              {/* ─── Collapsible Advanced Sections (default collapsed) ─── */}
              <AdvancedSection title="Setup & Readiness">
                <StuckAssignmentsPanel />
                <SetupIncompletePanel />
                <DailyChecklist data={data} />
              </AdvancedSection>

              <AdvancedSection title="Coverage & Throughput">
                <ThroughputRecommendationCard quotaHealth={data.quotaHealth} />
                <MarketplaceCoveragePanel breakdown={data.quotaHealth.marketplaceBreakdown} />
                <TierDistributionPanel />
                <CoverageBreakdownPanel />
                <CoverageSlaPanel />
                <EvalModeDistributionPanel />
              </AdvancedSection>

              <AdvancedSection title="Reconciliation & Feed Verification">
                <ReconciliationDetailPanel />
                <ReconciliationTruthPanel />
                <ReconciliationBreakdownPanel />
                <FeedSubmissionsTable />
                <MismatchSkusTable />
              </AdvancedSection>

              <AdvancedSection title="Buy Box & Oscillation">
                <OscillationStatusPanel />
                <BuyBoxWinsPanel />
              </AdvancedSection>

              <AdvancedSection title="Sweep & Skipped Work">
                <SweepProgressPanel />
                <EmptySnapshotBreakdownPanel />
                <SkippedAsinWorkQueue />
                <StalledAsinsPanel />
                <EscalationPanel data={data} />
              </AdvancedSection>

              <AdvancedSection title="API & Quota Internals">
                <LaneBudgetPanel />
                <KeepaUsagePanel />
                <QuotaHealthPanel data={data.quotaHealth} />
                <EdgeFunctionDiagnosticsPanel />
              </AdvancedSection>

              <AdvancedSection title="Supabase Log Quick Links">
                <Card>
                  <CardContent className="pt-4">
                    <div className="flex flex-wrap gap-2">
                      {[
                        { label: "Unified Dispatch", fn: "repricer-unified-dispatch" },
                        { label: "Scheduler", fn: "repricer-scheduler" },
                        { label: "AI Evaluate", fn: "repricer-ai-evaluate" },
                        { label: "SP-API Pricing", fn: "repricer-sp-api-pricing" },
                        { label: "Sequential Sweep", fn: "repricer-sequential-sweep" },
                        { label: "Auto Turbo", fn: "repricer-auto-turbo" },
                        { label: "Cleanup", fn: "repricer-cleanup" },
                        { label: "Save Rules", fn: "save-repricer-rules" },
                        { label: "Sync Bounds", fn: "sync-amazon-bounds" },
                        { label: "Bulk Bounds", fn: "bulk-update-repricer-bounds" },
                        { label: "Push Bounds→AMZ Logs", fn: "push-bounds-to-amazon" },
                        { label: "Update Price", fn: "update-amazon-price" },
                        { label: "Sync Inventory", fn: "sync-inventory-report" },
                        { label: "Sync Sales", fn: "sync-sales-orders" },
                        { label: "Enrich Orders", fn: "enrich-pending-orders" },
                        { label: "Enrich Titles", fn: "enrich-missing-titles" },
                        { label: "Keepa Finder", fn: "keepa-product-finder" },
                        { label: "Calculate ROI", fn: "calculate-roi" },
                        { label: "ROI Range", fn: "calculate-roi-range" },
                      ].map(({ label, fn }) => (
                        <Button key={fn} variant="outline" size="sm" className="h-7 text-xs gap-1" asChild>
                          <a
                            href={`https://supabase.com/dashboard/project/mstibdszibcheodvnprm/functions/${fn}/logs`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {label}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </Button>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </AdvancedSection>
            </>
          )}
        </main>
        <Footer />
      </div>
    </>
  );
}
