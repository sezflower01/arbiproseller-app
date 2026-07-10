import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ArrowRightLeft, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";

interface ApplyToPurchaseButtonProps {
  asin: string;
  /** New unit cost the user just set on the inventory row. */
  unitCost: number;
  /** Optional: inventory row id, used only for the audit log. */
  inventoryId?: string;
  /** Called after a successful write so callers can refetch. */
  onApplied?: () => void;
  /** Compact rendering inside small editors. */
  size?: "sm" | "default";
  variant?: "outline" | "ghost" | "secondary";
  className?: string;
}

/**
 * Phase 7 — Optional "Apply this cost to purchase record" action.
 *
 * Writes the operational unit cost back into created_listings:
 *   created_listings.amount = unitCost              (UNIT — Contract A)
 *   created_listings.cost   = unitCost * units      (TOTAL — Contract A)
 *
 * Inventory.cost / unit_cost_manual are intentionally NOT cleared here —
 * the override is what the user just chose. If they want sync to take over
 * again, they can clear the override separately.
 */
export function ApplyToPurchaseButton({
  asin,
  unitCost,
  inventoryId,
  onApplied,
  size = "sm",
  variant = "outline",
  className,
}: ApplyToPurchaseButtonProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!Number.isFinite(unitCost) || unitCost <= 0) return null;

  const handleApply = async () => {
    if (!user) return;
    setSaving(true);
    try {
      // Find the latest created_listings row for this ASIN (purchase history aggregate)
      const { data: listings, error: fetchError } = await supabase
        .from("created_listings")
        .select("id, units, cost, amount, asin, sku")
        .eq("user_id", user.id)
        .eq("asin", asin)
        .order("updated_at", { ascending: false })
        .limit(1);

      if (fetchError) throw fetchError;
      if (!listings || listings.length === 0) {
        toast({
          variant: "destructive",
          title: "No purchase record found",
          description: `No Created Listing exists for ASIN ${asin}.`,
        });
        return;
      }

      const listing = listings[0];
      const units = Number(listing.units) || 0;

      if (units <= 0) {
        toast({
          variant: "destructive",
          title: "Cannot apply",
          description: "Purchase record has no units recorded.",
        });
        return;
      }

      const newAmount = Number(unitCost.toFixed(4));
      const newTotal = Number((unitCost * units).toFixed(2));

      const { error: updateError } = await supabase
        .from("created_listings")
        .update({
          amount: newAmount,
          cost: newTotal,
          updated_at: new Date().toISOString(),
        })
        .eq("id", listing.id)
        .eq("user_id", user.id);

      if (updateError) throw updateError;

      // Best-effort audit row (table is read-only here so failure is non-fatal)
      try {
        await supabase.from("cost_repair_audit").insert({
          user_id: user.id,
          table_name: "created_listings",
          row_id: listing.id,
          asin: listing.asin,
          sku: listing.sku,
          repair_category: "phase7_apply_to_purchase",
          dry_run: false,
          applied: true,
          applied_at: new Date().toISOString(),
          before_snapshot: {
            cost: listing.cost,
            amount: listing.amount,
            units: listing.units,
          },
          after_snapshot: {
            cost: newTotal,
            amount: newAmount,
            units,
          },
          ledger_total: newTotal,
          ledger_unit_cost: newAmount,
          ledger_units: units,
          notes: `Phase 7: user applied operational override to purchase record. Triggered from inventory row ${inventoryId ?? "n/a"}.`,
        });
      } catch (auditErr) {
        console.warn("[ApplyToPurchase] Audit insert failed (non-fatal):", auditErr);
      }

      toast({
        title: "Purchase record updated",
        description: `Created Listing for ${asin} now reflects $${newAmount.toFixed(2)}/unit.`,
      });
      setOpen(false);
      onApplied?.();
    } catch (err: any) {
      console.error("[ApplyToPurchase] Failed:", err);
      toast({
        variant: "destructive",
        title: "Failed to update purchase record",
        description: err?.message ?? "Please try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          size={size}
          variant={variant}
          className={className}
          type="button"
        >
          <ArrowRightLeft className="h-3 w-3 mr-1" />
          Apply to purchase record
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Apply ${unitCost.toFixed(2)} to purchase record?</AlertDialogTitle>
          <AlertDialogDescription>
            This will update the Created Listing for ASIN <span className="font-mono">{asin}</span> so that:
            <ul className="mt-2 ml-4 list-disc space-y-1 text-sm">
              <li>Unit cost (COG) becomes <span className="font-semibold">${unitCost.toFixed(2)}</span></li>
              <li>Total batch cost is recalculated as unit cost × units</li>
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              Your inventory override stays in place. Use this only when the new cost reflects what you actually paid.
            </p>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleApply} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-3 w-3 mr-2 animate-spin" /> Applying...
              </>
            ) : (
              "Apply to purchase"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
