import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Loader2, Save, Trash2 } from "lucide-react";

interface Purchase {
  id: string;
  units: number;
  unit_cost: number;
  total_cost: number;
  note: string | null;
  purchase_date: string;
}

interface PurchaseDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listingId: string;
  listingTitle: string;
  listingAsin: string;
  listingImage: string | null;
  onPurchasesChanged?: () => void;
}

export function PurchaseDetailsDialog({
  open,
  onOpenChange,
  listingId,
  listingTitle,
  listingAsin,
  listingImage,
  onPurchasesChanged,
}: PurchaseDetailsDialogProps) {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingNote, setEditingNote] = useState<Record<string, string>>({});
  const [savingNote, setSavingNote] = useState<string | null>(null);

  useEffect(() => {
    if (open && listingId) {
      fetchPurchases();
    }
  }, [open, listingId]);

  const fetchPurchases = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("created_listing_purchases")
        .select("id, units, unit_cost, total_cost, note, purchase_date")
        .eq("listing_id", listingId)
        .order("purchase_date", { ascending: false });

      if (error) throw error;
      setPurchases(data || []);
      // Init note editing state
      const notes: Record<string, string> = {};
      (data || []).forEach((p) => {
        notes[p.id] = p.note || "";
      });
      setEditingNote(notes);
    } catch (e: any) {
      toast.error("Failed to load purchase history");
    } finally {
      setLoading(false);
    }
  };

  const saveNote = async (purchaseId: string) => {
    setSavingNote(purchaseId);
    try {
      const { error } = await supabase
        .from("created_listing_purchases")
        .update({ note: editingNote[purchaseId] || null })
        .eq("id", purchaseId);
      if (error) throw error;
      setPurchases((prev) =>
        prev.map((p) =>
          p.id === purchaseId ? { ...p, note: editingNote[purchaseId] || null } : p
        )
      );
      toast.success("Note saved");
    } catch {
      toast.error("Failed to save note");
    } finally {
      setSavingNote(null);
    }
  };

  const deletePurchase = async (purchaseId: string) => {
    try {
      const { error } = await supabase
        .from("created_listing_purchases")
        .delete()
        .eq("id", purchaseId);
      if (error) throw error;

      const remaining = purchases.filter((p) => p.id !== purchaseId);
      setPurchases(remaining);

      // Recalculate and update the parent listing totals
      const newTotalUnits = remaining.reduce((sum, p) => sum + p.units, 0);
      const newTotalCost = remaining.reduce((sum, p) => sum + p.total_cost, 0);
      const newUnitCost = newTotalUnits > 0 ? newTotalCost / newTotalUnits : 0;

      await supabase
        .from("created_listings")
        .update({
          units: newTotalUnits,
          cost: newTotalCost,
          amount: newUnitCost,
        })
        .eq("id", listingId);

      onPurchasesChanged?.();
      toast.success("Purchase record deleted");
    } catch {
      toast.error("Failed to delete");
    }
  };

  const totalUnits = purchases.reduce((sum, p) => sum + p.units, 0);
  const totalCost = purchases.reduce((sum, p) => sum + p.total_cost, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            {listingImage && (
              <img
                src={listingImage}
                alt=""
                className="w-10 h-10 object-contain rounded"
              />
            )}
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">{listingTitle}</div>
              <div className="text-xs text-muted-foreground">{listingAsin}</div>
            </div>
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : purchases.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            No purchase history recorded yet. New purchases added via "Add Purchase" will appear here.
          </div>
        ) : (
          <>
            <div className="flex gap-4 mb-3 text-xs text-muted-foreground">
              <span>Total Purchases: <strong className="text-foreground">{purchases.length}</strong></span>
              <span>Total Units: <strong className="text-foreground">{totalUnits}</strong></span>
              <span>Total Cost: <strong className="text-foreground">${totalCost.toFixed(2)}</strong></span>
            </div>
            <div className="space-y-3">
              {purchases.map((p) => (
                <div
                  key={p.id}
                  className="border border-border rounded-lg p-3 bg-muted/30 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex gap-4 text-xs">
                      <span>
                        <span className="text-muted-foreground">Date:</span>{" "}
                        {new Date(p.purchase_date).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                      <span>
                        <span className="text-muted-foreground">Units:</span>{" "}
                        <strong>{p.units}</strong>
                      </span>
                      <span>
                        <span className="text-muted-foreground">Unit Cost:</span>{" "}
                        ${p.unit_cost.toFixed(2)}
                      </span>
                      <span>
                        <span className="text-muted-foreground">Total:</span>{" "}
                        <strong>${p.total_cost.toFixed(2)}</strong>
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive"
                      onClick={() => deletePurchase(p.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder="Add a note..."
                      value={editingNote[p.id] ?? ""}
                      onChange={(e) =>
                        setEditingNote((prev) => ({
                          ...prev,
                          [p.id]: e.target.value,
                        }))
                      }
                      className="h-7 text-xs"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2"
                      disabled={savingNote === p.id}
                      onClick={() => saveNote(p.id)}
                    >
                      {savingNote === p.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Save className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
