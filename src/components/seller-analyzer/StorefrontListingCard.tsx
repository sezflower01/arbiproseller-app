import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExternalLink, BarChart3 } from "lucide-react";
import { Link } from "react-router-dom";
import type { SellerProductCard } from "@/hooks/use-seller-snapshot";

export default function StorefrontListingCard({ p, marketplace }: { p: SellerProductCard; marketplace: string }) {
  const fmt = (n: number | null | undefined, d = 2) => (n != null ? `$${n.toFixed(d)}` : "—");
  // Rough max-cost: 30% fees, 30% target ROI -> price * 0.7 / 1.3
  const anchor = p.buyBox ?? p.newPrice ?? 0;
  const maxCost = anchor > 0 ? +(anchor * 0.7 / 1.3 - 1).toFixed(2) : null;
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4">
        <div className="flex gap-3">
          {p.image ? (
            <img
              src={p.image}
              alt={p.title}
              className="min-w-12 min-h-12 w-12 h-12 object-cover rounded border"
              loading="lazy"
            />
          ) : (
            <div className="min-w-12 min-h-12 w-12 h-12 rounded bg-muted" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <div className="text-2xl font-bold">{fmt(anchor)}</div>
              <div className="text-xs text-muted-foreground">{p.reviewCount ?? 0} reviews</div>
            </div>
            <div className="text-sm font-medium line-clamp-2">{p.title}</div>
            <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
              <span>ASIN: <span className="font-mono">{p.asin}</span></span>
              {p.upc && <span>UPC: <span className="font-mono">{p.upc}</span></span>}
              <span>Cat: {p.category}</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
          <Stat label="BSR" value={p.bsr ? `${(p.bsr / 1000).toFixed(0)}k` : "—"} />
          <Stat label="Est. Sales" value={p.estSales} />
          <Stat label="Max Cost" value={maxCost != null ? `$${maxCost.toFixed(2)}` : "—"} accent={maxCost != null && maxCost > 0 ? "good" : "bad"} />
          <Stat label="Offers" value={`${p.offers ?? "—"}`} />
          <Stat label="FBA / FBM" value={`${p.fbaOffers} / ${p.fbmOffers}`} />
          <Stat label="Buy Box" value={p.buyBox ? fmt(p.buyBox) : "NBB"} accent={p.buyBox ? undefined : "bad"} />
        </div>

        <div className="mt-3">
          <div className="text-xs font-semibold mb-1 flex items-center justify-between">
            <span>Top {Math.min(5, p.topOffers.length)} Offers</span>
            <span>Store stock: <span className="font-semibold">{p.storeStock ?? "—"}</span></span>
          </div>
          <div className="rounded border divide-y text-xs">
            <div className="grid grid-cols-12 px-2 py-1 bg-muted/40 font-medium">
              <div className="col-span-1">#</div>
              <div className="col-span-5">Seller</div>
              <div className="col-span-3 text-right">Price</div>
              <div className="col-span-3 text-right">Stock</div>
            </div>
            {p.topOffers.length === 0 && (
              <div className="px-2 py-2 text-muted-foreground text-center">No live offers</div>
            )}
            {p.topOffers.map((o, i) => (
              <div key={i} className="grid grid-cols-12 px-2 py-1 items-center">
                <div className="col-span-1">{i + 1}</div>
                <div className="col-span-5 flex items-center gap-1">
                  {o.sellerId ? (
                    <Link to={`/tools/seller-analyzer?sellerId=${o.sellerId}&marketplace=${marketplace}`} className="text-primary hover:underline truncate">
                      {o.sellerId}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                  <Badge variant={o.isFBA ? "default" : "secondary"} className="text-[10px] px-1 py-0">{o.isFBA ? "FBA" : "FBM"}</Badge>
                </div>
                <div className="col-span-3 text-right tabular-nums">${o.price.toFixed(2)}</div>
                <div className="col-span-3 text-right tabular-nums">{o.stock ?? "—"}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 mt-3">
          <Button asChild size="sm" variant="outline" className="h-8">
            <a href={`https://www.amazon.com/dp/${p.asin}`} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5 mr-1" /> Open ASIN
            </a>
          </Button>
          <Button asChild size="sm" className="h-8">
            <Link to={`/tools/product-analyzer?asin=${p.asin}&marketplace=${marketplace}`}>
              <BarChart3 className="h-3.5 w-3.5 mr-1" /> Full Analysis
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: "good" | "bad" }) {
  return (
    <div className="rounded bg-muted/40 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold ${accent === "good" ? "text-emerald-600 dark:text-emerald-400" : accent === "bad" ? "text-rose-600 dark:text-rose-400" : ""}`}>
        {value}
      </div>
    </div>
  );
}
