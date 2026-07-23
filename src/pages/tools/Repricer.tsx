import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useSubscription } from "@/hooks/use-subscription";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Helmet } from "react-helmet-async";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePageFavicon } from "@/hooks/use-page-favicon";
import IntlRoiSweepCard from "@/components/repricer/IntlRoiSweepCard";

// Import repricer components
import RuleBuilder, { type RepricerRule } from "@/components/repricer/RuleBuilder";
import AssignmentsTable from "@/components/repricer/AssignmentsTable";
import PricingSuppressionsSection from "@/components/repricer/PricingSuppressionsSection";
import RepricerSettings from "@/components/repricer/RepricerSettings";
import AutomationStatusPanel from "@/components/repricer/AutomationStatusPanel";
import AutoOnboardingSettings from "@/components/settings/AutoOnboardingSettings";
import SchedulerToggle from "@/components/repricer/SchedulerToggle";
import { SyncReadinessBanner } from "@/components/SyncReadinessBanner";

export default function Repricer() {
  const { user } = useAuth();
  const { isAdmin } = useSubscription();
  usePageFavicon("R");
  const [rules, setRules] = useState<RepricerRule[]>([]);
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState("assignments");
  const hasRules = rules.length > 0;

  // Marketplace selector state — persisted so returning to this page lands
  // back on the same marketplace (and therefore hits its cached data)
  // instead of always resetting to US.
  const [selectedMarketplace, setSelectedMarketplaceRaw] = useState<string>(() => {
    try {
      const v = localStorage.getItem("repricer.selectedMarketplace");
      if (v) return v;
    } catch { /* ignore */ }
    return "US";
  });
  const setSelectedMarketplace = useCallback((mp: string) => {
    setSelectedMarketplaceRaw(mp);
    try { localStorage.setItem("repricer.selectedMarketplace", mp); } catch { /* ignore */ }
  }, []);

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
              <TabsList className="bg-white/80 backdrop-blur-sm border border-white/30 text-[hsl(221,100%,10%)] font-bold">
                {hasRules && <TabsTrigger value="assignments">Assignments</TabsTrigger>}
                <TabsTrigger value="rules">Rules</TabsTrigger>
                <TabsTrigger value="settings">Control Panel</TabsTrigger>
                {isAdmin && <TabsTrigger value="automation-status">Automation Status</TabsTrigger>}
              </TabsList>
            </div>

            {hasRules && (
              <TabsContent value="assignments" className="space-y-6">
                <PricingSuppressionsSection marketplace={selectedMarketplace} isAdmin={isAdmin} />
                <AssignmentsTable
                  rules={rules}
                  marketplace={selectedMarketplace}
                  onMarketplaceChange={setSelectedMarketplace}
                  isAdmin={isAdmin}
                />
              </TabsContent>
            )}

            <TabsContent value="rules" className="space-y-6">
              {!hasRules && rulesLoaded && (
                <div className="rounded-xl border border-primary/30 bg-primary/10 backdrop-blur-sm p-5 text-foreground">
                  <h3 className="text-base font-semibold mb-1">Create your first repricing rule</h3>
                  <p className="text-sm opacity-80">
                    The Assignments tab will unlock once you create a rule. Your first rule is automatically set as the default for new listings in Control Panel → Auto Onboarding.
                  </p>
                </div>
              )}
              <RuleBuilder onRulesChange={fetchRules} isAdmin={isAdmin} />
            </TabsContent>

            <TabsContent value="settings" className="space-y-6">
              <div className="max-w-xl space-y-6">
                {!isAdmin && <SchedulerToggle />}
                {isAdmin && <RepricerSettings isAdmin={isAdmin} />}
                <AutoOnboardingSettings />
                <IntlRoiSweepCard isAdmin={isAdmin} />
              </div>
            </TabsContent>

            {isAdmin && (
              <TabsContent value="automation-status" className="space-y-6">
                <div className="max-w-xl">
                  <AutomationStatusPanel isAdmin={isAdmin} />
                </div>
              </TabsContent>
            )}
          </Tabs>
        </main>
        <Footer />
      </div>
    </>
  );
}
