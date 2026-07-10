import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { FileSpreadsheet, Search, DollarSign, Package, ExternalLink } from "lucide-react";
import * as XLSX from "xlsx";
import { ApplyToPurchaseButton } from "@/components/inventory/ApplyToPurchaseButton";

interface MissingValuationItem {
  id: string;
  asin: string;
  sku: string;
  title: string;
  totalQty: number;
  available: number;
  reserved: number;
  inbound: number;
  unitCost: number | null;
  costSource: string;
  price: number | null;
}

interface MissingValuationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: MissingValuationItem[];
  onCostSaved?: () => void;
}

export function MissingValuationDialog({
  open,
  onOpenChange,
  items,
  onCostSaved,
}: MissingValuationDialogProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  // Optimistic local overrides so saved costs reflect immediately, even before parent refresh
  const [savedCosts, setSavedCosts] = useState<Record<string, number>>({});

  const filteredItems = items.filter(
    (item) =>
      item.asin.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.sku.toLowerCase().includes(searchTerm.toLowerCase()) ||
      item.title.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const totalMissingUnits = items.reduce((sum, item) => sum + item.totalQty, 0);
  const totalEstimatedMissing = items.reduce((sum, item) => {
    // Estimate missing value using price as proxy for cost (rough estimate)
    const estimatedCost = item.price ? item.price * 0.4 : 5; // 40% of price or $5 default
    return sum + item.totalQty * estimatedCost;
  }, 0);

  const handleSaveCost = async (item: MissingValuationItem) => {
    const newCost = parseFloat(editValue);
    if (isNaN(newCost) || newCost < 0) {
      toast({
        variant: "destructive",
        title: "Invalid cost",
        description: "Please enter a valid positive number.",
      });
      return;
    }

    setSaving(true);
    try {
      const nowIso = new Date().toISOString();

      // Phase 7+ — classify source so the badge shows
      // "Manual / No Purchase Record" for new sellers without a Created Listing.
      let manualSource: 'user' | 'manual_no_purchase_record' = 'user';
      try {
        const { count } = await supabase
          .from('created_listings')
          .select('id', { count: 'exact', head: true })
          .eq('asin', item.asin);
        if ((count ?? 0) === 0) manualSource = 'manual_no_purchase_record';
      } catch {
        /* non-fatal — fall back to 'user' */
      }

      const { error } = await supabase
        .from("inventory")
        .update({
          cost: newCost,
          unit_cost_manual: true,
          manual_cost_updated_at: nowIso,
          manual_cost_source: manualSource,
          updated_at: nowIso,
        })
        .eq("id", item.id);

      if (error) throw error;

      toast({
        title: "Cost saved",
        description: `Unit cost for ${item.sku} set to $${newCost.toFixed(2)}`,
      });

      setSavedCosts((prev) => ({ ...prev, [item.id]: newCost }));
      setEditingId(null);
      setEditValue("");
      onCostSaved?.();
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Failed to save cost",
        description: error.message,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleExportToExcel = () => {
    if (items.length === 0) {
      toast({
        variant: "destructive",
        title: "No items to export",
      });
      return;
    }

    const exportData = items.map((item) => ({
      ASIN: item.asin,
      SKU: item.sku,
      Title: item.title,
      "Total Qty": item.totalQty,
      Available: item.available,
      Reserved: item.reserved,
      Inbound: item.inbound,
      "Unit Cost": item.unitCost ?? "",
      "Cost Source": item.costSource,
      "Current Price": item.price ?? "",
      "Amazon Link": `https://amazon.com/dp/${item.asin}`,
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Missing Valuation");
    XLSX.writeFile(wb, `missing-valuation-${new Date().toISOString().split("T")[0]}.xlsx`);

    toast({
      title: "Exported successfully",
      description: `${items.length} items exported to Excel`,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <DollarSign className="h-5 w-5 text-amber-500" />
            Missing Valuation Report
          </DialogTitle>
        </DialogHeader>

        {/* Summary Stats */}
        <div className="flex items-center gap-4 p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-amber-600" />
            <span className="text-sm font-medium">
              {items.length} SKUs with {totalMissingUnits.toLocaleString()} units
            </span>
          </div>
          <div className="text-sm text-muted-foreground">
            Estimated missing value: <span className="font-bold text-amber-600">${totalEstimatedMissing.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>
        </div>

        {/* Search and Export */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by ASIN, SKU, or title..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            onClick={handleExportToExcel}
            variant="outline"
            size="sm"
            className="gap-2 border-emerald-500/30 hover:bg-emerald-500/10"
          >
            <FileSpreadsheet className="h-4 w-4" />
            Export CSV
          </Button>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 sticky top-0">
              <tr>
                <th className="text-left p-2 font-medium">ASIN / SKU</th>
                <th className="text-left p-2 font-medium">Title</th>
                <th className="text-right p-2 font-medium">Qty</th>
                <th className="text-right p-2 font-medium">Price</th>
                <th className="text-right p-2 font-medium">Unit Cost</th>
                <th className="text-center p-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item) => (
                <tr key={item.id} className="border-t hover:bg-muted/30">
                  <td className="p-2">
                    <div className="flex flex-col">
                      <a
                        href={`https://amazon.com/dp/${item.asin}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline font-mono text-xs flex items-center gap-1"
                      >
                        {item.asin}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                      <span className="text-xs text-muted-foreground font-mono">{item.sku}</span>
                    </div>
                  </td>
                  <td className="p-2">
                    <span className="text-xs line-clamp-2">{item.title}</span>
                  </td>
                  <td className="p-2 text-right">
                    <div className="flex flex-col items-end">
                      <span className="font-bold">{item.totalQty}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {item.available}A / {item.reserved}R / {item.inbound}I
                      </span>
                    </div>
                  </td>
                  <td className="p-2 text-right">
                    {item.price ? (
                      <span className="font-mono">${item.price.toFixed(2)}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="p-2 text-right">
                    {editingId === item.id ? (
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex items-center gap-1 justify-end">
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="w-20 h-7 text-xs"
                            autoFocus
                          />
                          <Button
                            size="sm"
                            className="h-7 px-2"
                            onClick={() => handleSaveCost(item)}
                            disabled={saving}
                          >
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            onClick={() => {
                              setEditingId(null);
                              setEditValue("");
                            }}
                          >
                            ✕
                          </Button>
                        </div>
                        {parseFloat(editValue) > 0 && (
                          <ApplyToPurchaseButton
                            asin={item.asin}
                            unitCost={parseFloat(editValue)}
                            inventoryId={item.id}
                            size="sm"
                            variant="ghost"
                            className="h-6 px-1 text-[10px]"
                            onApplied={onCostSaved}
                          />
                        )}
                      </div>
                    ) : (
                      (() => {
                        const displayCost = savedCosts[item.id] ?? item.unitCost ?? 0;
                        return displayCost > 0 ? (
                          <span className="text-emerald-500 font-medium">${displayCost.toFixed(2)}</span>
                        ) : (
                          <span className="text-amber-600 font-medium">$0.00</span>
                        );
                      })()
                    )}
                  </td>
                  <td className="p-2 text-center">
                    {editingId !== item.id && (() => {
                      const displayCost = savedCosts[item.id] ?? item.unitCost ?? 0;
                      return (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => {
                            setEditingId(item.id);
                            setEditValue(displayCost > 0 ? displayCost.toFixed(2) : "");
                          }}
                        >
                          {displayCost > 0 ? "Update" : "Set Cost"}
                        </Button>
                      );
                    })()}
                  </td>
                </tr>
              ))}
              {filteredItems.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-muted-foreground">
                    {items.length === 0
                      ? "No items with missing valuation found. Great job!"
                      : "No items match your search."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="text-xs text-muted-foreground pt-2">
          Items shown have quantity &gt; 0 but unit cost is $0 or missing. Add costs via Created Listings for permanent storage.
        </div>
      </DialogContent>
    </Dialog>
  );
}
