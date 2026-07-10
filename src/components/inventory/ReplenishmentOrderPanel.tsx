import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Package, Plus, Trash2, ChevronDown, ChevronUp, Eye, Copy, ArrowUp, ArrowDown, Save, CheckCircle2, Circle } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  getListingUnitCost,
  getEffectiveUnitCost,
  isManualCostOverride,
  type InventoryOverrideRow,
} from "@/lib/cost-contract";
import { CostSourceBadge } from "@/components/inventory/CostSourceBadge";

interface ReplenishmentOrder {
  id: string;
  name: string;
  status: string;
  total_units: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface ReplenishmentOrderItem {
  id: string;
  asin: string;
  sku: string | null;
  title: string | null;
  image_url: string | null;
  quantity: number;
  unit_cost: number | null;
  supplier_link: string | null;
  created_at: string;
  /**
   * Phase 7: marks rows whose unit_cost was sourced from an inventory override
   * at the time of insert. Stored client-side only (DB column not added) so we
   * can flag overridden costs in the UI without a schema change.
   */
  cost_source?: "manual" | "purchase" | "unknown";
  manual_cost_reason?: string | null;
  manual_cost_updated_at?: string | null;
}

interface SelectedProduct {
  id: string;
  asin: string;
  sku: string;
  title: string;
  image_url: string | null;
  cost: number | null;
  units: number | null;
  amount: number | null;
  supplier_links: Array<{ link: string; discount_code: string }>;
}

interface ReplenishmentOrderPanelProps {
  userId: string;
  selectedProducts: SelectedProduct[];
  onClearSelection: () => void;
}

export function ReplenishmentOrderPanel({ userId, selectedProducts, onClearSelection }: ReplenishmentOrderPanelProps) {
  const [orders, setOrders] = useState<ReplenishmentOrder[]>([]);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [activeOrderItems, setActiveOrderItems] = useState<ReplenishmentOrderItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [viewOrderId, setViewOrderId] = useState<string | null>(null);
  const [viewItems, setViewItems] = useState<ReplenishmentOrderItem[]>([]);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [qtyDialogOpen, setQtyDialogOpen] = useState(false);
  const [pendingQuantities, setPendingQuantities] = useState<Record<string, number>>({});
  const [copyIndex, setCopyIndex] = useState<number>(-1);
  const [editedQuantities, setEditedQuantities] = useState<Record<string, number>>({});
  const [hasQtyChanges, setHasQtyChanges] = useState(false);
  const [searchAsin, setSearchAsin] = useState("");
  const [deleteOrderConfirmId, setDeleteOrderConfirmId] = useState<string | null>(null);
  const [deleteItemConfirmId, setDeleteItemConfirmId] = useState<string | null>(null);
  /**
   * Phase 7: per-ASIN cost-source map populated when an order is loaded.
   * Lets us render <CostSourceBadge> next to unit_cost without changing the
   * replenishment_order_items schema. Reflects the CURRENT inventory state,
   * not a snapshot — that matches how the rest of the app reads cost.
   */
  const [costOverridesByAsin, setCostOverridesByAsin] = useState<Map<string, InventoryOverrideRow>>(
    new Map(),
  );
  
  const [filterMonth, setFilterMonth] = useState(new Date().getMonth()); // 0-11
  const [filterYear, setFilterYear] = useState(new Date().getFullYear());

  const availableYears = Array.from(new Set(orders.map(o => new Date(o.created_at).getFullYear()))).sort((a, b) => b - a);
  if (!availableYears.includes(filterYear)) availableYears.unshift(filterYear);

  const filteredOrders = orders.filter((o) => {
    const d = new Date(o.created_at);
    return d.getMonth() === filterMonth && d.getFullYear() === filterYear;
  });

  const totalFilteredUnits = filteredOrders.reduce((sum, o) => sum + (o.total_units || 0), 0);

  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  useEffect(() => {
    fetchOrders();
  }, [userId]);

  useEffect(() => {
    if (activeOrderId) {
      fetchOrderItems(activeOrderId);
    }
  }, [activeOrderId]);

  const fetchOrders = async () => {
    const { data, error } = await supabase
      .from("replenishment_orders")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (!error && data) setOrders(data);
  };

  const fetchOrderItems = async (orderId: string) => {
    const { data, error } = await supabase
      .from("replenishment_order_items")
      .select("*")
      .eq("replenishment_order_id", orderId)
      .order("created_at", { ascending: false });
    if (!error && data) {
      setActiveOrderItems(data);
      void loadCostOverrides(data.map((d: any) => d.asin));
    }
  };

  /**
   * Phase 7: load current inventory cost-source flags for the given ASINs.
   * We always read live (no caching) so a freshly-set override or revert is
   * reflected the next time the order is opened.
   */
  const loadCostOverrides = useCallback(
    async (asins: string[]) => {
      const unique = Array.from(new Set(asins.filter(Boolean)));
      if (unique.length === 0) {
        setCostOverridesByAsin(new Map());
        return;
      }
      const { data } = await supabase
        .from("inventory")
        .select("asin, cost, amount, units, unit_cost_manual, manual_cost_updated_at, manual_cost_source, manual_cost_reason")
        .eq("user_id", userId)
        .in("asin", unique);
      const next = new Map<string, InventoryOverrideRow>();
      (data || []).forEach((row: any) => {
        if (row?.asin) next.set(row.asin, row as InventoryOverrideRow);
      });
      setCostOverridesByAsin(next);
    },
    [userId],
  );

  const createNewOrder = async () => {
    const name = new Date().toLocaleString("en-US", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const { data, error } = await supabase
      .from("replenishment_orders")
      .insert({ user_id: userId, name })
      .select()
      .single();
    if (error) {
      toast.error("Failed to create replenishment order");
      return;
    }
    toast.success(`Replenishment order created: ${name}`);
    setActiveOrderId(data.id);
    setActiveOrderItems([]);
    setExpanded(true);
    fetchOrders();
  };

  const openQtyDialog = () => {
    if (!activeOrderId) {
      toast.error("Create or select a replenishment order first");
      return;
    }
    if (selectedProducts.length === 0) {
      toast.error("No products selected");
      return;
    }
    const initial: Record<string, number> = {};
    selectedProducts.forEach((p) => { initial[p.id] = 1; });
    setPendingQuantities(initial);
    setQtyDialogOpen(true);
  };

  const confirmAddToOrder = async () => {
    if (!activeOrderId) return;
    setLoading(true);
    setQtyDialogOpen(false);
    try {
      // Check for duplicate ASINs in the current order
      const { data: existingItems } = await supabase
        .from("replenishment_order_items")
        .select("asin")
        .eq("replenishment_order_id", activeOrderId);

      const existingAsins = new Set((existingItems || []).map((i) => i.asin));
      const duplicates = selectedProducts.filter((p) => existingAsins.has(p.asin));
      const newProducts = selectedProducts.filter((p) => !existingAsins.has(p.asin));

      if (duplicates.length > 0) {
        const dupeList = duplicates.map((p) => p.asin).join(", ");
        toast.error(`Already in this replenishment: ${dupeList}`);
      }

      if (newProducts.length === 0) {
        setLoading(false);
        return;
      }

      // Phase 7: pull effective unit costs from inventory so any operational
      // override (unit_cost_manual = true) is reflected in the reorder cost.
      // created_listings carries the historical purchase truth; inventory.cost
      // is the single effective unit cost the rest of the app honors.
      const asins = Array.from(new Set(newProducts.map((p) => p.asin).filter(Boolean)));
      const overrideByAsin = new Map<string, InventoryOverrideRow>();
      if (asins.length > 0) {
        const { data: invRows } = await supabase
          .from("inventory")
          .select("asin, cost, amount, units, unit_cost_manual, manual_cost_updated_at, manual_cost_source, manual_cost_reason")
          .eq("user_id", userId)
          .in("asin", asins);
        (invRows || []).forEach((row: any) => {
          if (row?.asin) overrideByAsin.set(row.asin, row as InventoryOverrideRow);
        });
      }

      const items = newProducts.map((p) => {
        const invRow = overrideByAsin.get(p.asin);
        const effective = invRow ? getEffectiveUnitCost(invRow) : null;
        const fallback = getListingUnitCost({ cost: p.cost, units: p.units, amount: p.amount });
        const unitCost = effective !== null ? effective : fallback;
        return {
          replenishment_order_id: activeOrderId,
          user_id: userId,
          listing_id: p.id,
          asin: p.asin,
          sku: p.sku || null,
          title: p.title || null,
          image_url: p.image_url || null,
          quantity: pendingQuantities[p.id] || 1,
          unit_cost: unitCost,
          supplier_link: p.supplier_links?.[0]?.link || null,
        };
      });

      const { error } = await supabase
        .from("replenishment_order_items")
        .insert(items);

      if (error) throw error;

      const { data: countData } = await supabase
        .from("replenishment_order_items")
        .select("quantity")
        .eq("replenishment_order_id", activeOrderId);

      const totalUnits = countData?.reduce((sum, i) => sum + (i.quantity || 0), 0) || 0;
      await supabase
        .from("replenishment_orders")
        .update({ total_units: totalUnits })
        .eq("id", activeOrderId);

      toast.success(`Added ${newProducts.length} product(s) to replenishment`);
      onClearSelection();
      fetchOrderItems(activeOrderId);
      fetchOrders();
    } catch (err: any) {
      toast.error(err.message || "Failed to add products");
    } finally {
      setLoading(false);
    }
  };

  const removeItem = async (itemId: string) => {
    const { error } = await supabase
      .from("replenishment_order_items")
      .delete()
      .eq("id", itemId);
    if (!error && activeOrderId) {
      fetchOrderItems(activeOrderId);
      fetchOrders();
    }
  };

  const updateItemQuantity = async (itemId: string, quantity: number) => {
    if (quantity < 1) return;
    await supabase
      .from("replenishment_order_items")
      .update({ quantity })
      .eq("id", itemId);
    if (activeOrderId) fetchOrderItems(activeOrderId);
  };

  const deleteOrder = async (orderId: string) => {
    setDeleteOrderConfirmId(orderId);
  };

  const confirmDeleteOrder = async () => {
    if (!deleteOrderConfirmId) return;
    const { error } = await supabase
      .from("replenishment_orders")
      .delete()
      .eq("id", deleteOrderConfirmId);
    if (!error) {
      if (activeOrderId === deleteOrderConfirmId) {
        setActiveOrderId(null);
        setActiveOrderItems([]);
      }
      fetchOrders();
      toast.success("Replenishment order deleted");
    }
    setDeleteOrderConfirmId(null);
  };

  const replenishOrder = async (orderId: string) => {
    // Fetch all items from the source order
    const { data: sourceItems } = await supabase
      .from("replenishment_order_items")
      .select("*")
      .eq("replenishment_order_id", orderId);

    if (!sourceItems || sourceItems.length === 0) {
      toast.error("No items in this order to replenish");
      return;
    }

    // Create a new order
    const name = new Date().toLocaleString("en-US", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const { data: newOrder, error: createError } = await supabase
      .from("replenishment_orders")
      .insert({ user_id: userId, name })
      .select()
      .single();

    if (createError || !newOrder) {
      toast.error("Failed to create new replenishment order");
      return;
    }

    // Copy all items to the new order
    const newItems = sourceItems.map((item) => ({
      replenishment_order_id: newOrder.id,
      user_id: userId,
      listing_id: (item as any).listing_id || null,
      asin: item.asin,
      sku: item.sku || null,
      title: item.title || null,
      image_url: item.image_url || null,
      quantity: item.quantity,
      unit_cost: item.unit_cost || null,
      supplier_link: item.supplier_link || null,
    }));

    const { error: insertError } = await supabase
      .from("replenishment_order_items")
      .insert(newItems);

    if (insertError) {
      toast.error("Failed to copy items to new order");
      return;
    }

    // Update total units
    const totalUnits = newItems.reduce((sum, i) => sum + (i.quantity || 0), 0);
    await supabase
      .from("replenishment_orders")
      .update({ total_units: totalUnits })
      .eq("id", newOrder.id);

    toast.success(`Replenished! New order created with ${sourceItems.length} item(s)`);
    setActiveOrderId(newOrder.id);
    fetchOrders();
    fetchOrderItems(newOrder.id);
  };

  const viewOrder = async (orderId: string) => {
    const { data } = await supabase
      .from("replenishment_order_items")
      .select("*")
      .eq("replenishment_order_id", orderId)
      .order("created_at", { ascending: true });
    const items = data || [];
    setViewItems(items);
    setViewOrderId(orderId);
    setCopyIndex(-1);
    const qtyMap: Record<string, number> = {};
    items.forEach((i) => { qtyMap[i.id] = i.quantity; });
    setEditedQuantities(qtyMap);
    setHasQtyChanges(false);
    void loadCostOverrides(items.map((i: any) => i.asin));
    
    setViewDialogOpen(true);
  };

  const saveQuantityChanges = async () => {
    const updates = Object.entries(editedQuantities).filter(
      ([id, qty]) => viewItems.find((i) => i.id === id)?.quantity !== qty
    );
    if (updates.length === 0) return;
    for (const [id, qty] of updates) {
      await supabase.from("replenishment_order_items").update({ quantity: qty }).eq("id", id);
    }
    setViewItems((prev) => prev.map((i) => ({ ...i, quantity: editedQuantities[i.id] ?? i.quantity })));
    setHasQtyChanges(false);
    fetchOrders();
    if (activeOrderId === viewOrderId) fetchOrderItems(activeOrderId);
    toast.success("Quantities saved");
  };

  const copyNextAsin = () => {
    const nextIndex = copyIndex + 1;
    if (nextIndex >= viewItems.length) {
      toast.info("All ASINs copied!");
      return;
    }
    navigator.clipboard.writeText(viewItems[nextIndex].asin);
    setCopyIndex(nextIndex);
    toast.success(`Copied ${viewItems[nextIndex].asin} (${nextIndex + 1}/${viewItems.length})`);
  };

  const navigateHighlight = useCallback((direction: "up" | "down") => {
    if (viewItems.length === 0) return;
    setCopyIndex((prev) => {
      if (prev < 0) return 0;
      if (direction === "down") return Math.min(prev + 1, viewItems.length - 1);
      return Math.max(prev - 1, 0);
    });
  }, [viewItems.length]);

  useEffect(() => {
    if (!viewDialogOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); navigateHighlight("down"); }
      if (e.key === "ArrowUp") { e.preventDefault(); navigateHighlight("up"); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [viewDialogOpen, navigateHighlight]);

  const activeOrder = orders.find((o) => o.id === activeOrderId);

  return (
    <Card className="p-3 mb-4 bg-gradient-to-r from-emerald-500/10 to-teal-500/10 border-2 border-emerald-500/30">
      <div className="flex items-center justify-between cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center gap-2">
          <Package className="w-5 h-5 text-emerald-600" />
          <h3 className="text-sm font-bold text-emerald-900">Replenishment Orders</h3>
          {activeOrder && (
            <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-medium">
              Active: {activeOrder.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </div>
      </div>

      {expanded && (
        <div className="mt-3 min-h-[640px] space-y-3 flex flex-col">
          {/* Order List */}
          <div className="space-y-3">
            <div>
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <h4 className="text-xs font-semibold text-muted-foreground">All Orders</h4>
                <Select value={String(filterMonth)} onValueChange={(v) => setFilterMonth(Number(v))}>
                  <SelectTrigger className="h-6 w-[110px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {monthNames.map((m, i) => (
                      <SelectItem key={i} value={String(i)} className="text-xs">{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={String(filterYear)} onValueChange={(v) => setFilterYear(Number(v))}>
                  <SelectTrigger className="h-6 w-[80px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableYears.map((y) => (
                      <SelectItem key={y} value={String(y)} className="text-xs">{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs font-semibold text-emerald-700 ml-auto">
                  Total: {totalFilteredUnits} units • {filteredOrders.length} replenishments
                </span>
              </div>
              <div className="space-y-1 max-h-72 overflow-y-auto">
                {filteredOrders.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2">No orders for {monthNames[filterMonth]} {filterYear}.</p>
                ) : (
                  filteredOrders.map((order) => (
                    <div
                      key={order.id}
                      className={`flex items-center justify-between px-2 py-1.5 rounded text-xs cursor-pointer transition-colors ${
                        order.id === activeOrderId
                          ? "bg-emerald-100 border border-emerald-300"
                          : "bg-white/50 hover:bg-white/80 border border-transparent"
                      }`}
                      onClick={() => setActiveOrderId(order.id)}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{order.name}</div>
                        <div className="text-muted-foreground">{order.total_units} units • {order.status}</div>
                      </div>
                      <div className="flex items-center gap-1 ml-2">
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={(e) => { e.stopPropagation(); viewOrder(order.id); }} title="View">
                          <Eye className="h-3 w-3" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive" onClick={(e) => { e.stopPropagation(); deleteOrder(order.id); }} title="Delete">
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Active Order Items */}
            <div className="flex-1 min-h-[260px]">
              <h4 className="text-xs font-semibold mb-1 text-muted-foreground">
                {activeOrder ? `Items in "${activeOrder.name}"` : "Select an order"}
              </h4>
              {activeOrderId ? (
                <div className="space-y-1 max-h-72 overflow-y-auto">
                  {activeOrderItems.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2">No items yet. Select products from the table and click "Add to Replenishment".</p>
                  ) : (
                    activeOrderItems.map((item) => (
                      <div key={item.id} className="flex items-center gap-2 px-2 py-1 bg-white/50 rounded text-xs">
                        {item.image_url && (
                          <img src={item.image_url} alt="" className="w-8 h-8 object-cover rounded" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="truncate font-medium">{item.asin}</div>
                          <div className="truncate text-muted-foreground">{item.title || "—"}</div>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-muted-foreground">Qty:</span>
                          <Input
                            type="number"
                            min={1}
                            value={item.quantity}
                            onChange={(e) => updateItemQuantity(item.id, parseInt(e.target.value) || 1)}
                            className="w-14 h-6 text-xs text-center"
                          />
                        </div>
                        {item.unit_cost && (
                          <span className="flex items-center gap-1 text-muted-foreground">
                            ${item.unit_cost.toFixed(2)}
                            {costOverridesByAsin.get(item.asin) && (
                              <CostSourceBadge row={costOverridesByAsin.get(item.asin)!} compact />
                            )}
                          </span>
                        )}
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive" onClick={() => removeItem(item.id)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="min-h-[220px] rounded border border-border/50 border-dashed bg-background/30 px-3 py-4 text-xs text-muted-foreground">
                  Click an order on the left to view its items.
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 mt-2">
            {activeOrderId ? (
              <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setActiveOrderId(null); setActiveOrderItems([]); toast.success("Order closed. Press ADD to create a new one."); }} className="gap-1 text-xs font-semibold border-emerald-500 text-emerald-700 hover:bg-emerald-50">
                ✓ Done
              </Button>
            ) : (
              <Button size="sm" onClick={(e) => { e.stopPropagation(); createNewOrder(); }} className="gap-1 text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-semibold">
                <Plus className="h-3 w-3" /> ADD
              </Button>
            )}
            <Button
              size="sm"
              onClick={(e) => { e.stopPropagation(); openQtyDialog(); }}
              disabled={loading || selectedProducts.length === 0 || !activeOrderId}
              className="gap-1 text-xs flex-1 bg-emerald-600 hover:bg-emerald-700"
            >
              <Package className="h-3 w-3" />
              Add {selectedProducts.length || 0} to Replenishment
            </Button>
          </div>
        </div>
      )}

      {/* View Order Dialog */}
      <Dialog open={viewDialogOpen} onOpenChange={setViewDialogOpen}>
        <DialogContent className="max-w-4xl w-[90vw] max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <DialogTitle>Replenishment Order Details</DialogTitle>
              <div className="flex items-center gap-1">
                <Input
                  placeholder="Search ASIN..."
                  value={searchAsin}
                  onChange={(e) => setSearchAsin(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && searchAsin.trim()) {
                      const idx = viewItems.findIndex((i) => i.asin.toLowerCase().includes(searchAsin.trim().toLowerCase()));
                      if (idx >= 0) {
                        setCopyIndex(idx);
                        setSearchAsin("");
                      } else {
                        toast.error("ASIN not found in this order");
                      }
                    }
                  }}
                  className="w-36 h-8 text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigateHighlight("up")}
                  disabled={viewItems.length === 0 || copyIndex <= 0}
                  className="h-8 w-8 p-0"
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigateHighlight("down")}
                  disabled={viewItems.length === 0 || copyIndex >= viewItems.length - 1}
                  className="h-8 w-8 p-0"
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <span className="text-xs text-muted-foreground mx-1">
                  {copyIndex >= 0 ? `${copyIndex + 1}/${viewItems.length}` : `0/${viewItems.length}`}
                </span>
                <Button
                  size="sm"
                  onClick={copyNextAsin}
                  disabled={viewItems.length === 0}
                  className="gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <Copy className="h-3 w-3" />
                  Copy ASIN
                </Button>
                {copyIndex > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setCopyIndex(-1)}
                    className="text-xs"
                  >
                    Reset
                  </Button>
                )}
              </div>
            </div>
          </DialogHeader>

          {/* Large preview of highlighted item — fixed size always */}
          <div className="flex items-center gap-4 p-4 rounded-lg bg-emerald-50 border-2 border-emerald-300 h-40">
            {copyIndex >= 0 && copyIndex < viewItems.length ? (
              <>
                {viewItems[copyIndex].image_url ? (
                  <img
                    src={viewItems[copyIndex].image_url}
                    alt=""
                    className="w-32 h-32 object-contain rounded-lg border bg-white"
                  />
                ) : (
                  <div className="w-32 h-32 flex items-center justify-center bg-muted rounded-lg text-muted-foreground text-xs">No Image</div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-lg font-bold leading-snug mb-1">{viewItems[copyIndex].title || "—"}</div>
                  <div className="text-sm font-mono text-muted-foreground">{viewItems[copyIndex].asin}</div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                Press "Copy ASIN" to start
              </div>
            )}
          </div>

          <div className="space-y-2">
            {viewItems.length === 0 ? (
              <p className="text-muted-foreground text-center py-4">No items in this order</p>
            ) : (
              <div className={viewItems.length > 10 ? "max-h-[400px] overflow-y-auto" : ""}>
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b">
                    <th className="text-center py-1 px-1 w-8">✓</th>
                    <th className="text-left py-1 px-2">Image</th>
                    <th className="text-left py-1 px-2">ASIN</th>
                    <th className="text-left py-1 px-2">SKU</th>
                    <th className="text-left py-1 px-2">Title</th>
                    <th className="text-right py-1 px-2">Qty</th>
                    <th className="text-right py-1 px-2">Unit Cost</th>
                    <th className="text-left py-1 px-2">Supplier</th>
                    <th className="text-center py-1 px-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {viewItems.map((item, idx) => (
                    <tr key={item.id} className={`border-b transition-colors ${idx === copyIndex ? "bg-emerald-100" : idx < copyIndex ? "bg-muted/40" : ""}`}>
                      <td className="py-1 px-1 text-center">
                        <button
                          onClick={async () => {
                            const newPacked = !(item as any).packed;
                            await supabase.from("replenishment_order_items").update({ packed: newPacked }).eq("id", item.id);
                            setViewItems(prev => prev.map(i => i.id === item.id ? { ...i, packed: newPacked } as any : i));
                          }}
                          className="focus:outline-none"
                        >
                          {(item as any).packed ? (
                            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                          ) : (
                            <Circle className="h-5 w-5 text-muted-foreground/40" />
                          )}
                        </button>
                      </td>
                      <td className="py-1 px-2">
                        {item.image_url ? <img src={item.image_url} alt="" className="w-8 h-8 object-cover rounded" /> : "—"}
                      </td>
                      <td className="py-1 px-2 font-mono">{item.asin}</td>
                      <td className="py-1 px-2">{item.sku || "—"}</td>
                      <td className="py-1 px-2 max-w-[200px] truncate">{item.title || "—"}</td>
                      <td className="py-1 px-2 text-right">
                        <Input
                          type="number"
                          min={1}
                          value={editedQuantities[item.id] ?? item.quantity}
                          onChange={(e) => {
                            const qty = Math.max(1, parseInt(e.target.value) || 1);
                            setEditedQuantities((prev) => ({ ...prev, [item.id]: qty }));
                            setHasQtyChanges(true);
                          }}
                          className="w-16 h-6 text-xs text-center inline-block"
                        />
                      </td>
                      <td className="py-1 px-2 text-right">
                        <span className="inline-flex items-center justify-end gap-1">
                          {item.unit_cost ? `$${Number(item.unit_cost).toFixed(2)}` : "—"}
                          {costOverridesByAsin.get(item.asin) && (
                            <CostSourceBadge row={costOverridesByAsin.get(item.asin)!} compact />
                          )}
                        </span>
                      </td>
                      <td className="py-1 px-2">
                        {item.supplier_link ? (
                          <a href={item.supplier_link} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Link</a>
                        ) : "—"}
                      </td>
                      <td className="py-1 px-2 text-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                          onClick={() => setDeleteItemConfirmId(item.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold border-t-2">
                    <td colSpan={5} className="py-1 px-2">Total ({viewItems.length} SKUs) — {viewItems.filter(i => (i as any).packed).length}/{viewItems.length} packed</td>
                    <td className="py-1 px-2 text-right">{viewItems.reduce((s, i) => s + i.quantity, 0)}</td>
                    <td className="py-1 px-2 text-right">
                      ${viewItems.reduce((s, i) => s + (Number(i.unit_cost) || 0) * i.quantity, 0).toFixed(2)}
                    </td>
                    <td></td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
              </div>
            )}
          </div>
          {hasQtyChanges && (
            <div className="flex justify-end pt-2">
              <Button
                size="sm"
                onClick={saveQuantityChanges}
                className="gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                <Save className="h-3 w-3" />
                Save Changes
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Quantity Selection Dialog */}
      <Dialog open={qtyDialogOpen} onOpenChange={setQtyDialogOpen}>
        <DialogContent className="max-w-3xl w-[85vw] max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Set Quantities for Replenishment</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {selectedProducts.map((p) => (
              <div key={p.id} className="flex items-center gap-3 py-2 border-b last:border-0">
                {p.image_url && (
                  <img src={p.image_url} alt="" className="w-10 h-10 object-cover rounded" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{p.title || p.asin}</div>
                  <div className="text-xs text-muted-foreground">{p.asin} • {p.sku}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Units:</span>
                  <Input
                    type="number"
                    min={1}
                    value={pendingQuantities[p.id] || 1}
                    onChange={(e) =>
                      setPendingQuantities((prev) => ({
                        ...prev,
                        [p.id]: Math.max(1, parseInt(e.target.value) || 1),
                      }))
                    }
                    className="w-20 h-8 text-sm text-center"
                  />
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setQtyDialogOpen(false)}>Cancel</Button>
            <Button onClick={confirmAddToOrder} disabled={loading} className="gap-1 bg-emerald-600 hover:bg-emerald-700">
              <Package className="h-4 w-4" />
              Add to Replenishment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Order Confirmation Dialog */}
      <Dialog open={!!deleteOrderConfirmId} onOpenChange={(open) => { if (!open) setDeleteOrderConfirmId(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" /> Delete Replenishment Order
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Are you sure you want to delete this replenishment order and all its items? This action cannot be undone.</p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteOrderConfirmId(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDeleteOrder}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Item Confirmation Dialog */}
      <Dialog open={!!deleteItemConfirmId} onOpenChange={(open) => { if (!open) setDeleteItemConfirmId(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" /> Remove Item
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Are you sure you want to remove this item from the order?</p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteItemConfirmId(null)}>Cancel</Button>
            <Button variant="destructive" onClick={async () => {
              if (!deleteItemConfirmId) return;
              await supabase.from("replenishment_order_items").delete().eq("id", deleteItemConfirmId);
              const updated = viewItems.filter((i) => i.id !== deleteItemConfirmId);
              setViewItems(updated);
              if (copyIndex >= updated.length) setCopyIndex(Math.max(updated.length - 1, -1));
              fetchOrders();
              if (activeOrderId === viewOrderId) fetchOrderItems(activeOrderId);
              toast.success("Item removed");
              setDeleteItemConfirmId(null);
            }}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
