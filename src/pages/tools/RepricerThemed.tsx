import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdgeFunction } from "@/lib/edgeFunctionClient";
import { useAuth } from "@/contexts/AuthContext";
import { useSubscription } from "@/hooks/use-subscription";
import { useInventoryHubTheme } from "@/hooks/use-inventoryhub-theme";
import NavbarThemed from "@/components/navbar/NavbarThemed";
import { Helmet } from "react-helmet-async";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Clock } from "lucide-react";
import { usePageFavicon } from "@/hooks/use-page-favicon";
import AiRuleTestDialog from "@/components/repricer/AiRuleTestDialog";

// Import repricer components — Phase 2 adds Assignments (AssignmentsTable,
// the real "records table") on top of Phase 1's Rules/Activity Log/Price
// History. The ~10 admin-only panels (Monitor, Change History, Behavior,
// Checked, Simulation, Account Control, Smart Review, Learning, Error Log,
// Analytics) are still deferred — see chat. Their TabsTriggers / header
// dropdowns are intentionally omitted here rather than included un-rethemed.
import RuleBuilder, { type RepricerRule } from "@/components/repricer/RuleBuilder";
import ActivityLog from "@/components/repricer/ActivityLog";
import PriceHistoryTabThemed from "@/components/repricer/PriceHistoryTabThemed";
import AssignmentsTableThemed from "@/components/repricer/AssignmentsTableThemed";
import PricingSuppressionsSectionThemed from "@/components/repricer/PricingSuppressionsSectionThemed";
import OffersViewer from "@/components/repricer/OffersViewer";
import AppliedSuggestionsPanel from "@/components/repricer/AppliedSuggestionsPanel";
import { SyncReadinessBannerThemed } from "@/components/SyncReadinessBannerThemed";
import AsinInventoryLookupDialogThemed from "@/components/inventory/AsinInventoryLookupDialogThemed";
import BulkLiveInventorySyncButtonThemed from "@/components/repricer/BulkLiveInventorySyncButtonThemed";

// RuleBuilder.tsx, ActivityLog.tsx, AiRuleTestDialog.tsx, OffersViewer.tsx, and
// AppliedSuggestionsPanel.tsx are reused UNMODIFIED — audited and confirmed
// already fully token-driven, so they re-skin correctly under
// .theme-inventoryhub with zero changes. PriceHistoryTab.tsx,
// AssignmentsTable.tsx, PricingSuppressionsSection.tsx,
// AsinInventoryLookupDialog.tsx, BulkLiveInventorySyncButton.tsx, and
// SyncReadinessBanner.tsx needed real retheming — those have themed copies,
// originals untouched. AssignmentsTable's dense shipment-token data grid is
// deliberately left dark (matches its existing app-wide design — see chat).

export default function RepricerThemed() {
  useInventoryHubTheme();
  const { user } = useAuth();
  const { isAdmin } = useSubscription();
  usePageFavicon("R");
  const [rules, setRules] = useState<RepricerRule[]>([]);
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState("rules");
  const hasRules = rules.length > 0;

  // Marketplace selector state — owned by AssignmentsTable, also read by
  // Price History, exactly as in the original.
  const [selectedMarketplace, setSelectedMarketplace] = useState("US");

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

  const handleViewOffers = (asin: string, marketplace: string) => {
    setViewingAsin(asin);
    setViewingMarketplace(marketplace);
    setOffersDialogOpen(true);
  };

  const handleTestRule = async (rule: RepricerRule) => {
    if (rule.strategy === "AI_WIN_SALES_BOOSTER") {
      setTestingRule(rule);
      setTestDialogOpen(true);
    } else {
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
        <title>Advanced Repricer — InventoryHub theme preview</title>
        <meta name="robots" content="noindex, nofollow" />
        <meta
          name="description"
          content="Advanced Amazon repricer with competitor monitoring and automated pricing rules"
        />
      </Helmet>
      <div className="theme-inventoryhub font-ih-sans min-h-screen flex flex-col bg-gradient-to-b from-background to-[hsl(var(--background-gradient-end))] text-foreground relative overflow-hidden">
        {/* Ambient glow (token-based, works in any theme) */}
        <div className="absolute top-1/4 -left-32 w-96 h-96 bg-primary/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-1/4 -right-32 w-96 h-96 bg-purple-500/10 rounded-full blur-[120px]" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/5 rounded-full blur-[200px]" />

        <NavbarThemed isAdmin={isAdmin} />

        <main className="flex-1 container mx-auto px-4 pt-28 pb-8 relative z-10">
          <SyncReadinessBannerThemed module="repricer" />
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className="flex items-center gap-2 mb-6 flex-wrap">
              <AsinInventoryLookupDialogThemed />
              <BulkLiveInventorySyncButtonThemed />
              <TabsList>
                {hasRules && <TabsTrigger value="assignments">Assignments</TabsTrigger>}
                <TabsTrigger value="rules">Rules</TabsTrigger>
                {isAdmin && <TabsTrigger value="activity">Activity Log</TabsTrigger>}
                <TabsTrigger value="price-history" className="flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" /> Price History
                </TabsTrigger>
              </TabsList>
            </div>

            {hasRules && (
              <TabsContent value="assignments" className="space-y-6">
                <PricingSuppressionsSectionThemed marketplace={selectedMarketplace} isAdmin={isAdmin} />
                <AssignmentsTableThemed
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

            <TabsContent value="price-history" className="space-y-6">
              <PriceHistoryTabThemed marketplace={selectedMarketplace} />
            </TabsContent>
          </Tabs>
        </main>
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
