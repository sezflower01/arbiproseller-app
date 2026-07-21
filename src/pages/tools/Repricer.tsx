import { useState, useEffect, useCallback } from "react";
import HistoricalGraphsPanel from "@/components/monitor/HistoricalGraphsPanel";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdgeFunction } from "@/lib/edgeFunctionClient";
import { useAuth } from "@/contexts/AuthContext";
import { useSubscription } from "@/hooks/use-subscription";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Helmet } from "react-helmet-async";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Shield, Download, ExternalLink, History, FlaskConical, Eye, TestTubes, Clock, Users, AlertTriangle, Sparkles, Brain, ChevronDown, MoreHorizontal, BarChart3 } from "lucide-react";
import { usePageFavicon } from "@/hooks/use-page-favicon";
import OptimizationReportDialog from "@/components/repricer/OptimizationReportDialog";
import AppliedSuggestionsPanel from "@/components/repricer/AppliedSuggestionsPanel";
import PushBoundsToAmazonButton from "@/components/repricer/PushBoundsToAmazonButton";
import ProbeListingsIssuesButton from "@/components/repricer/ProbeListingsIssuesButton";
import IntlRoiSweepCard from "@/components/repricer/IntlRoiSweepCard";

// Import repricer components
import RuleBuilder, { type RepricerRule } from "@/components/repricer/RuleBuilder";
import AssignmentsTable from "@/components/repricer/AssignmentsTable";
import PricingSuppressionsSection from "@/components/repricer/PricingSuppressionsSection";
import OffersViewer from "@/components/repricer/OffersViewer";
import RepricerSettings from "@/components/repricer/RepricerSettings";
import AutoOnboardingSettings from "@/components/settings/AutoOnboardingSettings";
import SchedulerToggle from "@/components/repricer/SchedulerToggle";
import ActivityLog from "@/components/repricer/ActivityLog";
import AiRuleTestDialog from "@/components/repricer/AiRuleTestDialog";
import ChangeHistoryPanel from "@/components/repricer/ChangeHistoryPanel";
import RuleBehaviorPanel from "@/components/repricer/RuleBehaviorPanel";
import CheckedRecentlyPanel from "@/components/repricer/CheckedRecentlyPanel";
import SkippedAsinWorkQueue from "@/components/monitor/SkippedAsinWorkQueue";
import MonitorTabLayout from "@/components/monitor/MonitorTabLayout";
import { useMonitorData } from "@/hooks/use-monitor-data";
import SimulationTab from "@/components/repricer/SimulationTab";
import PriceHistoryTab from "@/components/repricer/PriceHistoryTab";
import { SyncReadinessBanner } from "@/components/SyncReadinessBanner";
import AccountControlPanel from "@/components/admin/AccountControlPanel";
import ErrorLog from "@/pages/tools/ErrorLog";
import { lazy, Suspense } from "react";
const AiActionInsightsEmbed = lazy(() => import("@/pages/tools/AiActionInsights"));
import SmartEngineReview from "@/components/repricer/SmartEngineReview";
import SmartEngineLearning from "@/components/repricer/SmartEngineLearning";
import HealthPresets from "@/components/analytics/HealthPresets";
import AsinInventoryLookupDialog from "@/components/inventory/AsinInventoryLookupDialog";
import BulkLiveInventorySyncButton from "@/components/repricer/BulkLiveInventorySyncButton";
import OptimizationPresets from "@/components/analytics/OptimizationPresets";
import OutcomePresets from "@/components/analytics/OutcomePresets";
import AnalyticsKpiSummary from "@/components/analytics/AnalyticsKpiSummary";
import ValidationView from "@/components/analytics/ValidationView";

const monitorLogLinks = [
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
];

export default function Repricer() {
  const { user } = useAuth();
  const { isAdmin } = useSubscription();
  usePageFavicon("R");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [rules, setRules] = useState<RepricerRule[]>([]);
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState("assignments");
  const hasRules = rules.length > 0;

  // Deep-link support for admin-only tabs reached via a module directory
  // card (e.g. /tools/repricer?tab=price-history) rather than the in-page tab bar.
  useEffect(() => {
    const requestedTab = searchParams.get("tab");
    if (requestedTab && isAdmin && (requestedTab === "price-history" || requestedTab === "ai-insights")) {
      setActiveTab(requestedTab);
    }
  }, [searchParams, isAdmin]);
  
  // Marketplace selector state
  const [selectedMarketplace, setSelectedMarketplace] = useState("US");

  const monitorData = useMonitorData(selectedMarketplace);
  
  // Offers viewer state
  const [viewingAsin, setViewingAsin] = useState<string | null>(null);
  const [viewingMarketplace, setViewingMarketplace] = useState("US");
  const [offersDialogOpen, setOffersDialogOpen] = useState(false);

  // AI test dialog state
  const [testingRule, setTestingRule] = useState<RepricerRule | null>(null);
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [appliedSuggestionsOpen, setAppliedSuggestionsOpen] = useState(false);

  const fetchRules = useCallback(async () => {
    if (!user) return;
    try {
      const { data, error } = await supabase
        .from("repricer_rules")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;
      const next = (data as RepricerRule[]) || [];
      setRules(next);
      setRulesLoaded(true);
      // If user just created their first rule, jump them to Assignments
      if (next.length > 0 && rules.length === 0 && activeTab === "rules") {
        setActiveTab("assignments");
      }
    } catch (error: any) {
      console.error("Error fetching rules:", error);
      setRulesLoaded(true);
    }
  }, [user, rules.length, activeTab]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  // When rules finish loading and user has none, force them onto the Rules tab
  useEffect(() => {
    if (rulesLoaded && !hasRules && activeTab === "assignments") {
      setActiveTab("rules");
    }
  }, [rulesLoaded, hasRules, activeTab]);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const handleViewOffers = (asin: string, marketplace: string) => {
    setViewingAsin(asin);
    setViewingMarketplace(marketplace);
    setOffersDialogOpen(true);
  };

  const handleTestRule = async (rule: RepricerRule) => {
    if (rule.strategy === "AI_WIN_SALES_BOOSTER") {
      // Use new AI test dialog
      setTestingRule(rule);
      setTestDialogOpen(true);
    } else {
      // Existing standard rule test
      const asin = prompt("Enter ASIN to test this rule:");
      if (!asin) return;

      try {
        toast.info("Evaluating rule...");

        const result = await invokeEdgeFunction({
          functionName: "repricer-evaluate",
          body: { asin, ruleId: rule.id, marketplace: "US" },
          maxRetries: 1,
          context: { asin, ruleId: rule.id },
        });

        if (!result.ok) {
          toast.error(`Test failed (${result.errorCategory}): ${result.errorMessage}`);
          return;
        }

        if (result.data.recommendedPrice !== null) {
          toast.success(
            `Recommended: $${result.data.recommendedPrice.toFixed(2)} | ${result.data.reason}`,
            { duration: 8000 }
          );
        } else {
          toast.info(result.data.reason || "No price change recommended", { duration: 6000 });
        }
      } catch (error: any) {
        toast.error("Test failed: " + error.message);
      }
    }
  };

  return (
    <>
      <Helmet>
        <title>Advanced Repricer - ArbiPro Seller</title>
        <meta
          name="description"
          content="Advanced Amazon repricer with competitor monitoring and automated pricing rules"
        />
      </Helmet>
      <div className="dark min-h-screen flex flex-col bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)] relative overflow-hidden">
        {/* Animated gradient orbs */}
        <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary/20 rounded-full blur-[120px] animate-pulse" />
        <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-purple-500/15 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: '1s' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[200px]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:64px_64px]" />
        <Navbar />
        <main className="flex-1 container mx-auto px-4 pt-20 pb-8 relative z-10">
          <SyncReadinessBanner module="repricer" />
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className="flex items-center gap-2 mb-6 flex-wrap">
              <AsinInventoryLookupDialog />
              <BulkLiveInventorySyncButton />
              <TabsList className="bg-white/80 backdrop-blur-sm border border-white/30 text-[hsl(221,100%,10%)] font-bold">
                {hasRules && <TabsTrigger value="assignments">Assignments</TabsTrigger>}
                <TabsTrigger value="rules">Rules</TabsTrigger>
                {isAdmin && <TabsTrigger value="activity">Activity Log</TabsTrigger>}
                <TabsTrigger value="settings">Settings</TabsTrigger>
                {isAdmin && (
                  <TabsTrigger value="monitor" className="flex items-center gap-1">
                    <Shield className="h-3.5 w-3.5" /> Monitor
                  </TabsTrigger>
                )}
                {isAdmin && (
                  <TabsTrigger value="price-history" className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" /> Price History
                  </TabsTrigger>
                )}
                {isAdmin && (
                  <TabsTrigger value="ai-insights" className="flex items-center gap-1">
                    <Brain className="h-3.5 w-3.5" /> AI Insights
                  </TabsTrigger>
                )}
              </TabsList>

              {isAdmin && (
                <>
                  <PushBoundsToAmazonButton className="h-10 bg-white/60 backdrop-blur-sm border-white/20 text-[hsl(221,90%,22%)] font-bold" label="Push Bounds→AMZ" />
                  <ProbeListingsIssuesButton />

                  {/* Admin Tools dropdown */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-10 bg-white/60 backdrop-blur-sm border-white/20 text-[hsl(221,90%,22%)] font-bold gap-1">
                        <MoreHorizontal className="h-3.5 w-3.5" /> More
                        <ChevronDown className="h-3 w-3 opacity-50" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuLabel className="text-xs text-muted-foreground">Admin Tools</DropdownMenuLabel>
                      <DropdownMenuItem onClick={() => setActiveTab("history")}>
                        <History className="h-3.5 w-3.5 mr-2" /> Change History
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setActiveTab("behavior")}>
                        <FlaskConical className="h-3.5 w-3.5 mr-2" /> Rule Behavior
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setActiveTab("checked")}>
                        <Eye className="h-3.5 w-3.5 mr-2" /> Checked ASINs
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setActiveTab("simulation")}>
                        <TestTubes className="h-3.5 w-3.5 mr-2" /> Simulation
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setActiveTab("account-control")}>
                        <Users className="h-3.5 w-3.5 mr-2" /> Account Control
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setActiveTab("error-log")}>
                        <AlertTriangle className="h-3.5 w-3.5 mr-2" /> Error Log
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setActiveTab("analytics")}>
                        <BarChart3 className="h-3.5 w-3.5 mr-2" /> Analytics
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {/* Smart Engine dropdown */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-10 bg-white/60 backdrop-blur-sm border-white/20 text-[hsl(221,90%,22%)] font-bold gap-1">
                        <Sparkles className="h-3.5 w-3.5" /> Smart Engine
                        <ChevronDown className="h-3 w-3 opacity-50" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onClick={() => setActiveTab("smart-review")}>
                        <Sparkles className="h-3.5 w-3.5 mr-2" /> Smart Review
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setActiveTab("learning")}>
                        <Brain className="h-3.5 w-3.5 mr-2" /> Learning
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </div>

            {hasRules && (
              <TabsContent value="assignments" className="space-y-6">
                <PricingSuppressionsSection marketplace={selectedMarketplace} isAdmin={isAdmin} />
                <AssignmentsTable 
                  rules={rules} 
                  onViewOffers={handleViewOffers} 
                  marketplace={selectedMarketplace}
                  onMarketplaceChange={setSelectedMarketplace}
                  onViewAppliedSuggestions={() => setAppliedSuggestionsOpen(true)}
                  isAdmin={isAdmin}
                />
              </TabsContent>
            )}

            <TabsContent value="rules" className="space-y-6">
              {!hasRules && rulesLoaded && (
                <div className="rounded-xl border border-primary/30 bg-primary/10 backdrop-blur-sm p-5 text-foreground">
                  <h3 className="text-base font-semibold mb-1">Create your first repricing rule</h3>
                  <p className="text-sm opacity-80">
                    The Assignments tab will unlock once you create a rule. Your first rule is automatically set as the default for new listings in Settings → Auto Onboarding.
                  </p>
                </div>
              )}
              <RuleBuilder onRulesChange={fetchRules} onTestRule={isAdmin ? handleTestRule : undefined} isAdmin={isAdmin} />
            </TabsContent>

            <TabsContent value="activity" className="space-y-6">
              <ActivityLog />
            </TabsContent>

            <TabsContent value="settings" className="space-y-6">
              <div className="max-w-xl space-y-6">
                {!isAdmin && <SchedulerToggle />}
                {isAdmin && <RepricerSettings isAdmin={isAdmin} />}
                <AutoOnboardingSettings />
                <IntlRoiSweepCard />
              </div>
            </TabsContent>

            <TabsContent value="monitor" className="space-y-6">
              <HistoricalGraphsPanel />
              {isAdmin && (
                <div className="flex justify-end">
                  <OptimizationReportDialog />
                </div>
              )}
              <MonitorTabLayout
                monitorData={monitorData}
                marketplace={selectedMarketplace}
                logLinks={monitorLogLinks}
              />
            </TabsContent>

            <TabsContent value="history" className="space-y-6">
              <ChangeHistoryPanel />
            </TabsContent>


            <TabsContent value="behavior" className="space-y-6">
              <RuleBehaviorPanel />
            </TabsContent>

            <TabsContent value="checked" className="space-y-6">
              <CheckedRecentlyPanel />
            </TabsContent>

            <TabsContent value="simulation" className="space-y-6">
              <SimulationTab />
            </TabsContent>

            <TabsContent value="price-history" className="space-y-6">
              <PriceHistoryTab marketplace={selectedMarketplace} />
            </TabsContent>

            <TabsContent value="ai-insights" className="space-y-6">
              <Suspense fallback={<div className="flex items-center justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div></div>}>
                <AiActionInsightsEmbed />
              </Suspense>
            </TabsContent>

            {isAdmin && (
              <TabsContent value="account-control" className="space-y-6">
                <AccountControlPanel />
              </TabsContent>
            )}
            {isAdmin && (
              <TabsContent value="smart-review" className="space-y-6">
                <SmartEngineReview />
              </TabsContent>
            )}
            {isAdmin && (
              <TabsContent value="learning" className="space-y-6">
                <SmartEngineLearning />
              </TabsContent>
            )}
            {isAdmin && (
              <TabsContent value="error-log" className="space-y-6">
                <ErrorLog embedded />
              </TabsContent>
            )}
            {isAdmin && (
              <TabsContent value="analytics" className="space-y-6">
                <AnalyticsKpiSummary />
                <Tabs defaultValue="health" className="w-full">
                  <TabsList className="grid w-full grid-cols-4 max-w-xl">
                    <TabsTrigger value="health">🏥 Health</TabsTrigger>
                    <TabsTrigger value="optimization">⚙️ Optimization</TabsTrigger>
                    <TabsTrigger value="outcomes">💰 Outcomes</TabsTrigger>
                    <TabsTrigger value="validation">🔍 72h Check</TabsTrigger>
                  </TabsList>
                  <TabsContent value="health"><HealthPresets /></TabsContent>
                  <TabsContent value="optimization"><OptimizationPresets /></TabsContent>
                  <TabsContent value="outcomes"><OutcomePresets /></TabsContent>
                  <TabsContent value="validation"><ValidationView /></TabsContent>
                </Tabs>
              </TabsContent>
            )}
          </Tabs>
        </main>
        <Footer />
      </div>

      {/* Offers Viewer Dialog */}
      <OffersViewer
        asin={viewingAsin}
        marketplace={viewingMarketplace}
        open={offersDialogOpen}
        onOpenChange={setOffersDialogOpen}
      />

      {/* AI Rule Test Dialog */}
      <AiRuleTestDialog
        rule={testingRule}
        open={testDialogOpen}
        onOpenChange={setTestDialogOpen}
      />

      {/* Applied Suggestions History */}
      <AppliedSuggestionsPanel
        open={appliedSuggestionsOpen}
        onOpenChange={setAppliedSuggestionsOpen}
        marketplace={selectedMarketplace}
      />
    </>
  );
}
