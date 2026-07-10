import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Trash2, ExternalLink, Copy } from "lucide-react";
import { toast } from "sonner";
import { getListingUnitCost } from "@/lib/cost-contract";

interface SupplierLink {
  link: string;
  discount_code: string;
}

interface EditListingItem {
  id: string;
  asin: string;
  title: string;
  image_url: string | null;
  cost: number | null;
  units: number | null;
  amount: number | null;
  supplier_links: SupplierLink[];
}

interface EditListingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: EditListingItem | null;
  onSave: (data: {
    id: string;
    totalCost: number;
    units: number;
    cog: number;
    suppliers: SupplierLink[];
  }) => Promise<void>;
}

export function EditListingDialog({ open, onOpenChange, item, onSave }: EditListingDialogProps) {
  const [totalCost, setTotalCost] = useState("");
  const [units, setUnits] = useState("");
  const [cog, setCog] = useState("");
  const [suppliers, setSuppliers] = useState<SupplierLink[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (item && open) {
      setTotalCost(item.cost?.toString() || "");
      setUnits(item.units?.toString() || "");
      // Contract A: created_listings.amount = UNIT, cost = TOTAL — derive via helper.
      const unitCost = getListingUnitCost(item);
      setCog(unitCost != null ? String(unitCost) : "");
      setSuppliers(
        item.supplier_links.length > 0
          ? item.supplier_links.map(s => ({ ...s }))
          : [{ link: "", discount_code: "" }]
      );
    }
  }, [item, open]);

  // Recalculate COG when totalCost or units change
  const handleTotalCostChange = (val: string) => {
    setTotalCost(val);
    const tc = parseFloat(val);
    const u = parseInt(units);
    if (!isNaN(tc) && !isNaN(u) && u > 0) {
      setCog((tc / u).toFixed(2));
    }
  };

  const handleUnitsChange = (val: string) => {
    setUnits(val);
    const tc = parseFloat(totalCost);
    const u = parseInt(val);
    if (!isNaN(tc) && !isNaN(u) && u > 0) {
      setCog((tc / u).toFixed(2));
    }
  };

  const handleCogChange = (val: string) => {
    setCog(val);
    const c = parseFloat(val);
    const u = parseInt(units);
    if (!isNaN(c) && !isNaN(u) && u > 0) {
      setTotalCost((c * u).toFixed(2));
    }
  };

  const normalizeSupplierUrl = (url: string) => {
    const trimmed = url.trim();
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  };

  const openSupplierLink = (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) {
      toast.error("No supplier link to open");
      return;
    }

    const opened = window.open(normalizeSupplierUrl(trimmed), "_blank", "noopener,noreferrer");
    if (!opened) {
      toast.error("Browser blocked this tab. Allow pop-ups for this site, then try again.");
    }
  };

  const handleSave = async () => {
    if (!item) return;
    const tc = parseFloat(totalCost);
    const u = parseInt(units);
    const c = parseFloat(cog);
    if (isNaN(tc) || tc < 0) { toast.error("Invalid total cost"); return; }
    if (isNaN(u) || u <= 0) { toast.error("Invalid units"); return; }
    if (isNaN(c) || c < 0) { toast.error("Invalid COG"); return; }

    setSaving(true);
    try {
      await onSave({
        id: item.id,
        totalCost: tc,
        units: u,
        cog: c,
        suppliers: suppliers.filter(s => s.link.trim() !== ""),
      });
      onOpenChange(false);
    } catch {
      // error handled by parent
    } finally {
      setSaving(false);
    }
  };

  if (!item) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-base">Edit Listing</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* ASIN - Read Only */}
          <div className="flex items-center gap-2">
            {item.image_url && (
              <img src={item.image_url} alt="" className="w-10 h-10 rounded object-cover" />
            )}
            <div className="flex-1">
              <label className="text-xs font-semibold text-muted-foreground">ASIN (read-only)</label>
              <div className="flex items-center gap-1">
                <span className="font-mono text-sm">{item.asin}</span>
                <button
                  onClick={() => { navigator.clipboard.writeText(item.asin); toast.success("Copied"); }}
                  className="p-0.5 rounded hover:bg-muted"
                >
                  <Copy className="w-3 h-3" />
                </button>
              </div>
              <p className="text-xs text-muted-foreground truncate max-w-[400px]">{item.title}</p>
            </div>
          </div>

          {/* Total Cost / Units / COG row */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Total Cost ($)</label>
              <Input
                value={totalCost}
                onChange={(e) => handleTotalCostChange(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="h-9"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">Units</label>
              <Input
                value={units}
                onChange={(e) => handleUnitsChange(e.target.value)}
                inputMode="numeric"
                placeholder="1"
                className="h-9"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted-foreground">COG ($)</label>
              <Input
                value={cog}
                onChange={(e) => handleCogChange(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="h-9"
              />
            </div>
          </div>

          {/* Supplier Links */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-muted-foreground">Supplier Links & Discounts</label>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => setSuppliers([...suppliers, { link: "", discount_code: "" }])}>
                  <Plus className="w-3 h-3" /> Add
                </Button>
              </div>
            </div>
            <div className="space-y-2 max-h-[200px] overflow-y-auto">
              {suppliers.map((supplier, idx) => (
                <div key={idx} className="flex gap-2 items-start">
                  <div className="flex-1 space-y-1">
                    <div className="flex gap-2">
                      <Input
                        placeholder="Full supplier URL"
                        value={supplier.link}
                        onChange={(e) => {
                          const ns = [...suppliers];
                          ns[idx] = { ...ns[idx], link: e.target.value };
                          setSuppliers(ns);
                        }}
                        className="h-8 text-xs"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 shrink-0 gap-1 px-2 text-xs"
                        onClick={() => openSupplierLink(supplier.link)}
                        disabled={!supplier.link.trim()}
                      >
                        <ExternalLink className="w-3 h-3" /> Open
                      </Button>
                    </div>
                    <Input
                      placeholder="Discount code (optional)"
                      value={supplier.discount_code}
                      onChange={(e) => {
                        const ns = [...suppliers];
                        ns[idx] = { ...ns[idx], discount_code: e.target.value };
                        setSuppliers(ns);
                      }}
                      className="h-8 text-xs"
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 mt-0"
                    onClick={() => setSuppliers(suppliers.filter((_, i) => i !== idx))}
                    disabled={suppliers.length <= 1}
                  >
                    <Trash2 className="w-3 h-3 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
