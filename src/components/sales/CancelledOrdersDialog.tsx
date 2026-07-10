import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ExternalLink, XCircle, Package } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface CancelledOrder {
  order_id: string;
  asin: string;
  title: string | null;
  order_status: string;
  order_date: string;
  quantity: number;
  sold_price: number | null;
  marketplace: string | null;
  cancelled_at: string | null;
}

interface CancelledOrdersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  dateRange: { start: string; end: string };
  periodLabel: string;
}

// Map marketplace ID to Amazon domain
const getAmazonDomain = (marketplaceId: string | null): string => {
  const domains: Record<string, string> = {
    'ATVPDKIKX0DER': 'sellercentral.amazon.com', // US
    'A2EUQ1WTGCTBG2': 'sellercentral.amazon.ca', // CA
    'A1AM78C64UM0Y8': 'sellercentral.amazon.com.mx', // MX
    'A2Q3Y263D00KWC': 'sellercentral.amazon.com.br', // BR
    'A1PA6795UKMFR9': 'sellercentral.amazon.de', // DE
    'A1RKKUPIHCS9HS': 'sellercentral.amazon.es', // ES
    'A13V1IB3VIYBER': 'sellercentral.amazon.fr', // FR
    'A1F83G8C2ARO7P': 'sellercentral.amazon.co.uk', // UK
    'APJ6JRA9NG5V4': 'sellercentral.amazon.it', // IT
    'A1805IZSGTT6HS': 'sellercentral.amazon.nl', // NL
    'A1C3SOZRARQ6R3': 'sellercentral.amazon.pl', // PL
    'A2NODRKZP88ZB9': 'sellercentral.amazon.se', // SE
    'A1VC38T7YXB528': 'sellercentral.amazon.co.jp', // JP
    'A39IBJ37TRP1C6': 'sellercentral.amazon.com.au', // AU
    'A21TJRUUN4KGV': 'sellercentral.amazon.in', // IN
    'A19VAU5U5O7RUS': 'sellercentral.amazon.sg', // SG
    'A17E79C6D8DWNP': 'sellercentral.amazon.sa', // SA
    'A2VIGQ35RCS4UG': 'sellercentral.amazon.ae', // AE
    'ARBP9OOSHTCHU': 'sellercentral.amazon.eg', // EG
  };
  return domains[marketplaceId || 'ATVPDKIKX0DER'] || 'sellercentral.amazon.com';
};

const buildAmazonOrderUrl = (orderId: string, marketplaceId: string | null): string => {
  const domain = getAmazonDomain(marketplaceId);
  // Strip any -REFUND suffix for the URL
  const cleanOrderId = orderId.replace(/-REFUND(-\d+)?$/, '');
  return `https://${domain}/orders-v3/order/${cleanOrderId}`;
};

export default function CancelledOrdersDialog({
  open,
  onOpenChange,
  userId,
  dateRange,
  periodLabel,
}: CancelledOrdersDialogProps) {
  const [orders, setOrders] = useState<CancelledOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    
    const fetchOrders = async () => {
      setLoading(true);
      setError(null);
      
      try {
        const { data, error: fetchError } = await supabase
          .from("sales_orders")
          .select("order_id, asin, title, order_status, order_date, quantity, sold_price, marketplace, cancelled_at")
          .eq("user_id", userId)
          .gte("order_date", dateRange.start)
          .lte("order_date", dateRange.end)
          .or("is_cancelled.eq.true,order_status.eq.Canceled,order_status.eq.Cancelled")
          .order("order_date", { ascending: false })
          .limit(500);
        
        if (fetchError) throw fetchError;
        
        // Deduplicate by order_id (keep first occurrence)
        const seen = new Set<string>();
        const deduped = (data || []).filter(o => {
          const baseOrderId = o.order_id.replace(/-REFUND(-\d+)?$/, '');
          if (seen.has(baseOrderId)) return false;
          seen.add(baseOrderId);
          return true;
        });
        
        setOrders(deduped);
      } catch (err: any) {
        console.error("Error fetching cancelled orders:", err);
        setError(err.message || "Failed to fetch orders");
      } finally {
        setLoading(false);
      }
    };
    
    fetchOrders();
  }, [open, userId, dateRange.start, dateRange.end]);

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <XCircle className="h-5 w-5 text-destructive" />
            Cancelled Orders - {periodLabel}
          </DialogTitle>
          <DialogDescription>
            These orders were cancelled and excluded from your sales totals. 
            Click an order to view it in Seller Central.
          </DialogDescription>
        </DialogHeader>
        
        <div className="flex-1 min-h-0">
          {loading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : error ? (
            <div className="p-4 text-center text-destructive">
              <p>{error}</p>
              <Button 
                variant="outline" 
                size="sm" 
                className="mt-2"
                onClick={() => onOpenChange(false)}
              >
                Close
              </Button>
            </div>
          ) : orders.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <Package className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No cancelled orders in this period</p>
            </div>
          ) : (
            <ScrollArea className="h-[400px] pr-4">
              <div className="space-y-2">
                {orders.map((order, idx) => (
                  <a
                    key={`${order.order_id}-${idx}`}
                    href={buildAmazonOrderUrl(order.order_id, order.marketplace)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium truncate">
                          {order.order_id.replace(/-REFUND(-\d+)?$/, '')}
                        </span>
                        <span className="text-xs px-1.5 py-0.5 rounded bg-destructive/20 text-destructive">
                          Cancelled
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                        <span>{formatDate(order.order_date)}</span>
                        <span>•</span>
                        <span className="truncate max-w-[200px]" title={order.title || order.asin}>
                          {order.title || order.asin}
                        </span>
                        <span>•</span>
                        <span>Qty: {order.quantity || 1}</span>
                        {order.sold_price != null && order.sold_price > 0 && (
                          <>
                            <span>•</span>
                            <span>${order.sold_price.toFixed(2)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <ExternalLink className="h-4 w-4 text-muted-foreground group-hover:text-primary shrink-0 ml-2" />
                  </a>
                ))}
              </div>
              
              {orders.length >= 500 && (
                <p className="text-xs text-muted-foreground text-center mt-4">
                  Showing first 500 cancelled orders.
                </p>
              )}
            </ScrollArea>
          )}
        </div>
        
        <div className="flex justify-between items-center pt-4 border-t">
          <span className="text-sm text-muted-foreground">
            {orders.length} cancelled order{orders.length !== 1 ? 's' : ''}
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
