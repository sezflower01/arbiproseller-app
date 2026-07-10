import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, CheckCircle2, XCircle, AlertTriangle, ExternalLink, Loader2, Camera, DollarSign } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface LookupResult {
  found: boolean;
  order_id: string;
  order_date: string | null;
  order_status: string | null;
  sold_price: number | null;
  total_sale_amount: number | null;
  quantity: number | null;
  asin: string | null;
  title: string | null;
  marketplace: string | null;
  is_cancelled: boolean | null;
  price_source: string | null;
  fees_source: string | null;
  estimated_price: number | null;
  unit_cost: number | null;
  referral_fee: number | null;
  fba_fee: number | null;
  total_fees: number | null;
  // Settlement data
  hasSettlement: boolean;
  settlementDate: string | null;
  settlementSales: number | null;
  settlementFees: number | null;
  settlementRefunds: number | null;
  // Snapshot data
  hasSnapshot: boolean;
  snapshotPrice: number | null;
  snapshotSource: string | null;
}

const getAmazonDomain = (marketplace: string | null): string => {
  const map: Record<string, string> = {
    US: "sellercentral.amazon.com",
    CA: "sellercentral.amazon.ca",
    MX: "sellercentral.amazon.com.mx",
    BR: "sellercentral.amazon.com.br",
  };
  return map[marketplace || "US"] || "sellercentral.amazon.com";
};

const money = (v: number | null | undefined) =>
  v != null ? `$${v.toFixed(2)}` : "—";

const sourceBadge = (source: string | null) => {
  if (!source) return null;
  const colors: Record<string, string> = {
    actual: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    snapshot: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    estimated: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    inventory: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
    from_cache: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400",
    fees_api: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  };
  return (
    <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium", colors[source] || "bg-muted text-muted-foreground")}>
      {source}
    </span>
  );
};

export default function OrderPaymentLookup({ userId }: { userId: string }) {
  const [orderId, setOrderId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [searched, setSearched] = useState(false);
  const [open, setOpen] = useState(false);

  const handleLookup = async () => {
    const trimmed = orderId.trim();
    if (!trimmed) return;

    setLoading(true);
    setResult(null);
    setSearched(true);

    try {
      // Parallel: sales_orders, financial_events_cache, order_price_snapshots
      const [{ data: orderRows }, { data: fecRows }, { data: snapRows }] = await Promise.all([
        supabase
          .from("sales_orders")
          .select("order_id, order_date, order_status, sold_price, total_sale_amount, quantity, asin, title, marketplace, is_cancelled, price_source, fees_source, estimated_price, unit_cost, referral_fee, fba_fee, total_fees")
          .eq("user_id", userId)
          .eq("order_id", trimmed)
          .limit(1),
        supabase
          .from("financial_events_cache")
          .select("event_date, sales, fba_fees, referral_fees, refunds, event_type")
          .eq("user_id", userId)
          .eq("amazon_order_id", trimmed)
          .limit(10),
        supabase
          .from("order_price_snapshots")
          .select("snapshot_item_price, snapshot_source")
          .eq("user_id", userId)
          .eq("order_id", trimmed)
          .limit(1),
      ]);

      const order = orderRows?.[0] || null;
      const settlements = fecRows || [];
      const hasSettlement = settlements.length > 0;
      const snap = snapRows?.[0] || null;

      const settlementSales = hasSettlement
        ? settlements.reduce((s, r) => s + Number(r.sales || 0), 0)
        : null;
      const settlementFees = hasSettlement
        ? settlements.reduce((s, r) => s + Math.abs(Number(r.fba_fees || 0)) + Math.abs(Number(r.referral_fees || 0)), 0)
        : null;
      const settlementRefunds = hasSettlement
        ? settlements.reduce((s, r) => s + Math.abs(Number(r.refunds || 0)), 0)
        : null;
      const settlementDate = hasSettlement ? settlements[0].event_date : null;

      if (!order && !hasSettlement) {
        setResult({
          found: false, order_id: trimmed, order_date: null, order_status: null,
          sold_price: null, total_sale_amount: null, quantity: null, asin: null,
          title: null, marketplace: null, is_cancelled: null,
          price_source: null, fees_source: null, estimated_price: null,
          unit_cost: null, referral_fee: null, fba_fee: null, total_fees: null,
          hasSettlement: false, settlementDate: null, settlementSales: null, settlementFees: null, settlementRefunds: null,
          hasSnapshot: false, snapshotPrice: null, snapshotSource: null,
        });
      } else {
        setResult({
          found: true,
          order_id: trimmed,
          order_date: order?.order_date || null,
          order_status: order?.order_status || null,
          sold_price: order?.sold_price ?? null,
          total_sale_amount: order?.total_sale_amount ?? null,
          quantity: order?.quantity ?? null,
          asin: order?.asin || null,
          title: order?.title || null,
          marketplace: order?.marketplace || null,
          is_cancelled: order?.is_cancelled ?? null,
          price_source: order?.price_source || null,
          fees_source: order?.fees_source || null,
          estimated_price: order?.estimated_price ?? null,
          unit_cost: order?.unit_cost ?? null,
          referral_fee: order?.referral_fee ?? null,
          fba_fee: order?.fba_fee ?? null,
          total_fees: order?.total_fees ?? null,
          hasSettlement,
          settlementDate,
          settlementSales,
          settlementFees,
          settlementRefunds,
          hasSnapshot: !!snap,
          snapshotPrice: snap?.snapshot_item_price ?? null,
          snapshotSource: snap?.snapshot_source || null,
        });
      }
    } catch (err) {
      console.error("Order lookup error:", err);
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const getPaymentVerdict = (r: LookupResult) => {
    if (!r.found) return { icon: <XCircle className="h-5 w-5 text-destructive" />, label: "Not Found", color: "text-destructive", description: "This order was not found in your synced data." };
    if (r.is_cancelled) return { icon: <XCircle className="h-5 w-5 text-destructive" />, label: "Cancelled", color: "text-destructive", description: "This order was cancelled. You were NOT paid for it." };
    if (r.hasSettlement && (r.settlementSales ?? 0) > 0) return { icon: <CheckCircle2 className="h-5 w-5 text-green-600" />, label: "Paid ✓", color: "text-green-600", description: "Amazon has settled this order. Payment was included in your disbursement." };
    if (r.hasSettlement && (r.settlementSales ?? 0) === 0) return { icon: <AlertTriangle className="h-5 w-5 text-amber-500" />, label: "Settled – $0", color: "text-amber-500", description: "A settlement record exists but sales amount is $0. May be a refund-only settlement or replacement order." };
    if ((r.sold_price ?? 0) > 0) return { icon: <AlertTriangle className="h-5 w-5 text-amber-500" />, label: "Awaiting Settlement", color: "text-amber-500", description: "The order has a confirmed price but hasn't appeared in settlement data yet." };
    if (r.order_status === "Pending" || r.order_status === "Unshipped") return { icon: <AlertTriangle className="h-5 w-5 text-amber-500" />, label: "Pending", color: "text-amber-500", description: "Order is still pending/unshipped." };
    return { icon: <AlertTriangle className="h-5 w-5 text-amber-500" />, label: "Unknown", color: "text-amber-500", description: "Could not determine payment status." };
  };

  const formatDate = (d: string | null) => {
    if (!d) return "—";
    const [y, m, dd] = d.split("-");
    return `${m}/${dd}/${y}`;
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className="border-dashed">
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer py-3 hover:bg-accent/30 transition-colors">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Search className="h-4 w-4" />
              Order Payment Lookup
              <Badge variant="outline" className="ml-auto text-xs">
                {open ? "Hide" : "Check if you got paid"}
              </Badge>
            </CardTitle>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 space-y-4">
            <div className="flex gap-2">
              <Input
                placeholder="Enter Amazon Order ID (e.g. 111-1234567-1234567)"
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLookup()}
                className="font-mono text-sm"
              />
              <Button onClick={handleLookup} disabled={loading || !orderId.trim()} size="sm">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                <span className="ml-1 hidden sm:inline">Lookup</span>
              </Button>
            </div>

            {searched && result && (
              <div className="rounded-lg border p-4 space-y-3">
                {(() => {
                  const verdict = getPaymentVerdict(result);
                  return (
                    <>
                      <div className="flex items-center gap-2">
                        {verdict.icon}
                        <span className={`font-semibold text-lg ${verdict.color}`}>{verdict.label}</span>
                        <a
                          href={`https://${getAmazonDomain(result.marketplace)}/orders-v3/order/${result.order_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-auto text-muted-foreground hover:text-primary"
                          title="View in Seller Central"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </div>
                      <p className="text-sm text-muted-foreground">{verdict.description}</p>

                      {result.found && (
                        <div className="space-y-3 pt-2 border-t">
                          {/* Order basics */}
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
                            <div>
                              <span className="text-muted-foreground">Order Date</span>
                              <div className="font-medium">{formatDate(result.order_date)}</div>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Status</span>
                              <div className="font-medium">{result.order_status || "—"}</div>
                            </div>
                            <div>
                              <span className="text-muted-foreground">ASIN</span>
                              <div className="font-medium font-mono text-xs">{result.asin || "—"}</div>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Qty</span>
                              <div className="font-medium">{result.quantity ?? "—"}</div>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Marketplace</span>
                              <div className="font-medium">{result.marketplace || "—"}</div>
                            </div>
                          </div>

                          {/* Price Sources */}
                          <div className="border-t pt-2">
                            <div className="flex items-center gap-1.5 mb-2">
                              <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-xs font-semibold text-muted-foreground">Price Sources</span>
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-sm">
                              <div>
                                <span className="text-muted-foreground">Sold Price</span>
                                <div className="font-medium flex items-center gap-1.5">
                                  {money(result.sold_price)}
                                  {result.price_source && sourceBadge(result.price_source)}
                                </div>
                              </div>
                              <div>
                                <span className="text-muted-foreground">Estimated Price</span>
                                <div className="font-medium">{money(result.estimated_price)}</div>
                              </div>
                              <div>
                                <span className="text-muted-foreground">Unit Cost</span>
                                <div className="font-medium">{money(result.unit_cost)}</div>
                              </div>
                            </div>
                          </div>

                          {/* Snapshot */}
                          {result.hasSnapshot && (
                            <div className="border-t pt-2">
                              <div className="flex items-center gap-1.5 mb-2">
                                <Camera className="h-3.5 w-3.5 text-blue-500" />
                                <span className="text-xs font-semibold text-blue-600">Price Snapshot</span>
                              </div>
                              <div className="grid grid-cols-2 gap-x-4 text-sm">
                                <div>
                                  <span className="text-muted-foreground">Snapshot Price</span>
                                  <div className="font-medium text-blue-600">{money(result.snapshotPrice)}</div>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Source</span>
                                  <div className="font-medium">{result.snapshotSource || "—"}</div>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Fees */}
                          {(result.referral_fee || result.fba_fee || result.total_fees) && (
                            <div className="border-t pt-2">
                              <div className="flex items-center gap-1.5 mb-2">
                                <span className="text-xs font-semibold text-muted-foreground">Fees</span>
                                {result.fees_source && sourceBadge(result.fees_source)}
                              </div>
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-sm">
                                <div>
                                  <span className="text-muted-foreground">Referral</span>
                                  <div className="font-medium text-destructive">{money(result.referral_fee)}</div>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">FBA</span>
                                  <div className="font-medium text-destructive">{money(result.fba_fee)}</div>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Total Fees</span>
                                  <div className="font-medium text-destructive">{money(result.total_fees)}</div>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Settlement */}
                          {result.hasSettlement && (
                            <div className="border-t pt-2">
                              <span className="text-xs font-semibold text-green-600">Settlement Data</span>
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-sm mt-1">
                                <div>
                                  <span className="text-muted-foreground">Date</span>
                                  <div className="font-medium">{formatDate(result.settlementDate)}</div>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Sales</span>
                                  <div className="font-medium text-green-600">{money(result.settlementSales)}</div>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Fees</span>
                                  <div className="font-medium text-destructive">-{money(result.settlementFees)}</div>
                                </div>
                                {(result.settlementRefunds ?? 0) > 0 && (
                                  <div>
                                    <span className="text-muted-foreground">Refunds</span>
                                    <div className="font-medium text-destructive">-{money(result.settlementRefunds)}</div>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}

            {searched && !result && !loading && (
              <p className="text-sm text-muted-foreground">An error occurred. Please try again.</p>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
