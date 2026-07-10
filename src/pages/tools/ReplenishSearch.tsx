import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Package, TrendingUp, ShoppingCart, Warehouse, AlertTriangle, CalendarIcon, RefreshCw, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { toast } from "sonner";
import { format, subDays } from "date-fns";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type ShipmentItem = {
  id: string;
  shipment_id: string;
  asin: string;
  seller_sku: string;
  title: string | null;
  quantity_shipped: number | null;
  quantity_received: number | null;
  fnsku: string | null;
  image_url: string | null;
  shipment_name?: string;
  shipment_status?: string;
};

type InventoryData = {
  available: number;
  inbound: number;
  reserved: number;
  unfulfilled: number;
};

type SalesData = {
  totalSold: number;
  periodDays: number;
};

export default function ReplenishSearch() {
  const { user } = useAuth();
  const [asin, setAsin] = useState("");
  const [shipmentId, setShipmentId] = useState("");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [results, setResults] = useState<ShipmentItem[]>([]);
  const [salesData, setSalesData] = useState<SalesData | null>(null);
  const [inventoryData, setInventoryData] = useState<InventoryData | null>(null);
  const [searched, setSearched] = useState(false);
  const [sortColumn, setSortColumn] = useState<"shipped" | "received">("shipped");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  // Date range state - default to last 30 days
  const [startDate, setStartDate] = useState<Date>(subDays(new Date(), 30));
  const [endDate, setEndDate] = useState<Date>(new Date());

  const handleSearch = async () => {
    if (!user) {
      toast.error("Please sign in to search");
      return;
    }

    const trimmedAsin = asin.trim().toUpperCase();
    if (!trimmedAsin) {
      toast.error("Please enter an ASIN");
      return;
    }

    setLoading(true);
    setSearched(true);

    try {
      // First get inventory to find the SKU for this ASIN (and get title/image for fallback)
      const inventoryResult = await supabase
        .from("inventory")
        .select("sku, available, inbound, reserved, unfulfilled, title, image_url, asin")
        .eq("user_id", user.id)
        .eq("asin", trimmedAsin)
        .maybeSingle();

      const sku = inventoryResult.data?.sku;
      const inventoryTitle = inventoryResult.data?.title;
      const inventoryImage = inventoryResult.data?.image_url;
      const inventoryAsin = inventoryResult.data?.asin;

      // Query sales and shipments in parallel
      // For shipments, search by SKU (more reliable) OR by ASIN as fallback
      const [shipmentResult, salesResult] = await Promise.all([
        // FBA Shipment items - search by SKU if we have it, otherwise by ASIN
        sku 
          ? supabase
              .from("fba_shipment_items")
              .select(`id, shipment_id, asin, seller_sku, title, quantity_shipped, quantity_received, fnsku, image_url`)
              .eq("user_id", user.id)
              .eq("seller_sku", sku)
              .order("created_at", { ascending: false })
          : supabase
              .from("fba_shipment_items")
              .select(`id, shipment_id, asin, seller_sku, title, quantity_shipped, quantity_received, fnsku, image_url`)
              .eq("user_id", user.id)
              .eq("asin", trimmedAsin)
              .order("created_at", { ascending: false }),
        
        // Sales orders - filter by date range
        supabase
          .from("sales_orders")
          .select("quantity, order_date")
          .eq("user_id", user.id)
          .eq("asin", trimmedAsin)
          .gte("order_date", format(startDate, "yyyy-MM-dd"))
          .lte("order_date", format(endDate, "yyyy-MM-dd")),
      ]);

      if (shipmentResult.error) throw shipmentResult.error;

      // Process shipment items
      const items = shipmentResult.data || [];
      if (items.length > 0) {
        const shipmentIds = [...new Set(items.map(i => i.shipment_id))];
        const { data: shipments } = await supabase
          .from("fba_shipments")
          .select("shipment_id, shipment_name, shipment_status")
          .eq("user_id", user.id)
          .in("shipment_id", shipmentIds);

        const shipmentMap = new Map(shipments?.map(s => [s.shipment_id, s]) || []);

        // Enrich items with inventory data if missing
        const enrichedItems = items.map(item => ({
          ...item,
          // Use inventory data as fallback for missing fields
          title: item.title || inventoryTitle || null,
          image_url: item.image_url || inventoryImage || null,
          asin: item.asin || inventoryAsin || null,
          shipment_name: shipmentMap.get(item.shipment_id)?.shipment_name || item.shipment_id,
          shipment_status: shipmentMap.get(item.shipment_id)?.shipment_status || "Unknown",
        }));

        // Sort by quantity_shipped descending
        enrichedItems.sort((a, b) => (b.quantity_shipped || 0) - (a.quantity_shipped || 0));

        setResults(enrichedItems);
      } else {
        setResults([]);
      }

      // Process sales data
      if (salesResult.data && salesResult.data.length > 0) {
        let totalSold = 0;

        for (const order of salesResult.data) {
          totalSold += order.quantity || 0;
        }

        // Calculate period in days
        const periodDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));

        setSalesData({ totalSold, periodDays });
      } else {
        setSalesData(null);
      }

      // Process inventory data (already fetched above)
      if (inventoryResult.data) {
        setInventoryData({
          available: inventoryResult.data.available || 0,
          inbound: inventoryResult.data.inbound || 0,
          reserved: inventoryResult.data.reserved || 0,
          unfulfilled: inventoryResult.data.unfulfilled || 0,
        });
      } else {
        setInventoryData(null);
      }

    } catch (err) {
      console.error("Search error:", err);
      toast.error("Failed to search");
      setResults([]);
      setSalesData(null);
      setInventoryData(null);
    } finally {
      setLoading(false);
    }
  };

  const syncShipments = async (mode: "all" | "single" = "all") => {
    if (!user) {
      toast.error("Please sign in to sync");
      return;
    }

    const trimmedShipmentId = shipmentId.trim();
    if (mode === "single" && !trimmedShipmentId) {
      toast.error("Enter a Shipment ID (e.g., FBA...) first");
      return;
    }

    try {
      setSyncing(true);
      toast.info(mode === "single" ? "Syncing that shipment from Amazon..." : "Syncing shipments from Amazon...");

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error("Please log in first");
        return;
      }

      const response = await supabase.functions.invoke("sync-fba-shipments", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: mode === "single" ? { shipmentId: trimmedShipmentId } : undefined,
      });

      if (response.error) throw new Error(response.error.message);

      toast.success("Shipments synced. Refreshing results...");
      await handleSearch();
    } catch (error: any) {
      console.error("Error syncing shipments:", error);
      toast.error(error?.message || "Failed to sync shipments");
    } finally {
      setSyncing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  // Calculate totals
  const totalShipped = results.reduce((sum, item) => sum + (item.quantity_shipped || 0), 0);
  const totalReceived = results.reduce((sum, item) => sum + (item.quantity_received || 0), 0);
  const totalPending = totalShipped - totalReceived;

  // Sort results based on current sort state
  const sortedResults = [...results].sort((a, b) => {
    const aVal = sortColumn === "shipped" ? (a.quantity_shipped || 0) : (a.quantity_received || 0);
    const bVal = sortColumn === "shipped" ? (b.quantity_shipped || 0) : (b.quantity_received || 0);
    return sortDirection === "desc" ? bVal - aVal : aVal - bVal;
  });

  const handleSort = (column: "shipped" | "received") => {
    if (sortColumn === column) {
      setSortDirection(prev => prev === "desc" ? "asc" : "desc");
    } else {
      setSortColumn(column);
      setSortDirection("desc");
    }
  };

  const getSortIcon = (column: "shipped" | "received") => {
    if (sortColumn !== column) return <ArrowUpDown className="h-4 w-4 ml-1" />;
    return sortDirection === "desc" 
      ? <ArrowDown className="h-4 w-4 ml-1" /> 
      : <ArrowUp className="h-4 w-4 ml-1" />;
  };

  // Calculate replenishment metrics
  // Amazon "available" can include reserved units; for "days of stock" we want fulfillable + inbound.
  const fulfillableStock = inventoryData
    ? Math.max(0, (inventoryData.available || 0) - (inventoryData.reserved || 0) - (inventoryData.unfulfilled || 0))
    : 0;
  const currentStock = inventoryData ? (fulfillableStock + (inventoryData.inbound || 0)) : 0;

  // Always calculate period from selected dates, not from salesData
  const selectedPeriodDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
  const dailyVelocity = salesData && salesData.totalSold > 0 ? salesData.totalSold / selectedPeriodDays : 0;
  const daysOfStock = dailyVelocity > 0 ? Math.round(currentStock / dailyVelocity) : null;

  const getStatusBadge = (status: string) => {
    const statusLower = status?.toLowerCase() || "";
    if (statusLower.includes("closed") || statusLower.includes("received")) {
      return <Badge variant="default" className="bg-green-600">{status}</Badge>;
    } else if (statusLower.includes("working") || statusLower.includes("shipped")) {
      return <Badge variant="secondary">{status}</Badge>;
    } else if (statusLower.includes("cancelled") || statusLower.includes("deleted")) {
      return <Badge variant="destructive">{status}</Badge>;
    }
    return <Badge variant="outline">{status}</Badge>;
  };

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex items-center gap-3">
        <Package className="h-8 w-8 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Replenish Search</h1>
          <p className="text-muted-foreground">Search by ASIN to see shipments, sales, and inventory</p>
        </div>
      </div>

      {/* Search Input */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Search by ASIN</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[200px]">
              <label className="text-sm text-muted-foreground mb-1 block">ASIN</label>
              <Input
                placeholder="Enter ASIN (e.g., B0XXXXXXXXX)"
                value={asin}
                onChange={(e) => setAsin(e.target.value)}
                onKeyDown={handleKeyDown}
                className="font-mono"
              />
            </div>
            
            {/* Start Date */}
            <div>
              <label className="text-sm text-muted-foreground mb-1 block">Start Date</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-[140px] justify-start text-left font-normal")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(startDate, "MM/dd/yyyy")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={startDate}
                    onSelect={(date) => date && setStartDate(date)}
                    initialFocus
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>
            </div>
            
            {/* End Date */}
            <div>
              <label className="text-sm text-muted-foreground mb-1 block">End Date</label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-[140px] justify-start text-left font-normal")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(endDate, "MM/dd/yyyy")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={endDate}
                    onSelect={(date) => date && setEndDate(date)}
                    initialFocus
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="flex gap-2 flex-wrap">
              <Button variant="outline" onClick={() => syncShipments("all")} disabled={loading || syncing}>
                <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Syncing..." : "Sync Shipments"}
              </Button>

              <Button onClick={handleSearch} disabled={loading}>
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Search className="h-4 w-4 mr-2" />
                )}
                Search
              </Button>
            </div>

            <div className="flex flex-wrap gap-2 items-end">
              <div className="min-w-[240px]">
                <label className="text-sm text-muted-foreground mb-1 block">Shipment ID (optional)</label>
                <Input
                  placeholder="FBA..."
                  value={shipmentId}
                  onChange={(e) => setShipmentId(e.target.value)}
                  className="font-mono"
                />
              </div>
              <Button variant="secondary" onClick={() => syncShipments("single")} disabled={loading || syncing}>
                Sync This Shipment
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Sales Summary */}
      {searched && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <ShoppingCart className="h-5 w-5" />
            Sales Data ({format(startDate, "MM/dd/yyyy")} - {format(endDate, "MM/dd/yyyy")})
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Units Sold in Period</p>
                <p className="text-3xl font-bold text-primary">{salesData?.totalSold || 0}</p>
                <p className="text-xs text-muted-foreground">{selectedPeriodDays} days</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Daily Velocity</p>
                <p className="text-3xl font-bold text-green-600">{dailyVelocity.toFixed(1)}</p>
                <p className="text-xs text-muted-foreground">units/day avg</p>
              </CardContent>
            </Card>
            <Card className={daysOfStock !== null && daysOfStock < 14 ? "border-red-500 bg-red-50 dark:bg-red-950" : ""}>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground flex items-center gap-1">
                  Days of Stock
                  {daysOfStock !== null && daysOfStock < 14 && (
                    <AlertTriangle className="h-4 w-4 text-red-500" />
                  )}
                </p>
                <p className={`text-3xl font-bold ${daysOfStock !== null && daysOfStock < 14 ? 'text-red-600' : 'text-primary'}`}>
                  {daysOfStock !== null ? daysOfStock : '—'}
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Inventory Summary */}
      {searched && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Warehouse className="h-5 w-5" />
            Current Inventory
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Available</p>
                <p className="text-3xl font-bold text-green-600">{inventoryData?.available || 0}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Inbound</p>
                <p className="text-3xl font-bold text-blue-600">{inventoryData?.inbound || 0}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Reserved</p>
                <p className="text-3xl font-bold text-orange-500">{inventoryData?.reserved || 0}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Unfulfilled</p>
                <p className="text-3xl font-bold text-purple-600">{inventoryData?.unfulfilled || 0}</p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Shipments Summary */}
      {searched && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            FBA Shipments
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">Total Shipped</p>
                    <p className="text-3xl font-bold text-primary">{totalShipped}</p>
                  </div>
                  <TrendingUp className="h-8 w-8 text-primary opacity-50" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">Total Received</p>
                    <p className="text-3xl font-bold text-green-600">{totalReceived}</p>
                  </div>
                  <Package className="h-8 w-8 text-green-600 opacity-50" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">Pending</p>
                    <p className="text-3xl font-bold text-orange-500">{totalPending}</p>
                  </div>
                  <Loader2 className="h-8 w-8 text-orange-500 opacity-50" />
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Shipments Table */}
      {searched && results.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Shipment History ({results.length} shipments)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Image</TableHead>
                  <TableHead>Title / SKU</TableHead>
                  <TableHead>Shipment</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead 
                    className="text-right cursor-pointer hover:bg-muted/50 select-none"
                    onClick={() => handleSort("shipped")}
                  >
                    <div className="flex items-center justify-end">
                      Shipped {getSortIcon("shipped")}
                    </div>
                  </TableHead>
                  <TableHead 
                    className="text-right cursor-pointer hover:bg-muted/50 select-none"
                    onClick={() => handleSort("received")}
                  >
                    <div className="flex items-center justify-end">
                      Received {getSortIcon("received")}
                    </div>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedResults.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      {item.image_url ? (
                        <img
                          src={item.image_url}
                          alt={item.title || item.asin}
                          className="w-12 h-12 object-contain rounded"
                        />
                      ) : (
                        <div className="w-12 h-12 bg-muted rounded flex items-center justify-center">
                          <Package className="h-6 w-6 text-muted-foreground" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="max-w-xs">
                        <p className="font-medium truncate">{item.title || "No title"}</p>
                        <p className="text-xs text-muted-foreground font-mono">{item.seller_sku}</p>
                        {item.fnsku && (
                          <p className="text-xs text-muted-foreground">FNSKU: {item.fnsku}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>
                        <p className="font-medium">{item.shipment_name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{item.shipment_id}</p>
                      </div>
                    </TableCell>
                    <TableCell>{getStatusBadge(item.shipment_status || "Unknown")}</TableCell>
                    <TableCell className="text-right font-medium">{item.quantity_shipped || 0}</TableCell>
                    <TableCell className="text-right font-medium text-green-600">
                      {item.quantity_received || 0}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
