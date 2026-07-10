import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import type { AnalyzerSnapshot } from "@/hooks/use-analyzer-snapshot";

interface Props {
  snap: AnalyzerSnapshot;
  costPrice: number;
  feeRate?: number; // kept for backwards compat — NO LONGER USED (extension parity)
  liveReferralFee?: number | null;
  liveFbaFee?: number | null;
  liveClosingFee?: number | null;
  liveRefPrice?: number | null;
  currencySymbol?: string;
}

export default function OffersTable({
  snap, costPrice,
  liveReferralFee, liveFbaFee, liveClosingFee, liveRefPrice,
  currencySymbol = "$",
}: Props) {

  const rows = snap.offers.slice(0, 20);
  // Mirror extension/panel.js (lines 705-738) EXACTLY:
  // - Require real SP-API fees (referral + fba). NEVER fall back to a flat %.
  // - Treat every seller as FBA for ROI (add fbaFee + closing to every row).
  // When fees are unavailable, show "—" — matches what the extension does.
  const feesAvailable =
    Number.isFinite(liveReferralFee as number) && (liveReferralFee as number) > 0 &&
    Number.isFinite(liveFbaFee as number) && (liveFbaFee as number) >= 0;
  const refRate =
    feesAvailable && liveRefPrice && liveRefPrice > 0
      ? Math.min(0.45, (liveReferralFee as number) / liveRefPrice)
      : null;
  const fbaFee = feesAvailable ? (Number(liveFbaFee) || 0) : 0;
  const closing = feesAvailable ? (Number(liveClosingFee) || 0) : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Offers</CardTitle>
          <div className="text-xs text-muted-foreground">
            Total {snap.computed.totalOffers} · FBA {snap.computed.fbaOffers} · FBM {snap.computed.fbmOffers}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Seller</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Stock</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Profit</TableHead>
              <TableHead>ROI</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-4">No offers</TableCell></TableRow>
            )}
            {rows.map((o) => {
              const price = o.price ?? 0;
              // EXTENSION PARITY: only compute when real SP-API fees are present.
              // Otherwise show "—" (no flat-% guessing).
              const canCompute = refRate != null && feesAvailable && price > 0 && costPrice > 0;
              const sellerFees = canCompute ? price * (refRate as number) + fbaFee + closing : 0;
              const profit = canCompute ? price - sellerFees - costPrice : null;
              const roi = canCompute ? ((profit as number) / costPrice) * 100 : null;
              const sellerLabel = o.sellerName || o.sellerId || "—";
              return (
                <TableRow key={o.rank} className={o.isSelf ? "bg-emerald-50 dark:bg-emerald-950/30" : undefined}>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      {o.rank}
                      {o.isBuyBoxWinner && <Badge variant="default" className="text-[10px] px-1 py-0">BB</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[200px]">
                    <div className="flex items-center gap-1 truncate" title={sellerLabel}>
                      {o.isAmazon && <Badge variant="destructive" className="text-[10px] px-1 py-0">AMZ</Badge>}
                      {o.isSelf && <Badge className="text-[10px] px-1 py-0 bg-emerald-600 hover:bg-emerald-600">YOU</Badge>}
                      {o.sellerId ? (
                        <Link
                          to={`/tools/seller-analyzer?sellerId=${o.sellerId}&marketplace=${snap.marketplace}`}
                          className="truncate text-xs text-primary hover:underline"
                          title="View seller storefront analysis"
                        >
                          {sellerLabel}
                        </Link>
                      ) : (
                        <span className="truncate text-xs">{sellerLabel}</span>
                      )}
                      {o.sellerId && (
                        <a
                          href={`https://www.amazon.com/s?i=merchant-items&me=${o.sellerId}&marketplaceID=ATVPDKIKX0DER`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-muted-foreground hover:text-primary"
                          title="Open storefront on Amazon"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={o.type === "FBA" ? "default" : "secondary"}>{o.type}</Badge>
                  </TableCell>
                  <TableCell>{o.stock != null ? o.stock : "—"}</TableCell>
                  <TableCell className="font-medium">{currencySymbol}{price.toFixed(2)}</TableCell>
                  <TableCell className={profit == null ? "text-muted-foreground" : profit > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                    {profit == null ? "—" : `${currencySymbol}${profit.toFixed(2)}`}
                  </TableCell>

                  <TableCell className={roi == null ? "text-muted-foreground" : roi >= 30 ? "text-emerald-600 dark:text-emerald-400" : roi >= 15 ? "text-amber-600 dark:text-amber-400" : "text-rose-600 dark:text-rose-400"}>
                    {roi == null ? "—" : `${roi.toFixed(0)}%`}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
