import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Helmet } from "react-helmet-async";
import { Shield, BarChart3 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import HealthPresets from "@/components/analytics/HealthPresets";
import OptimizationPresets from "@/components/analytics/OptimizationPresets";
import OutcomePresets from "@/components/analytics/OutcomePresets";

export default function RepricerAnalytics() {
  const { user } = useAuth();
  const [hasAccess, setHasAccess] = useState<boolean | null>(null);

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
          <p className="text-muted-foreground">You need the <strong>monitor</strong> or <strong>admin</strong> role.</p>
        </div>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Helmet>
        <title>Repricer Analytics - ArbiPro Seller</title>
      </Helmet>
      <div className="dark min-h-screen flex flex-col bg-[hsl(222,84%,4.9%)] text-white">
        <Navbar />
        <main className="flex-1 container mx-auto px-4 py-8 pt-24 space-y-6">
          <div>
            <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
              <BarChart3 className="h-8 w-8 text-primary" />
              Repricer Analytics
            </h1>
            <p className="text-muted-foreground mt-1">
              Preset queries to measure engine health, optimization impact, and business outcomes
            </p>
          </div>

          <Tabs defaultValue="health" className="w-full">
            <TabsList className="grid w-full grid-cols-3 max-w-lg">
              <TabsTrigger value="health">🏥 Health</TabsTrigger>
              <TabsTrigger value="optimization">⚙️ Optimization</TabsTrigger>
              <TabsTrigger value="outcomes">💰 Outcomes</TabsTrigger>
            </TabsList>
            <TabsContent value="health"><HealthPresets /></TabsContent>
            <TabsContent value="optimization"><OptimizationPresets /></TabsContent>
            <TabsContent value="outcomes"><OutcomePresets /></TabsContent>
          </Tabs>
        </main>
        <Footer />
      </div>
    </>
  );
}
