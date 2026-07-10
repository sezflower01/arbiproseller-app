import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useSubscription } from "@/hooks/use-subscription";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { Power, AlertTriangle } from "lucide-react";

export default function SchedulerToggle() {
  const { user } = useAuth();
  const { subscription } = useSubscription();
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const isExpired = subscription?.status === 'expired';
  const isCancelling = subscription?.cancel_at_period_end && subscription?.current_period_end;
  const cancelDate = isCancelling ? new Date(subscription.current_period_end!).toLocaleDateString() : null;

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from("repricer_settings")
        .select("scheduler_enabled")
        .eq("user_id", user.id)
        .maybeSingle();
      setEnabled(data?.scheduler_enabled ?? false);
      setLoading(false);
    })();
  }, [user]);

  const recalcRoiFloors = async () => {
    if (!user) return;
    try {
      const { data: rules, error: rulesErr } = await supabase
        .from("repricer_rules")
        .select("id, min_roi_marketplace_overrides")
        .eq("user_id", user.id);
      if (rulesErr) throw rulesErr;
      if (!rules || rules.length === 0) return;

      const tasks: Array<Promise<any>> = [];
      for (const r of rules as any[]) {
        const overrides = r.min_roi_marketplace_overrides || {};
        for (const [marketplace, roiValue] of Object.entries(overrides)) {
          if (roiValue == null) continue;
          tasks.push(
            supabase.functions.invoke("apply-min-roi", {
              body: { rule_id: r.id, marketplace, min_roi_percent: roiValue },
            })
          );
        }
      }
      if (tasks.length === 0) return;
      toast.info(`Recalculating ROI floors across ${tasks.length} marketplace rule${tasks.length > 1 ? "s" : ""}…`);
      const results = await Promise.allSettled(tasks);
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - ok;
      if (failed === 0) {
        toast.success(`ROI floors recalculated (${ok} rule-marketplace combos)`);
      } else {
        toast.warning(`ROI recalc: ${ok} succeeded, ${failed} failed`);
      }
    } catch (err: any) {
      console.error("ROI recalc on enable failed:", err);
      toast.error(`ROI recalc failed: ${err.message ?? err}`);
    }
  };

  const toggle = async (checked: boolean) => {
    if (!user) return;
    if (isExpired) {
      toast.error("Your subscription has ended. Please reactivate to resume repricing.");
      return;
    }
    setSaving(true);
    setEnabled(checked);

    const { error } = await supabase
      .from("repricer_settings")
      .upsert(
        { user_id: user.id, scheduler_enabled: checked },
        { onConflict: "user_id" }
      );

    if (error) {
      setEnabled(!checked);
      toast.error("Failed to update scheduler");
      console.error(error);
      setSaving(false);
      return;
    }

    if (checked) {
      toast.success("Repricer enabled — ASINs will be evaluated automatically");
      // Trigger ROI floor recalculation so engine starts with fresh bounds
      await recalcRoiFloors();
    } else {
      toast.success("Repricer paused");
    }
    setSaving(false);
  };

  if (loading) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Power className="h-4 w-4 text-primary" />
          Repricer Engine
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isExpired && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Your subscription has ended. Repricing is paused and your Amazon connection has been disconnected. Your assignments and settings are saved — reactivate to resume instantly.
            </AlertDescription>
          </Alert>
        )}
        {isCancelling && !isExpired && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Your subscription will end on {cancelDate}. After that, repricing will pause automatically.
            </AlertDescription>
          </Alert>
        )}
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Enable automatic repricing</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              When enabled, the system automatically monitors competitors and adjusts your prices 24/7.
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={toggle} disabled={saving || isExpired} />
        </div>
      </CardContent>
    </Card>
  );
}
