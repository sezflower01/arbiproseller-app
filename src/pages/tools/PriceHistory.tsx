import { useState, useEffect, useMemo } from "react";
import { Helmet } from "react-helmet-async";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { format, subDays } from "date-fns";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Scatter,
  ComposedChart,
} from "recharts";
import { Search, RefreshCw, TrendingUp, Download } from "lucide-react";

interface PriceHistoryRow {
  id: string;
  asin: string;
  marketplace: string;
  captured_at: string;
  listing_price: number;
  buybox_price: number | null;
  currency_code: string;
  price_usd: number | null;
  source: string;
}

interface SalesPoint {
  order_id: string;
  order_date: string;
  sold_price: number;
  quantity: number;
}

const MARKETPLACES = [
  { value: "US", label: "🇺🇸 United States", currency: "USD" },
  { value: "CA", label: "🇨🇦 Canada", currency: "CAD" },
  { value: "MX", label: "🇲🇽 Mexico", currency: "MXN" },
  { value: "BR", label: "🇧🇷 Brazil", currency: "BRL" },
];

const DATE_RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last year" },
];

const PriceHistory = () => {
  const { user } = useAuth();
  const [asin, setAsin] = useState("");
  const [marketplace, setMarketplace] = useState("US");
  const [dateRange, setDateRange] = useState("30");
  const [showBuyBox, setShowBuyBox] = useState(true);
  const [showSales, setShowSales] = useState(true);
  const [loading, setLoading] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [priceHistory, setPriceHistory] = useState<PriceHistoryRow[]>([]);
  const [salesPoints, setSalesPoints] = useState<SalesPoint[]>([]);
  const [productTitle, setProductTitle] = useState<string | null>(null);
  const [productImage, setProductImage] = useState<string | null>(null);

  const selectedMarketplace = MARKETPLACES.find(m => m.value === marketplace);

  const fetchData = async () => {
    if (!user || !asin.trim()) return;
    
    setLoading(true);
    try {
      const startDate = subDays(new Date(), parseInt(dateRange));

      // Fetch price history
      const { data: historyData, error: historyError } = await supabase
        .from("asin_price_history")
        .select("*")
        .eq("user_id", user.id)
        .eq("asin", asin.trim().toUpperCase())
        .eq("marketplace", marketplace)
        .gte("captured_at", startDate.toISOString())
        .order("captured_at", { ascending: true });

      if (historyError) throw historyError;
      setPriceHistory(historyData || []);

      // Fetch sales points
      const { data: salesData, error: salesError } = await supabase
        .from("sales_orders")
        .select("order_id, order_date, sold_price, quantity")
        .eq("user_id", user.id)
        .eq("asin", asin.trim().toUpperCase())
        .gte("order_date", format(startDate, "yyyy-MM-dd"))
        .gt("sold_price", 0);

      if (salesError) throw salesError;
      setSalesPoints(salesData || []);

      // Fetch product info from inventory
      const { data: inventoryData } = await supabase
        .from("inventory")
        .select("title, image_url")
        .eq("user_id", user.id)
        .eq("asin", asin.trim().toUpperCase())
        .maybeSingle();

      if (inventoryData) {
        setProductTitle(inventoryData.title);
        setProductImage(inventoryData.image_url);
      } else {
        // Try created_listings
        const { data: listingData } = await supabase
          .from("created_listings")
          .select("title, image_url")
          .eq("user_id", user.id)
          .eq("asin", asin.trim().toUpperCase())
          .limit(1)
          .maybeSingle();

        setProductTitle(listingData?.title || null);
        setProductImage(listingData?.image_url || null);
      }

    } catch (error: any) {
      console.error("Error fetching data:", error);
      toast.error("Failed to fetch price history");
    } finally {
      setLoading(false);
    }
  };

  const captureCurrentPrice = async () => {
    if (!asin.trim()) {
      toast.error("Please enter an ASIN");
      return;
    }

    setCapturing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast.error("Please log in to capture prices");
        return;
      }

      const response = await supabase.functions.invoke("capture-asin-price", {
        body: { asin: asin.trim().toUpperCase(), marketplace },
      });

      if (response.error) throw response.error;

      const result = response.data;
      if (result.success) {
        toast.success(`Price captured: ${selectedMarketplace?.currency} ${result.data?.listing_price || result.listing_price}`);
        fetchData(); // Refresh data
      } else {
        toast.error(result.error || "Failed to capture price");
      }
    } catch (error: any) {
      console.error("Error capturing price:", error);
      toast.error(error.message || "Failed to capture current price");
    } finally {
      setCapturing(false);
    }
  };

  // Prepare chart data
  const chartData = useMemo(() => {
    const dataPoints: any[] = [];

    // Add price history points
    priceHistory.forEach(row => {
      dataPoints.push({
        date: new Date(row.captured_at).getTime(),
        dateLabel: format(new Date(row.captured_at), "MMM d, HH:mm"),
        listingPrice: row.listing_price,
        buyboxPrice: row.buybox_price,
        type: "history",
      });
    });

    // Add sales points
    if (showSales) {
      salesPoints.forEach(sale => {
        const saleDate = new Date(sale.order_date).getTime();
        dataPoints.push({
          date: saleDate,
          dateLabel: format(new Date(sale.order_date), "MMM d"),
          soldPrice: sale.sold_price,
          orderId: sale.order_id,
          quantity: sale.quantity,
          type: "sale",
        });
      });
    }

    // Sort by date
    return dataPoints.sort((a, b) => a.date - b.date);
  }, [priceHistory, salesPoints, showSales]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchData();
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Helmet>
        <title>Price History | ArbiProSeller</title>
        <meta name="description" content="Track ASIN price changes over time with historical charts and sales data." />
      </Helmet>

      <Navbar />

      <main className="flex-grow pt-24 pb-16">
        <div className="container mx-auto px-4 max-w-7xl">
          <div className="mb-8">
            <h1 className="text-3xl font-bold flex items-center gap-3">
              <TrendingUp className="h-8 w-8 text-primary" />
              Price History
            </h1>
            <p className="text-muted-foreground mt-2">
              Track ASIN price changes over time and compare with actual sales
            </p>
          </div>

          {/* Search Controls */}
          <Card className="mb-6">
            <CardContent className="pt-6">
              <form onSubmit={handleSearch} className="space-y-4">
                <div className="flex flex-wrap gap-4 items-end">
                  <div className="flex-1 min-w-[200px]">
                    <Label htmlFor="asin">ASIN</Label>
                    <Input
                      id="asin"
                      placeholder="Enter ASIN (e.g., B00EXAMPLE)"
                      value={asin}
                      onChange={(e) => setAsin(e.target.value.toUpperCase())}
                      className="uppercase"
                    />
                  </div>

                  <div className="w-48">
                    <Label>Marketplace</Label>
                    <Select value={marketplace} onValueChange={setMarketplace}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MARKETPLACES.map(m => (
                          <SelectItem key={m.value} value={m.value}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="w-40">
                    <Label>Date Range</Label>
                    <Select value={dateRange} onValueChange={setDateRange}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DATE_RANGES.map(r => (
                          <SelectItem key={r.value} value={r.value}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <Button type="submit" disabled={loading || !asin.trim()}>
                    <Search className="h-4 w-4 mr-2" />
                    {loading ? "Loading..." : "Search"}
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    onClick={captureCurrentPrice}
                    disabled={capturing || !asin.trim()}
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${capturing ? "animate-spin" : ""}`} />
                    Capture Now
                  </Button>
                </div>

                <div className="flex flex-wrap gap-6 pt-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="show-buybox"
                      checked={showBuyBox}
                      onCheckedChange={setShowBuyBox}
                    />
                    <Label htmlFor="show-buybox" className="cursor-pointer">
                      Show Buy Box Line
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="show-sales"
                      checked={showSales}
                      onCheckedChange={setShowSales}
                    />
                    <Label htmlFor="show-sales" className="cursor-pointer">
                      Show Sales Dots
                    </Label>
                  </div>
                </div>
              </form>
            </CardContent>
          </Card>

          {/* Product Info */}
          {(productTitle || productImage) && (
            <Card className="mb-6">
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  {productImage && (
                    <img
                      src={productImage}
                      alt={productTitle || asin}
                      className="w-16 h-16 object-contain rounded border"
                    />
                  )}
                  <div>
                    <p className="font-semibold">{productTitle || asin}</p>
                    <p className="text-sm text-muted-foreground">ASIN: {asin}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Chart */}
          {chartData.length > 0 ? (
            <Card className="mb-6">
              <CardHeader>
                <CardTitle>
                  Price Trend ({selectedMarketplace?.currency})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-[400px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis
                        dataKey="dateLabel"
                        tick={{ fontSize: 12 }}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fontSize: 12 }}
                        tickFormatter={(value) => `${selectedMarketplace?.currency === 'USD' ? '$' : ''}${value.toFixed(2)}`}
                      />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (active && payload && payload.length) {
                            const data = payload[0].payload;
                            return (
                              <div className="bg-popover border rounded-lg p-3 shadow-lg">
                                <p className="font-medium">{data.dateLabel}</p>
                                {data.listingPrice && (
                                  <p className="text-sm">Listing: {selectedMarketplace?.currency} {data.listingPrice.toFixed(2)}</p>
                                )}
                                {data.buyboxPrice && (
                                  <p className="text-sm">Buy Box: {selectedMarketplace?.currency} {data.buyboxPrice.toFixed(2)}</p>
                                )}
                                {data.soldPrice && (
                                  <p className="text-sm text-green-600">
                                    Sold: ${data.soldPrice.toFixed(2)} (x{data.quantity})
                                  </p>
                                )}
                                {data.orderId && (
                                  <p className="text-xs text-muted-foreground mt-1">
                                    Order: {data.orderId}
                                  </p>
                                )}
                              </div>
                            );
                          }
                          return null;
                        }}
                      />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="listingPrice"
                        stroke="hsl(var(--primary))"
                        strokeWidth={2}
                        dot={false}
                        name="Listing Price"
                        connectNulls
                      />
                      {showBuyBox && (
                        <Line
                          type="monotone"
                          dataKey="buyboxPrice"
                          stroke="hsl(var(--chart-2))"
                          strokeWidth={2}
                          dot={false}
                          name="Buy Box"
                          connectNulls
                        />
                      )}
                      {showSales && (
                        <Scatter
                          dataKey="soldPrice"
                          fill="hsl(var(--chart-3))"
                          name="Sold Price"
                        />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          ) : asin && !loading ? (
            <Card className="mb-6">
              <CardContent className="py-12 text-center text-muted-foreground">
                <TrendingUp className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No price history found for this ASIN.</p>
                <p className="text-sm mt-2">
                  Click "Capture Now" to start tracking prices.
                </p>
              </CardContent>
            </Card>
          ) : null}

          {/* History Table */}
          {priceHistory.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Price History Records</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Captured At</TableHead>
                        <TableHead className="text-right">Listing Price</TableHead>
                        <TableHead className="text-right">Buy Box</TableHead>
                        <TableHead>Currency</TableHead>
                        <TableHead>Source</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {priceHistory.slice().reverse().slice(0, 50).map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>
                            {format(new Date(row.captured_at), "MMM d, yyyy HH:mm")}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {row.listing_price.toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {row.buybox_price ? row.buybox_price.toFixed(2) : "—"}
                          </TableCell>
                          <TableCell>{row.currency_code}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {row.source}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {priceHistory.length > 50 && (
                  <p className="text-sm text-muted-foreground mt-4 text-center">
                    Showing most recent 50 of {priceHistory.length} records
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Sales Table */}
          {showSales && salesPoints.length > 0 && (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Sales Transactions</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Order Date</TableHead>
                        <TableHead>Order ID</TableHead>
                        <TableHead className="text-right">Sold Price</TableHead>
                        <TableHead className="text-right">Quantity</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {salesPoints.slice().reverse().slice(0, 20).map((sale) => (
                        <TableRow key={sale.order_id}>
                          <TableCell>
                            {format(new Date(sale.order_date), "MMM d, yyyy")}
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {sale.order_id}
                          </TableCell>
                          <TableCell className="text-right font-mono text-green-600">
                            ${sale.sold_price.toFixed(2)}
                          </TableCell>
                          <TableCell className="text-right">
                            {sale.quantity}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
};

export default PriceHistory;
