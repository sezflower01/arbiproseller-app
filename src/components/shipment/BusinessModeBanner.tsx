import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Settings2 } from "lucide-react";
import { useBusinessMode } from "@/hooks/use-business-mode";
import { getModeConfig, type ShipmentBusinessMode } from "@/lib/shipment/businessMode";
import BusinessModePicker from "./BusinessModePicker";

/**
 * Header pill that shows the current Shipment Business Mode and opens a
 * picker dialog. On first visit (no choice yet) it auto-opens the dialog
 * as a soft onboarding step — OA is preselected so dismissing keeps the
 * existing workflow unchanged.
 */
export default function BusinessModeBanner() {
  const { mode, setMode, hasChosen, loading } = useBusinessMode();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ShipmentBusinessMode>(mode);

  useEffect(() => {
    setDraft(mode);
  }, [mode]);

  // Always prompt for mode when entering the Shipment Builder so the user
  // can confirm or switch between OA / Wholesale / Hybrid / Prep Center
  // before working on a draft.
  useEffect(() => {
    if (!loading) setOpen(true);
  }, [loading]);

  if (loading) return null;
  const cfg = getModeConfig(mode);

  return (
    <>
      <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs">
        <Badge className="bg-primary/20 text-primary border-primary/30">{cfg.shortLabel} Mode</Badge>
        <span className="text-white/70 hidden sm:inline">{cfg.headerHint}</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-white/80 hover:text-white underline-offset-2 hover:underline inline-flex items-center gap-1"
        >
          <Settings2 className="h-3 w-3" />
          Change
        </button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>What kind of seller are you?</DialogTitle>
            <DialogDescription>
              The Shipment Builder adapts to how you actually source. You can change this at any time from Settings.
              {!hasChosen && " Your current OA workflow stays exactly the same — picking OA changes nothing."}
            </DialogDescription>
          </DialogHeader>
          <BusinessModePicker value={draft} onChange={setDraft} />
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {hasChosen ? "Cancel" : "Skip (keep OA)"}
            </Button>
            <Button
              onClick={async () => {
                await setMode(draft);
                setOpen(false);
              }}
            >
              Save & continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
