import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ReceiptText, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useFbaEligibility } from "@/hooks/use-fba-eligibility";
import { FbaReadinessTracker } from "@/components/fba/FbaReadinessTracker";
import { Checkbox } from "@/components/ui/checkbox";

interface CreatePurchaseFromCostButtonProps {
  asin: string;
  sku: string;
  title: string;
  /** Effective unit cost currently on inventory (will become amount). */
  unitCost: number;
  /** Default purchase quantity prefilled into the dialog. */
  defaultUnits?: number;
  /** Optional image to copy into the new Created Listing. */
  imageUrl?: string | null;
  size?: "sm" | "default";
  variant?: "outline" | "ghost" | "secondary";
  className?: string;
  onCreated?: () => void;
}

/**
 * Phase 7 — "Create purchase record from this cost".
 *
 * For new sellers who synced Amazon inventory before any Created Listings
 * exist, lets the user explicitly create a purchase record from the
 * operational cost they already entered in inventory/repricer.
 *
 * Inserts (Contract A):
 *   created_listings.amount = unitCost              (UNIT cost)
 *   created_listings.units  = user-entered units    (purchase qty)
 *   created_listings.cost   = amount * units        (TOTAL batch cost)
 *
 * Does NOT auto-fire — user must click & confirm. Inventory.cost / override
 * flag are intentionally left untouched here.
 */
export function CreatePurchaseFromCostButton({
  asin,
  sku,
  title,
  unitCost,
  defaultUnits,
  imageUrl,
  size = "sm",
  variant = "outline",
  className,
  onCreated,
}: CreatePurchaseFromCostButtonProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [units, setUnits] = useState<string>(
    defaultUnits && defaultUnits > 0 ? String(defaultUnits) : "",
  );
  const [saving, setSaving] = useState(false);
  const [fbmOnlyAck, setFbmOnlyAck] = useState(false);
  const fbaElig = useFbaEligibility({ asin, marketplace: "US", enabled: open });
  const isBlocked = !!fbaElig.data && !fbaElig.data.eligible;

  if (!Number.isFinite(unitCost) || unitCost <= 0) return null;

  const parsedUnits = parseInt(units, 10);
  const validUnits = Number.isFinite(parsedUnits) && parsedUnits > 0;
  const totalPreview = validUnits ? Number((unitCost * parsedUnits).toFixed(2)) : null;

  const handleCreate = async () => {
    if (!user || !validUnits) return;
    if (isBlocked && !fbmOnlyAck) return;
    setSaving(true);
    try {
      const amount = Number(unitCost.toFixed(4));
      const total = Number((unitCost * parsedUnits).toFixed(2));

      const { error } = await supabase.from("created_listings").insert({
        user_id: user.id,
        asin,
        sku,
        title,
        image_url: imageUrl ?? null,
        amount,
        units: parsedUnits,
        cost: total,
        date_created: new Date().toISOString().slice(0, 10),
        notes: isBlocked
          ? "Created from inventory operational cost (FBM-only — FBA blocked)"
          : "Created from inventory operational cost (Phase 7)",
        fba_blocked: isBlocked,
        fba_block_reason: isBlocked ? fbaElig.data?.fba_block_reason ?? null : null,
      } as any);

      if (error) throw error;

      toast({
        title: "Purchase record created",
        description: `${asin} — ${parsedUnits} units @ $${amount.toFixed(2)}`,
      });
      setOpen(false);
      onCreated?.();
    } catch (err: any) {
      console.error("[CreatePurchaseFromCost] failed:", err);
      toast({
        variant: "destructive",
        title: "Failed to create purchase record",
        description: err?.message ?? "Please try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size={size}
          variant={variant}
          className={className}
          type="button"
        >
          <ReceiptText className="h-3 w-3 mr-1" />
          Create purchase record
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create purchase record</DialogTitle>
          <DialogDescription>
            Logs your operational cost as a Created Listing so this ASIN has a
            purchase history. Your inventory cost stays the same.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="rounded border p-2 bg-muted/30">
            <div className="font-mono text-xs">{asin}</div>
            <div className="text-xs text-muted-foreground line-clamp-2">{title}</div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">Unit cost</Label>
              <div className="h-9 px-3 flex items-center rounded-md border bg-muted/30 text-sm font-medium">
                ${unitCost.toFixed(2)}
              </div>
            </div>
            <div>
              <Label htmlFor="purchase-units" className="text-xs text-muted-foreground">
                Units purchased
              </Label>
              <Input
                id="purchase-units"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={units}
                onChange={(e) => setUnits(e.target.value)}
                placeholder="e.g. 24"
                autoFocus
              />
            </div>
          </div>

          <div className="rounded border border-dashed p-2 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Total batch cost</span>
            <span className="font-semibold">
              {totalPreview !== null ? `$${totalPreview.toFixed(2)}` : "—"}
            </span>
          </div>

          <FbaReadinessTracker
            eligibility={fbaElig.data}
            loading={fbaElig.loading}
            onRecheck={fbaElig.recheck}
            onRunDryRun={fbaElig.runDryRun}
            dryRunLoading={fbaElig.dryRunLoading}
          />

          {isBlocked && (
            <label className="flex items-start gap-2 rounded border border-red-300 bg-red-50/60 dark:bg-red-950/30 p-2 text-xs cursor-pointer">
              <Checkbox
                checked={fbmOnlyAck}
                onCheckedChange={(v) => setFbmOnlyAck(!!v)}
                className="mt-0.5"
              />
              <span>
                I understand Amazon will reject FBA shipments for this ASIN.
                Save this purchase as <strong>FBM-only</strong> (will be excluded from FBA shipment plans).
              </span>
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={saving || !validUnits || (isBlocked && !fbmOnlyAck)}
            variant={isBlocked ? "destructive" : "default"}
          >
            {saving ? (
              <>
                <Loader2 className="h-3 w-3 mr-2 animate-spin" /> Creating...
              </>
            ) : isBlocked ? (
              "Save as FBM only"
            ) : (
              "Create record"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
