import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { RefreshCw, AlertTriangle, Copy, ExternalLink } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { useSalesVelocity } from "@/hooks/use-sales-velocity";
import { formatPrice, getMarketplaceConfig } from "@/lib/marketplaceCurrency";

interface MismatchRow {
  id: string;
  asin: string;
  sku: string | null;
  marketplace: string;
  new_price: number | null;
  intelligence_factors: any;
  feed_id: string | null;
  created_at: string;
}

export default function MismatchSkusTable() {
  const [mismatches, setMismatches] = useState<MismatchRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchMismatches = async () => {
    setLoading(true);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data, error } = await supabase
      .from("repricer_price_actions")
      .select("id, asin, sku, marketplace, new_price, intelligence_factors, feed_id, created_at")
      .eq("update_method", "FEED")
      .eq("success", true)
      .gte("created_at", todayStart.toISOString())
      .order("created_at", { ascending: false })
      .limit(200);

    if (!error) {
      const unverified = (data || []).filter((row: any) =>
        row.intelligence_factors?.verification?.confirmed === false
      );
      setMismatches(unverified as MismatchRow[]);
    }
    setLoading(false);
  };

  useEffect(() => { fetchMismatches(); }, []);

  // Collect unique ASINs for velocity lookup
  const uniqueAsins = useMemo(
    () => [...new Set(mismatches.map((m) => m.asin))],
    [mismatches]
  );
  const { velocityMap } = useSalesVelocity(uniqueAsins);

  const getActualPrice = (row: MismatchRow) => {
    return row.intelligence_factors?.verification?.actual_price;
  };

  const getVelocityBadge = (asin: string) => {
    const v = velocityMap[asin];
    if (!v) return null;
    if (v.units_30d === 0) return "destructive" as const;
    if (v.units_30d <= 3) return "default" as const;
    return "secondary" as const;
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-yellow-500" />
          Mismatch SKUs (Unverified)
        </CardTitle>
        <Button variant="outline" size="sm" onClick={fetchMismatches}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-center py-6 text-muted-foreground">Loading...</div>
        ) : mismatches.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            ✅ No mismatches today — all verified prices match
          </div>
        ) : (
          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>ASIN</TableHead>
                  <TableHead className="text-right">Expected</TableHead>
                  <TableHead className="text-right">Actual</TableHead>
                  <TableHead className="text-right">30d Units</TableHead>
                  <TableHead className="text-right">30d Orders</TableHead>
                  <TableHead>Last Sale</TableHead>
                  <TableHead>Feed ID</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mismatches.map((row) => {
                  const actual = getActualPrice(row);
                  const v = velocityMap[row.asin];
                  const badgeVariant = getVelocityBadge(row.asin);
                  return (
                    <TableRow key={row.id} className="bg-yellow-50 dark:bg-yellow-950/10">
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-sm">{row.sku || "—"}</span>
                          {row.sku && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 w-5 p-0"
                              onClick={() => {
                                navigator.clipboard.writeText(row.sku!);
                                toast.success("SKU copied");
                              }}
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <a
                          href={`https://www.amazon.com/dp/${row.asin}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-sm text-primary hover:underline flex items-center gap-1"
                        >
                          {row.asin}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </TableCell>
                      <TableCell className="text-right font-mono text-green-600">
                        {row.new_price != null ? formatPrice(row.new_price, row.marketplace || "US") : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-red-600">
                        {actual != null ? formatPrice(actual, row.marketplace || "US") : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {v ? (
                          <Badge variant={badgeVariant}>
                            {v.units_30d}
                          </Badge>
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {v ? v.orders_30d : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {v?.days_since_last_sale != null
                          ? `${v.days_since_last_sale}d ago`
                          : v
                            ? "Never"
                            : "—"}
                      </TableCell>
                      <TableCell className="font-mono text-xs truncate max-w-[100px]">
                        {row.feed_id || "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {format(new Date(row.created_at), "HH:mm")}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            const url = `https://sellercentral.amazon.com/skucentral?mSku=${encodeURIComponent(row.sku || row.asin)}`;
                            window.open(url, "_blank");
                          }}
                        >
                          Seller Central →
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
