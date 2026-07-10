import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AlertTriangle } from "lucide-react";

interface MissingOrder {
  order_id: string;
  asin: string;
  sku: string | null;
  seller_sku: string | null;
  quantity: number;
  sold_price: number;
  total_sale_amount: number;
  total_fees: number;
  estimated_price?: number | null;
  price_source?: string | null;
  fees_source?: string | null;
  order_status?: string | null;
  is_cancelled?: boolean | null;
  unit_cost: number | null;
}

interface MissingField {
  field: string;
  repair: string;
}

interface MissingRow {
  order: MissingOrder;
  missingFields: MissingField[];
  unitsMissing: number;
}

interface MissingMoneyDrilldownProps {
  orders: MissingOrder[];
  className?: string;
}

export default function MissingMoneyDrilldown({ orders, className }: MissingMoneyDrilldownProps) {
  const [showDialog, setShowDialog] = useState(false);

  const { missingRows, totalUnits } = useMemo(() => {
    const rows: MissingRow[] = [];

    for (const o of orders) {
      if (o.is_cancelled || o.order_status === 'Cancelled' || o.order_status === 'Canceled') continue;

      const missing: MissingField[] = [];

      if ((o.sold_price || 0) === 0 && (o.total_sale_amount || 0) === 0 && !(o.estimated_price && o.estimated_price > 0)) {
        missing.push({ field: 'price', repair: 'Run Refresh Fees or wait for settlement' });
      }

      if ((o.total_fees || 0) === 0 || !o.fees_source || o.fees_source === 'unavailable') {
        missing.push({ field: 'fees', repair: 'Use Backfill Fees button' });
      }

      if ((o.unit_cost || 0) === 0) {
        missing.push({ field: 'COGS', repair: 'Add cost in Create Listing or Inventory' });
      }

      if (missing.length > 0) {
        rows.push({
          order: o,
          missingFields: missing,
          unitsMissing: o.quantity || 1,
        });
      }
    }

    return {
      missingRows: rows,
      totalUnits: rows.reduce((s, r) => s + r.unitsMissing, 0),
    };
  }, [orders]);

  if (missingRows.length === 0) return null;

  const priceOnly = missingRows.filter(r => r.missingFields.some(f => f.field === 'price')).length;
  const feesOnly = missingRows.filter(r => r.missingFields.some(f => f.field === 'fees')).length;
  const cogsOnly = missingRows.filter(r => r.missingFields.some(f => f.field === 'COGS')).length;

  return (
    <>
      <Card className={className}>
        <CardContent className="py-3 px-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4 text-yellow-500" />
              <span className="font-medium text-muted-foreground">Missing Money</span>
            </div>
            <span className="text-xs text-muted-foreground">
              {missingRows.length} orders ({totalUnits} units) have incomplete data
            </span>
            <div className="flex gap-1.5 flex-wrap">
              {priceOnly > 0 && <Badge variant="destructive" className="text-[10px]">{priceOnly} no price</Badge>}
              {feesOnly > 0 && <Badge variant="secondary" className="text-[10px]">{feesOnly} no fees</Badge>}
              {cogsOnly > 0 && <Badge variant="outline" className="text-[10px]">{cogsOnly} no COGS</Badge>}
            </div>
            <Button variant="ghost" size="sm" className="text-xs ml-auto" onClick={() => setShowDialog(true)}>
              View Details
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-5xl max-h-[80vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Missing Money Drilldown</DialogTitle>
            <DialogDescription>
              Orders contributing units but missing price, fees, or COGS data.
            </DialogDescription>
          </DialogHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Order ID</TableHead>
                <TableHead className="text-xs">ASIN</TableHead>
                <TableHead className="text-xs">SKU</TableHead>
                <TableHead className="text-xs text-right">Qty</TableHead>
                <TableHead className="text-xs">Status</TableHead>
                <TableHead className="text-xs">Missing</TableHead>
                <TableHead className="text-xs">Repair Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {missingRows.slice(0, 200).map((row, idx) => (
                <TableRow key={`${row.order.order_id}-${idx}`}>
                  <TableCell className="text-xs font-mono">
                    {row.order.order_id ? (
                      /^\d{3}-\d{7}-\d{7}$/.test(row.order.order_id) ? (
                        <a
                          href={`https://sellercentral.amazon.com/orders-v3/order/${row.order.order_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-500 hover:underline"
                        >
                          {row.order.order_id}
                        </a>
                      ) : row.order.order_id
                    ) : '—'}
                  </TableCell>
                  <TableCell className="text-xs font-mono">{row.order.asin}</TableCell>
                  <TableCell className="text-xs font-mono">{row.order.seller_sku || row.order.sku || '—'}</TableCell>
                  <TableCell className="text-xs text-right">{row.order.quantity}</TableCell>
                  <TableCell className="text-xs">{row.order.order_status || '—'}</TableCell>
                  <TableCell>
                    <div className="flex gap-1 flex-wrap">
                      {row.missingFields.map(f => (
                        <Badge key={f.field} variant={f.field === 'price' ? 'destructive' : 'secondary'} className="text-[10px]">
                          {f.field}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-[200px]">
                    {row.missingFields.map(f => f.repair).join('; ')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {missingRows.length > 200 && (
            <p className="text-xs text-muted-foreground mt-2">Showing first 200 of {missingRows.length} rows.</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
