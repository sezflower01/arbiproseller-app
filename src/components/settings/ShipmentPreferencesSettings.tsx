import { useState } from "react";
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBusinessMode } from "@/hooks/use-business-mode";
import { getModeConfig, type ShipmentBusinessMode } from "@/lib/shipment/businessMode";
import BusinessModePicker from "@/components/shipment/BusinessModePicker";
import { toast } from "sonner";

export default function ShipmentPreferencesSettings() {
  const { mode, setMode, loading } = useBusinessMode();
  const [draft, setDraft] = useState<ShipmentBusinessMode>(mode);
  const [saving, setSaving] = useState(false);

  if (loading) return null;
  const dirty = draft !== mode;
  const cfg = getModeConfig(mode);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Shipment Preferences</CardTitle>
        <CardDescription>
          Choose how the FBA Shipment Builder should behave for your business. OA is the default — picking it keeps the
          existing workflow exactly the same. Other modes layer optional fields and recommendations on top.
          <br />
          <span className="text-xs text-muted-foreground mt-2 inline-block">
            Currently active: <strong>{cfg.label}</strong> — {cfg.tagline}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <BusinessModePicker value={draft} onChange={setDraft} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDraft(mode)} disabled={!dirty || saving}>
            Reset
          </Button>
          <Button
            disabled={!dirty || saving}
            onClick={async () => {
              setSaving(true);
              try {
                await setMode(draft);
                toast.success("Shipment mode updated");
              } catch {
                toast.error("Could not save preference");
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
