import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { TestTubes } from "lucide-react";
import SimulationTab from "@/components/repricer/SimulationTab";

export default function RepricerSimulation() {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (!user) { setIsAdmin(false); return; }
    supabase.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
  }, [user]);

  if (isAdmin === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <>
        <Navbar />
        <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background">
          <h1 className="text-2xl font-bold text-foreground">Access Restricted</h1>
          <p className="text-muted-foreground">You need the <strong>admin</strong> role to view this page.</p>
        </div>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Helmet>
        <title>Repricer Simulation — ArbiProSeller</title>
      </Helmet>
      <div className="min-h-screen flex flex-col bg-background">
        <Navbar />
        <main className="flex-1 container mx-auto px-4 py-8 pt-24 space-y-6">
          <div>
            <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
              <TestTubes className="h-8 w-8 text-primary" />
              Repricer Simulation
            </h1>
            <p className="text-muted-foreground mt-1">
              Test how a rule would behave before applying it live.
            </p>
          </div>
          <SimulationTab />
        </main>
        <Footer />
      </div>
    </>
  );
}
