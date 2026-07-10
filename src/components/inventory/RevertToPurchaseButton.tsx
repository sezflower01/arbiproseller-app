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
import { Undo2, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { getListingUnitCost } from "@/lib/cost-contract";

interface RevertToPurchaseButtonProps {
  /** Inventory row id to revert. */
  inventoryId: string;
  asin: string;
  sku?: string | null;
  /** Current effective unit cost (for the confirm dialog). */
  currentCost?: number | null;
  /** Called after a successful revert so callers can refetch. */
  onReverted?: () => void;
  size?: "sm" | "default";
  variant?: "outline" | "ghost" | "secondary";
  className?: string;
}

/**
 * Phase 7 — "Revert to Purchase Cost" action.
 *
 * Clears the manual override on an inventory row and restores the unit cost
 * from the purchase record (created_listings) under Contract A:
 *
 *   inventory.cost            = listing UNIT cost (from amount, or cost/units)
 *   inventory.unit_cost_manual = false
 *   inventory.manual_cost_*   = NULL  (audit reset)
 *
 * If no usable purchase unit cost exists, the action is blocked with a
 * helpful toast — we never silently overwrite with $0.
 */
export function RevertToPurchaseButton({
  inventoryId,
  asin,
  sku,
  currentCost,
  onReverted,
  size = "sm",
  variant = "ghost",
  className,
}: RevertToPurchaseButtonProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [purchaseCost, setPurchaseCost] = useState<number | null>(null);
  const [loadingPurchase, setLoadingPurchase] = useState(false);

  const loadPurchaseCost = async () => {
    if (!user) return;
    setLoadingPurchase(true);
    try {
      // Prefer SKU match, fall back to ASIN match (latest updated row)
      let listing: { cost: number | null; amount: number | null; units: number | null } | null = null;

      if (sku) {
        const { data } = await supabase
          .from("created_listings")
          .select("cost, amount, units")
          .eq("user_id", user.id)
          .eq("sku", sku)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        listing = data;
      }

      if (!listing) {
        const { data } = await supabase
          .from("created_listings")
          .select("cost, amount, units")
          .eq("user_id", user.id)
          .eq("asin", asin)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        listing = data;
      }

      const unit = listing ? getListingUnitCost(listing) : null;
      setPurchaseCost(unit);
    } catch (err) {
      console.warn("[RevertToPurchase] Failed to load purchase cost:", err);
      setPurchaseCost(null);
    } finally {
      setLoadingPurchase(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setPurchaseCost(null);
      void loadPurchaseCost();
    }
  };

  const handleRevert = async () => {
    if (!user) return;
    if (purchaseCost === null || !Number.isFinite(purchaseCost) || purchaseCost <= 0) {
      toast({
        variant: "destructive",
        title: "No purchase cost available",
        description: "There's no usable unit cost on the purchase record to revert to.",
      });
      return;
    }

    setSaving(true);
    try {
      const nowIso = new Date().toISOString();
      const { error } = await supabase
        .from("inventory")
        .update({
          cost: purchaseCost,
          unit_cost_manual: false,
          manual_cost_updated_at: null,
          manual_cost_source: null,
          manual_cost_reason: null,
          updated_at: nowIso,
        })
        .eq("id", inventoryId)
        .eq("user_id", user.id);

      if (error) throw error;

      toast({
        title: "Reverted to purchase cost",
        description: `Unit cost restored to $${purchaseCost.toFixed(2)} from your purchase record.`,
      });
      setOpen(false);
      onReverted?.();
    } catch (err: any) {
      console.error("[RevertToPurchase] Failed:", err);
      toast({
        variant: "destructive",
        title: "Failed to revert",
        description: err?.message ?? "Please try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button size={size} variant={variant} className={className} type="button">
          <Undo2 className="h-3 w-3 mr-1" />
          Revert to purchase
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revert to purchase cost?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                This clears the manual override on ASIN{" "}
                <span className="font-mono">{asin}</span> and restores the unit cost from your
                purchase record (Created Listing).
              </p>
              <div className="rounded-md border bg-muted/40 p-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Current (overridden):</span>
                  <span className="font-mono font-medium">
                    {currentCost != null ? `$${currentCost.toFixed(2)}` : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-muted-foreground">Purchase cost:</span>
                  <span className="font-mono font-medium">
                    {loadingPurchase
                      ? "Loading..."
                      : purchaseCost != null
                      ? `$${purchaseCost.toFixed(2)}`
                      : "Not available"}
                  </span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Future syncs will keep this row in sync with your purchase record.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleRevert}
            disabled={saving || loadingPurchase || purchaseCost === null || purchaseCost <= 0}
          >
            {saving ? (
              <>
                <Loader2 className="h-3 w-3 mr-2 animate-spin" /> Reverting...
              </>
            ) : (
              "Revert"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
