import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Store } from "lucide-react";
import type { SellerStore } from "@/hooks/use-seller-snapshot";

export default function StoreDetailsCard({ store, marketplace }: { store: SellerStore; marketplace: string }) {
  const url = `https://www.amazon.com/s?i=merchant-items&me=${store.sellerId}&marketplaceID=ATVPDKIKX0DER`;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Store className="h-5 w-5 text-primary" /> Store Details
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat label="Seller Name" value={store.sellerName} />
          <Stat label="Seller ID" value={store.sellerId} mono />
          <Stat
            label="Rating"
            value={store.rating != null ? `${store.rating}% (${store.ratingCount ?? 0})` : "—"}
          />
          <Stat label="ASIN Count" value={store.totalAsins.toLocaleString()} />
        </div>
        <div className="flex items-center gap-2 mt-4">
          {store.hasFBA && <Badge variant="secondary">Has FBA</Badge>}
          {store.isScammer && <Badge variant="destructive">Flagged</Badge>}
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            Open storefront on Amazon <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          ASIN, brand and category counts are a guide and not exact.
        </p>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}
