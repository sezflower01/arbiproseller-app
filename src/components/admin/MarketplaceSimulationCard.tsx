import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Globe2 } from "lucide-react";
import { toast } from "sonner";
import { getCurrencyForMarketplace } from "@/lib/marketplaceCurrency";

// Only the marketplaces the repricer engine + FX conversion fully support
// today (NA_MARKETPLACES) — simulating an EU-primary account would just
// silently fall back to US routing in several backend functions.
const SIMULATABLE_MARKETPLACES = [
  { value: "US", label: "🇺🇸 United States" },
  { value: "CA", label: "🇨🇦 Canada" },
  { value: "MX", label: "🇲🇽 Mexico" },
  { value: "BR", label: "🇧🇷 Brazil" },
];

interface SettingsRow {
  primary_marketplace: string | null;
  home_currency: string | null;
  primary_marketplace_manual_override: boolean | null;
}

export default function MarketplaceSimulationCard() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [settings, setSettings] = useState<SettingsRow | null>(null);
  const [selected, setSelected] = useState("US");

  const load = async () => {
    if (!user) return;
    setLoading(true);
    const { data } = await supabase
      .from("repricer_settings")
      .select("primary_marketplace, home_currency, primary_marketplace_manual_override")
      .eq("user_id", user.id)
      .maybeSingle();
    const row = data as SettingsRow | null;
    setSettings(row);
    setSelected(row?.primary_marketplace || "US");
    setLoading(false);
  };

  useEffect(() => { void load(); }, [user?.id]);

  const isOverridden = !!settings?.primary_marketplace_manual_override;

  const applySimulation = async () => {
    if (!user) return;
    setApplying(true);
    try {
      const homeCurrency = getCurrencyForMarketplace(selected);
      const { error } = await supabase.from("repricer_settings").upsert({
        user_id: user.id,
        primary_marketplace: selected,
        home_currency: homeCurrency,
        primary_marketplace_manual_override: true,
        primary_marketplace_detection_method: "manual_override",
        primary_marketplace_detected_at: new Date().toISOString(),
      } as any, { onConflict: "user_id" });
      if (error) throw error;
      toast.success(`Simulating ${selected} (${homeCurrency}) — reload any page to see it applied.`);
      await load();
    } catch (e: any) {
      toast.error("Failed to apply simulation: " + (e?.message || String(e)));
    } finally {
      setApplying(false);
    }
  };

  const resetToAutoDetection = async () => {
    if (!user) return;
    setResetting(true);
    try {
      const { error } = await supabase.from("repricer_settings").upsert({
        user_id: user.id,
        primary_marketplace_manual_override: false,
      } as any, { onConflict: "user_id" });
      if (error) throw error;

      // Re-run detection immediately so the account isn't left showing the
      // simulated values until next week's cron.
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        await supabase.functions.invoke("repricer-detect-primary-marketplace", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          body: {},
        });
      }
      toast.success("Back to auto-detection from real sales volume.");
      await load();
    } catch (e: any) {
      toast.error("Failed to reset: " + (e?.message || String(e)));
    } finally {
      setResetting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe2 className="h-5 w-5 text-primary" />
          Marketplace Simulation (Admin)
        </CardTitle>
        <CardDescription>
          Preview Live Sales, Sales Report, P&amp;L, and Repricer as if this account's home marketplace
          were CA/MX/BR instead of US — using your real data, no synthetic records. This only overrides
          your own account's <code className="text-[11px]">primary_marketplace</code> /{" "}
          <code className="text-[11px]">home_currency</code>, and pauses the weekly auto-detection so it
          doesn't get reverted while you're testing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-muted-foreground">Currently:</span>
          <Badge variant={isOverridden ? "default" : "outline"}>
            {settings?.primary_marketplace || "US"} · {settings?.home_currency || "USD"}
          </Badge>
          <Badge variant="outline" className="text-xs">
            {isOverridden ? "Manually simulated" : "Auto-detected"}
          </Badge>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger className="w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SIMULATABLE_MARKETPLACES.map((mp) => (
                <SelectItem key={mp.value} value={mp.value}>{mp.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={applySimulation} disabled={applying}>
            {applying ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Apply Simulation
          </Button>
          {isOverridden && (
            <Button variant="outline" onClick={resetToAutoDetection} disabled={resetting}>
              {resetting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Reset to Auto-Detection
            </Button>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground">
          Repricer pricing math (min/max price, undercut amounts) is unaffected — those are native per-marketplace
          amounts already. This only changes which currency symbol is used and applies the display-boundary FX
          conversion everywhere it was wired up this session.
        </p>
      </CardContent>
    </Card>
  );
}
