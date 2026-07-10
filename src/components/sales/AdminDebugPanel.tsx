import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Bug, ChevronDown, ChevronRight } from "lucide-react";

interface DebugOrder {
  id: string;
  order_id: string;
  asin: string;
  sku: string | null;
  seller_sku: string | null;
  quantity: number;
  sold_price: number;
  total_sale_amount: number;
  total_fees: number;
  referral_fee: number;
  fba_fee: number;
  closing_fee: number;
  unit_cost: number | null;
  price_source?: string | null;
  fees_source?: string | null;
  estimated_price?: number | null;
  order_status?: string | null;
  order_type?: string | null;
  marketplace?: string | null;
  is_cancelled?: boolean | null;
}

interface AdminDebugPanelProps {
  orders: DebugOrder[];
  isAdmin: boolean;
  className?: string;
}

export default function AdminDebugPanel({ orders, isAdmin, className }: AdminDebugPanelProps) {
  const [showPanel, setShowPanel] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<DebugOrder | null>(null);

  const priceSourceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const o of orders) {
      const src = o.price_source || 'unknown';
      counts[src] = (counts[src] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [orders]);

  const feeSourceCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const o of orders) {
      const src = o.fees_source || 'unknown';
      counts[src] = (counts[src] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [orders]);

  const cogsSourceCounts = useMemo(() => {
    let withCost = 0, withoutCost = 0;
    for (const o of orders) {
      if ((o.unit_cost || 0) > 0) withCost++;
      else withoutCost++;
    }
    return { withCost, withoutCost };
  }, [orders]);

  if (!isAdmin) return null;

  return (
    <>
      <Collapsible open={showPanel} onOpenChange={setShowPanel}>
        <CollapsibleTrigger asChild>
          <Button variant="outline" size="sm" className="w-full text-xs gap-1.5 border-dashed">
            <Bug className="h-3 w-3" />
            {showPanel ? 'Hide' : 'Show'} Admin Debug
            {showPanel ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Card className={`mt-2 border-dashed ${className || ''}`}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Bug className="h-4 w-4" />
                Admin Debug Mode
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-0">
              {/* Source Distribution */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-md border p-2">
                  <div className="text-xs font-medium mb-1">Price Sources</div>
                  {priceSourceCounts.map(([src, count]) => (
                    <div key={src} className="flex justify-between text-xs text-muted-foreground">
                      <span className="font-mono truncate mr-2">{src}</span>
                      <Badge variant="outline" className="text-[10px] px-1 py-0">{count}</Badge>
                    </div>
                  ))}
                </div>
                <div className="rounded-md border p-2">
                  <div className="text-xs font-medium mb-1">Fee Sources</div>
                  {feeSourceCounts.map(([src, count]) => (
                    <div key={src} className="flex justify-between text-xs text-muted-foreground">
                      <span className="font-mono truncate mr-2">{src}</span>
                      <Badge variant="outline" className="text-[10px] px-1 py-0">{count}</Badge>
                    </div>
                  ))}
                </div>
                <div className="rounded-md border p-2">
                  <div className="text-xs font-medium mb-1">COGS Resolution</div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>With cost</span>
                    <Badge variant="default" className="text-[10px] px-1 py-0">{cogsSourceCounts.withCost}</Badge>
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Missing cost</span>
                    <Badge variant="destructive" className="text-[10px] px-1 py-0">{cogsSourceCounts.withoutCost}</Badge>
                  </div>
                </div>
              </div>

              {/* Full order detail on click */}
              <div className="max-h-48 overflow-auto rounded border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Order</TableHead>
                      <TableHead className="text-xs">ASIN</TableHead>
                      <TableHead className="text-xs">Price Src</TableHead>
                      <TableHead className="text-xs">Fee Src</TableHead>
                      <TableHead className="text-xs text-right">Sold</TableHead>
                      <TableHead className="text-xs text-right">Fees</TableHead>
                      <TableHead className="text-xs text-right">COGS</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.slice(0, 50).map((o, idx) => (
                      <TableRow
                        key={`${o.id}-${idx}`}
                        className="cursor-pointer"
                        onClick={() => setSelectedOrder(o)}
                      >
                        <TableCell className="text-xs font-mono">{o.order_id?.substring(0, 12)}…</TableCell>
                        <TableCell className="text-xs font-mono">{o.asin}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px] px-1 py-0">{o.price_source || '—'}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px] px-1 py-0">{o.fees_source || '—'}</Badge>
                        </TableCell>
                        <TableCell className="text-xs text-right font-mono">${(o.sold_price || 0).toFixed(2)}</TableCell>
                        <TableCell className="text-xs text-right font-mono">${(o.total_fees || 0).toFixed(2)}</TableCell>
                        <TableCell className="text-xs text-right font-mono">${(o.unit_cost || 0).toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </CollapsibleContent>
      </Collapsible>

      {/* Order Detail Dialog */}
      <Dialog open={!!selectedOrder} onOpenChange={() => setSelectedOrder(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm">Order Debug Detail</DialogTitle>
            <DialogDescription className="font-mono text-xs">{selectedOrder?.order_id}</DialogDescription>
          </DialogHeader>
          {selectedOrder && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              {Object.entries({
                ASIN: selectedOrder.asin,
                SKU: selectedOrder.seller_sku || selectedOrder.sku || '—',
                Quantity: selectedOrder.quantity,
                'Sold Price': `$${(selectedOrder.sold_price || 0).toFixed(2)}`,
                'Total Sale': `$${(selectedOrder.total_sale_amount || 0).toFixed(2)}`,
                'Estimated Price': selectedOrder.estimated_price ? `$${selectedOrder.estimated_price.toFixed(2)}` : '—',
                'Price Source': selectedOrder.price_source || '—',
                'Fee Source': selectedOrder.fees_source || '—',
                'Referral Fee': `$${(selectedOrder.referral_fee || 0).toFixed(2)}`,
                'FBA Fee': `$${(selectedOrder.fba_fee || 0).toFixed(2)}`,
                'Closing Fee': `$${(selectedOrder.closing_fee || 0).toFixed(2)}`,
                'Total Fees': `$${(selectedOrder.total_fees || 0).toFixed(2)}`,
                'Unit Cost': selectedOrder.unit_cost ? `$${selectedOrder.unit_cost.toFixed(2)}` : '—',
                Status: selectedOrder.order_status || '—',
                Type: selectedOrder.order_type || '—',
                Marketplace: selectedOrder.marketplace || '—',
                Cancelled: selectedOrder.is_cancelled ? 'Yes' : 'No',
              }).map(([key, val]) => (
                <div key={key} className="flex justify-between border-b border-border/50 py-1">
                  <span className="text-muted-foreground">{key}</span>
                  <span className="font-mono">{val}</span>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
