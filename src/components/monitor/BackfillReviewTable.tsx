import { useState, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Copy } from "lucide-react";
import { toast } from "sonner";

export interface BackfillPreviewRow {
  asin: string;
  sku: string;
  marketplace: string;
  minPrice: number;
  maxPrice: number;
  source: string;
  refPrice: number | null;
  currentPrice: number | null;
  unitCost: number | null;
  priceGap: number | null;
  needsReview: boolean;
  reviewReason: string | null;
}

interface BackfillReviewTableProps {
  rows: BackfillPreviewRow[];
}

const reviewReasonLabels: Record<string, string> = {
  missing_current_price: "No current live price found",
  min_above_current_price: "Suggested min is above current price",
};

const formatMoney = (value: number | null) => {
  if (value == null) return "—";
  return `$${value.toFixed(2)}`;
};

const copyAsin = (asin: string) => {
  navigator.clipboard.writeText(asin);
  toast.success(`Copied ${asin}`);
};

const copyAllAsins = (rows: BackfillPreviewRow[]) => {
  const asins = [...new Set(rows.map((r) => r.asin))].join(", ");
  navigator.clipboard.writeText(asins);
  toast.success(`Copied ${[...new Set(rows.map((r) => r.asin))].length} ASINs`);
};

export default function BackfillReviewTable({ rows }: BackfillReviewTableProps) {
  const [marketplaceFilter, setMarketplaceFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");

  const marketplaces = useMemo(() => {
    const set = new Set(rows.map((r) => r.marketplace || "US"));
    return ["ALL", ...Array.from(set).sort()];
  }, [rows]);

  const filtered = useMemo(() => {
    let result = rows;
    if (marketplaceFilter !== "ALL") {
      result = result.filter((r) => (r.marketplace || "US") === marketplaceFilter);
    }
    if (statusFilter === "REVIEW") {
      result = result.filter((r) => r.needsReview);
    } else if (statusFilter === "REVIEW_PRICED") {
      result = result.filter((r) => r.needsReview && r.reviewReason !== "missing_current_price");
    } else if (statusFilter === "SAFE") {
      result = result.filter((r) => !r.needsReview);
    } else if (statusFilter === "EXCLUDE_INACTIVE") {
      result = result.filter((r) => r.reviewReason !== "missing_current_price");
    }
    return result;
  }, [rows, marketplaceFilter, statusFilter]);

  if (rows.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h5 className="text-sm font-medium">ASIN Review List</h5>
        <div className="flex items-center gap-2">
          <Select value={marketplaceFilter} onValueChange={setMarketplaceFilter}>
            <SelectTrigger className="h-7 w-[110px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {marketplaces.map((mkt) => (
                <SelectItem key={mkt} value={mkt} className="text-xs">
                  {mkt === "ALL" ? `All (${rows.length})` : `${mkt} (${rows.filter((r) => (r.marketplace || "US") === mkt).length})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-7 w-[180px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL" className="text-xs">All status ({rows.length})</SelectItem>
              <SelectItem value="REVIEW" className="text-xs">⚠ Needs review ({rows.filter((r) => r.needsReview).length})</SelectItem>
              <SelectItem value="REVIEW_PRICED" className="text-xs">⚠ Review (has price) ({rows.filter((r) => r.needsReview && r.reviewReason !== "missing_current_price").length})</SelectItem>
              <SelectItem value="SAFE" className="text-xs">✓ Looks safe ({rows.filter((r) => !r.needsReview).length})</SelectItem>
              <SelectItem value="EXCLUDE_INACTIVE" className="text-xs">🚫 Hide no-price ({rows.filter((r) => r.reviewReason !== "missing_current_price").length})</SelectItem>
            </SelectContent>
          </Select>
          <button
            type="button"
            onClick={() => copyAllAsins(filtered)}
            className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium hover:bg-muted transition-colors border border-border text-muted-foreground hover:text-foreground"
            title="Copy all filtered ASINs"
          >
            <Copy className="h-3 w-3" />
            Copy All ASINs
          </button>
          <span className="text-[10px] text-muted-foreground">
            Showing {filtered.length} of {rows.length}
          </span>
        </div>
      </div>
      <Table containerClassName="max-h-[420px] rounded-md border bg-background">
        <TableHeader className="sticky top-0 z-10 bg-background shadow-sm">
          <TableRow>
            <TableHead>ASIN</TableHead>
            <TableHead>SKU</TableHead>
            <TableHead>Mkt</TableHead>
            <TableHead>Current</TableHead>
            <TableHead>Ref</TableHead>
            <TableHead>Cost</TableHead>
            <TableHead>Suggested Min</TableHead>
            <TableHead>Δ vs Current</TableHead>
            <TableHead>Suggested Max</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Source</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((row, index) => {
            const reason = row.reviewReason ? reviewReasonLabels[row.reviewReason] ?? row.reviewReason : null;

            return (
              <TableRow key={`${row.asin}-${row.sku}-${row.marketplace}-${index}`} className={row.needsReview ? "bg-destructive/5" : undefined}>
                <TableCell className="font-mono text-xs whitespace-nowrap">
                  <span className="inline-flex items-center gap-1">
                    {row.asin}
                    <button
                      type="button"
                      onClick={() => copyAsin(row.asin)}
                      className="inline-flex items-center justify-center rounded p-0.5 hover:bg-muted transition-colors"
                      title="Copy ASIN"
                    >
                      <Copy className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                    </button>
                  </span>
                </TableCell>
                <TableCell className="text-xs">{row.sku || "—"}</TableCell>
                <TableCell className="text-xs">{row.marketplace || "US"}</TableCell>
                <TableCell className="text-xs">{formatMoney(row.currentPrice)}</TableCell>
                <TableCell className="text-xs">{formatMoney(row.refPrice)}</TableCell>
                <TableCell className="text-xs">{formatMoney(row.unitCost)}</TableCell>
                <TableCell className="text-xs font-medium">{formatMoney(row.minPrice)}</TableCell>
                <TableCell className="text-xs">
                  {row.priceGap == null ? "—" : `${row.priceGap > 0 ? "+" : ""}$${row.priceGap.toFixed(2)}`}
                </TableCell>
                <TableCell className="text-xs">{formatMoney(row.maxPrice)}</TableCell>
                <TableCell>
                  <div className="space-y-1">
                    <Badge variant={row.needsReview ? "destructive" : "outline"} className="text-[10px]">
                      {row.needsReview ? "Check manually" : "Looks safe"}
                    </Badge>
                    {reason && <div className="text-[10px] text-muted-foreground">{reason}</div>}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-[10px]">
                    {row.source}
                  </Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
