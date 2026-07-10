import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Shield, Scale, Zap, Sparkles } from "lucide-react";

type Tier = "conservative" | "balanced" | "aggressive" | "autonomous";

const tiers: {
  id: Tier;
  label: string;
  icon: any;
  desc: string;
  allowAutoFix: boolean;
  allowRecovery: boolean;
}[] = [
  {
    id: "conservative",
    label: "Conservative",
    icon: Shield,
    desc: "Only the highest-confidence adaptations apply. No autonomous raises.",
    allowAutoFix: false,
    allowRecovery: false,
  },
  {
    id: "balanced",
    label: "Balanced",
    icon: Scale,
    desc: "Default. Adapts on solid evidence; you approve recoveries.",
    allowAutoFix: false,
    allowRecovery: false,
  },
  {
    id: "aggressive",
    label: "Aggressive",
    icon: Zap,
    desc: "Faster adaptation, autonomous margin recovery on stable winners.",
    allowAutoFix: true,
    allowRecovery: true,
  },
  {
    id: "autonomous",
    label: "Autonomous AI",
    icon: Sparkles,
    desc: "Full self-optimization. Recoveries, tier adjustments, and auto-fixes run hands-off.",
    allowAutoFix: true,
    allowRecovery: true,
  },
];

export default function AutomationTierCard() {
  const { user } = useAuth();
  const [tier, setTier] = useState<Tier>("balanced");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      if (!user) return;
      const { data } = await supabase
        .from("repricer_user_automation_preferences")
        .select("automation_tier")
        .eq("user_id", user.id)
        .maybeSingle();
      if (data?.automation_tier) setTier(data.automation_tier as Tier);
      setLoading(false);
    };
    load();
  }, [user]);

  const choose = async (t: Tier) => {
    if (!user || saving) return;
    setSaving(true);
    const meta = tiers.find((x) => x.id === t)!;
    try {
      const { error } = await supabase
        .from("repricer_user_automation_preferences")
        .upsert(
          {
            user_id: user.id,
            automation_tier: t,
            allow_auto_fix: meta.allowAutoFix,
            allow_autonomous_recovery: meta.allowRecovery,
          },
          { onConflict: "user_id" },
        );
      if (error) throw error;
      setTier(t);
      toast.success(`Automation tier set to ${meta.label}`);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to update tier");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          Automation Mode
          <Badge variant="outline" className="capitalize">
            {tier}
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Controls how aggressively the Adaptation Engine acts. Floors and ROI
          protections are always preserved.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {tiers.map((t) => {
            const Icon = t.icon;
            const active = tier === t.id;
            return (
              <button
                key={t.id}
                onClick={() => choose(t.id)}
                disabled={saving}
                className={`text-left rounded-lg border p-3 transition-colors ${
                  active
                    ? "border-primary bg-primary/10"
                    : "border-border/60 bg-card/40 hover:border-primary/50"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Icon
                    className={`h-4 w-4 ${active ? "text-primary" : "text-muted-foreground"}`}
                  />
                  <span className="text-sm font-semibold">{t.label}</span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-snug">
                  {t.desc}
                </p>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
