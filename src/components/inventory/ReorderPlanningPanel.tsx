import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Settings2, Save, RotateCcw } from "lucide-react";
import { toast } from "@/hooks/use-toast";

export type ReorderPlanningSettings = {
  coverage_days: number;
  supplier_lead_time_days: number;
  prep_days: number;
  shipping_to_amazon_days: number;
  amazon_receiving_days: number;
  safety_percent: number;
};

export const DEFAULT_REORDER_SETTINGS: ReorderPlanningSettings = {
  coverage_days: 30,
  supplier_lead_time_days: 7,
  prep_days: 2,
  shipping_to_amazon_days: 5,
  amazon_receiving_days: 7,
  safety_percent: 10,
};

type Props = {
  userId: string;
  value: ReorderPlanningSettings;
  onChange: (next: ReorderPlanningSettings) => void;
};

export default function ReorderPlanningPanel({ userId, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ReorderPlanningSettings>(value);

  useEffect(() => { setDraft(value); }, [value]);

  const totalLeadTime =
    (draft.supplier_lead_time_days || 0) +
    (draft.prep_days || 0) +
    (draft.shipping_to_amazon_days || 0) +
    (draft.amazon_receiving_days || 0);
  const planningDays = (draft.coverage_days || 0) + totalLeadTime;

  const updateField = (key: keyof ReorderPlanningSettings, raw: string) => {
    const num = Number(raw);
    if (Number.isNaN(num) || num < 0) return;
    setDraft((d) => ({ ...d, [key]: num }));
  };

  const save = async () => {
    if (!userId) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("reorder_planning_settings")
        .upsert({ user_id: userId, ...draft }, { onConflict: "user_id" });
      if (error) throw error;
      onChange(draft);
      toast({ title: "Settings saved", description: "Reorder planning will be recalculated." });
      setOpen(false);
    } catch (err: any) {
      toast({ title: "Could not save", description: err?.message || "Try again", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const resetDefaults = () => setDraft(DEFAULT_REORDER_SETTINGS);

  return (
    <Card className="mb-4">
      <CardHeader className="pb-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center justify-between w-full text-left"
        >
          <CardTitle className="flex items-center gap-2 text-base">
            <Settings2 className="h-4 w-4 text-primary" />
            Reorder Planning Settings
          </CardTitle>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>Lead time <strong className="text-foreground">{totalLeadTime}d</strong></span>
            <span>·</span>
            <span>Planning <strong className="text-foreground">{planningDays}d</strong></span>
            <span>·</span>
            <span>Safety <strong className="text-foreground">{draft.safety_percent}%</strong></span>
            <span className="text-primary">{open ? "Hide" : "Edit"}</span>
          </div>
        </button>
      </CardHeader>

      {open && (
        <CardContent className="pt-0">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <Field label="Coverage Days" hint="Selling days after stock arrives"
              value={draft.coverage_days} onChange={(v) => updateField("coverage_days", v)} />
            <Field label="Supplier Lead Time" hint="Days to receive from supplier"
              value={draft.supplier_lead_time_days} onChange={(v) => updateField("supplier_lead_time_days", v)} />
            <Field label="Prep / Label Days" hint="Days before shipping"
              value={draft.prep_days} onChange={(v) => updateField("prep_days", v)} />
            <Field label="Shipping to Amazon" hint="Transit days"
              value={draft.shipping_to_amazon_days} onChange={(v) => updateField("shipping_to_amazon_days", v)} />
            <Field label="Amazon Receiving" hint="Days until check-in"
              value={draft.amazon_receiving_days} onChange={(v) => updateField("amazon_receiving_days", v)} />
            <Field label="Safety Stock %" hint="Extra buffer percent"
              value={draft.safety_percent} onChange={(v) => updateField("safety_percent", v)} />
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              Each unit will be planned for{" "}
              <strong className="text-foreground">{planningDays} days</strong>{" "}
              ({draft.coverage_days} coverage + {totalLeadTime} pipeline) with a{" "}
              <strong className="text-foreground">{draft.safety_percent}%</strong> buffer.
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={resetDefaults} className="gap-1.5">
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </Button>
              <Button size="sm" onClick={save} disabled={saving} className="gap-1.5">
                <Save className="h-3.5 w-3.5" />
                {saving ? "Saving..." : "Save settings"}
              </Button>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function Field({
  label, hint, value, onChange,
}: { label: string; hint: string; value: number; onChange: (raw: string) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        min={0}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(e.target.value)}
        className="h-8"
      />
      <p className="text-[10px] text-muted-foreground leading-tight">{hint}</p>
    </div>
  );
}
