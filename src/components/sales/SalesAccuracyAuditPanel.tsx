import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, CheckCircle, ChevronDown, ChevronRight } from "lucide-react";

export interface AuditOrder {
  id: string;
  order_id: string;
  asin: string;
  sku: string | null;
  seller_sku: string | null;
  quantity: number;
  sold_price: number;
  total_sale_amount: number;
  total_fees: number;
  price_source?: string | null;
  fees_source?: string | null;
  estimated_price?: number | null;
  order_status?: string | null;
  is_cancelled?: boolean | null;
  marketplace?: string | null;
}

export interface AuditIssue {
  category: string;
  severity: 'error' | 'warning' | 'info';
  count: number;
  dollarImpact: number;
  orders: AuditOrder[];
}

interface SettlementDupe {
  user_id: string;
  event_type: string;
  event_date: string;
  amazon_order_id: string;
  asin: string;
  cnt: number;
}

interface SalesAccuracyAuditPanelProps {
  orders: AuditOrder[];
  userId?: string;
  dateRange?: { startDate: string; endDate: string } | null;
  className?: string;
}

export default function SalesAccuracyAuditPanel({ orders, userId, dateRange, className }: SalesAccuracyAuditPanelProps) {
  const [expandedIssue, setExpandedIssue] = useState<string | null>(null);
  const [settlementDupes, setSettlementDupes] = useState<SettlementDupe[]>([]);

  // Fetch settlement duplicate check
  useEffect(() => {
    if (!userId || !dateRange) return;
    const checkSettlementDupes = async () => {
      try {
        // Use a raw count query to find duplicates by uniqueness key
        const { data } = await supabase
          .from('financial_events_cache')
          .select('user_id, event_type, event_date, amazon_order_id, asin')
          .eq('user_id', userId)
          .gte('event_date', dateRange.startDate)
          .lte('event_date', dateRange.endDate)
          .limit(2000);

        if (!data) return;

        // Client-side duplicate detection by uniqueness key
        const keyMap = new Map<string, number>();
        for (const row of data) {
          const key = `${row.event_type}|${row.event_date}|${row.amazon_order_id}|${row.asin}`;
          keyMap.set(key, (keyMap.get(key) || 0) + 1);
        }
        const dupes = [...keyMap.entries()]
          .filter(([, cnt]) => cnt > 1)
          .map(([key, cnt]) => {
            const [event_type, event_date, amazon_order_id, asin] = key.split('|');
            return { user_id: userId, event_type, event_date, amazon_order_id, asin, cnt };
          });
        setSettlementDupes(dupes);
      } catch (err) {
        console.error('Settlement dupe check error:', err);
      }
    };
    checkSettlementDupes();
  }, [userId, dateRange]);

  const issues = useMemo(() => {
    const result: AuditIssue[] = [];

    // 1. Duplicate orders by order_id + asin + sku
    const orderKeys = new Map<string, AuditOrder[]>();
    for (const o of orders) {
      const key = `${o.order_id}|${o.asin}|${o.sku || ''}`;
      if (!orderKeys.has(key)) orderKeys.set(key, []);
      orderKeys.get(key)!.push(o);
    }
    const dupes = [...orderKeys.values()].filter(g => g.length > 1);
    if (dupes.length > 0) {
      const dupOrders = dupes.flat();
      result.push({
        category: 'Duplicate Order Rows',
        severity: 'error',
        count: dupes.length,
        dollarImpact: dupes.reduce((sum, g) => {
          const extra = g.slice(1);
          return sum + extra.reduce((s, o) => s + (o.sold_price || o.total_sale_amount || 0) * (o.quantity || 1), 0);
        }, 0),
        orders: dupOrders,
      });
    }

    // 2. Settlement/financial_events duplicate rows (DB-level)
    if (settlementDupes.length > 0) {
      result.push({
        category: 'Duplicate Settlement Events',
        severity: 'error',
        count: settlementDupes.length,
        dollarImpact: 0, // Would need to fetch amounts to calculate
        orders: settlementDupes.map(d => ({
          id: `${d.amazon_order_id}-${d.asin}-${d.event_type}`,
          order_id: d.amazon_order_id,
          asin: d.asin,
          sku: null,
          seller_sku: null,
          quantity: d.cnt,
          sold_price: 0,
          total_sale_amount: 0,
          total_fees: 0,
          price_source: `${d.cnt} duplicates`,
        })),
      });
    }

    // 3. Duplicate refund rows (order_id ending with -REFUND or refund_amount > 0)
    const refundKeys = new Map<string, AuditOrder[]>();
    for (const o of orders) {
      if (o.order_id?.includes('-REFUND') || o.order_id?.includes('REFUND')) {
        const key = `${o.order_id}|${o.asin}`;
        if (!refundKeys.has(key)) refundKeys.set(key, []);
        refundKeys.get(key)!.push(o);
      }
    }
    const refundDupes = [...refundKeys.values()].filter(g => g.length > 1);
    if (refundDupes.length > 0) {
      result.push({
        category: 'Duplicate Refund Rows',
        severity: 'error',
        count: refundDupes.length,
        dollarImpact: refundDupes.reduce((sum, g) => sum + g.slice(1).reduce((s, o) => s + Math.abs(o.sold_price || o.total_sale_amount || 0), 0), 0),
        orders: refundDupes.flat(),
      });
    }

    // 4. Missing price
    const missingPrice = orders.filter(o =>
      (o.sold_price || 0) === 0 &&
      (o.total_sale_amount || 0) === 0 &&
      !o.estimated_price &&
      !o.is_cancelled
    );
    if (missingPrice.length > 0) {
      result.push({
        category: 'Orders Missing Price',
        severity: 'error',
        count: missingPrice.length,
        dollarImpact: 0,
        orders: missingPrice,
      });
    }

    // 5. Orders using estimated price
    const estimatedPrice = orders.filter(o =>
      (o.sold_price || 0) === 0 &&
      (o.total_sale_amount || 0) === 0 &&
      (o.estimated_price || 0) > 0
    );
    if (estimatedPrice.length > 0) {
      result.push({
        category: 'Using Estimated Price',
        severity: 'warning',
        count: estimatedPrice.length,
        dollarImpact: estimatedPrice.reduce((s, o) => s + (o.estimated_price || 0) * (o.quantity || 1), 0),
        orders: estimatedPrice,
      });
    }

    // 6. Missing fees
    const missingFees = orders.filter(o =>
      !o.is_cancelled &&
      (o.sold_price > 0 || o.total_sale_amount > 0) &&
      (o.total_fees === 0 || !o.fees_source || o.fees_source === 'unavailable')
    );
    if (missingFees.length > 0) {
      result.push({
        category: 'Orders Missing Fees',
        severity: 'warning',
        count: missingFees.length,
        dollarImpact: missingFees.reduce((s, o) => s + (o.sold_price || o.total_sale_amount || 0) * (o.quantity || 1), 0),
        orders: missingFees,
      });
    }

    // 7. Cancelled/excluded orders
    const cancelled = orders.filter(o => o.is_cancelled || o.order_status === 'Cancelled' || o.order_status === 'Canceled');
    if (cancelled.length > 0) {
      result.push({
        category: 'Cancelled/Excluded Orders',
        severity: 'info',
        count: cancelled.length,
        dollarImpact: 0,
        orders: cancelled,
      });
    }

    // 8. Pending placeholder orders
    const pending = orders.filter(o => o.asin === 'PENDING');
    if (pending.length > 0) {
      result.push({
        category: 'Pending Placeholders',
        severity: 'info',
        count: pending.length,
        dollarImpact: 0,
        orders: pending,
      });
    }

    // 9. Marketplace mismatch audit
    const marketplaces = new Set(orders.map(o => o.marketplace).filter(Boolean));
    if (marketplaces.size > 1) {
      const mismatch = orders.filter(o => !o.marketplace);
      if (mismatch.length > 0) {
        result.push({
          category: 'Missing Marketplace Attribution',
          severity: 'warning',
          count: mismatch.length,
          dollarImpact: mismatch.reduce((s, o) => s + (o.sold_price || o.total_sale_amount || 0) * (o.quantity || 1), 0),
          orders: mismatch,
        });
      }
    }

    return result;
  }, [orders, settlementDupes]);

  const totalIssues = issues.reduce((s, i) => s + i.count, 0);
  const hasErrors = issues.some(i => i.severity === 'error');
  const hasWarnings = issues.some(i => i.severity === 'warning');

  const severityColor = (s: string) => {
    if (s === 'error') return 'destructive';
    if (s === 'warning') return 'secondary';
    return 'outline';
  };

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            {hasErrors ? (
              <AlertTriangle className="h-4 w-4 text-destructive" />
            ) : hasWarnings ? (
              <AlertTriangle className="h-4 w-4 text-yellow-500" />
            ) : (
              <CheckCircle className="h-4 w-4 text-green-600" />
            )}
            Sales Accuracy Audit
          </CardTitle>
          <Badge variant={hasErrors ? 'destructive' : hasWarnings ? 'secondary' : 'default'}>
            {totalIssues === 0 ? 'CLEAN' : `${totalIssues} issue${totalIssues !== 1 ? 's' : ''}`}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {issues.length === 0 ? (
          <p className="text-xs text-muted-foreground">No data integrity issues detected for this period.</p>
        ) : (
          <div className="space-y-1">
            {issues.map(issue => (
              <Collapsible
                key={issue.category}
                open={expandedIssue === issue.category}
                onOpenChange={(open) => setExpandedIssue(open ? issue.category : null)}
              >
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="w-full justify-between text-xs h-8 px-2">
                    <span className="flex items-center gap-2">
                      {expandedIssue === issue.category ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      <Badge variant={severityColor(issue.severity)} className="text-[10px] px-1.5 py-0">{issue.severity}</Badge>
                      {issue.category}
                    </span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <span>{issue.count} rows</span>
                      {issue.dollarImpact > 0 && (
                        <span className="font-mono">${issue.dollarImpact.toFixed(2)}</span>
                      )}
                    </span>
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="max-h-48 overflow-auto rounded border mt-1 mb-2">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs">Order ID</TableHead>
                          <TableHead className="text-xs">ASIN</TableHead>
                          <TableHead className="text-xs">SKU</TableHead>
                          <TableHead className="text-xs text-right">Qty</TableHead>
                          <TableHead className="text-xs text-right">Price</TableHead>
                          <TableHead className="text-xs">Source</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {issue.orders.slice(0, 50).map((o, idx) => (
                          <TableRow key={`${o.id}-${idx}`}>
                            <TableCell className="text-xs font-mono">{o.order_id?.substring(0, 15)}…</TableCell>
                            <TableCell className="text-xs font-mono">{o.asin}</TableCell>
                            <TableCell className="text-xs font-mono">{o.seller_sku || o.sku || '—'}</TableCell>
                            <TableCell className="text-xs text-right">{o.quantity}</TableCell>
                            <TableCell className="text-xs text-right font-mono">
                              ${((o.sold_price || o.total_sale_amount || o.estimated_price || 0)).toFixed(2)}
                            </TableCell>
                            <TableCell className="text-xs">{o.price_source || '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    {issue.orders.length > 50 && (
                      <p className="text-xs text-muted-foreground px-2 py-1">…and {issue.orders.length - 50} more</p>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
