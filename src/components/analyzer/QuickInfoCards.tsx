import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AnalyzerSnapshot } from "@/hooks/use-analyzer-snapshot";

interface Props {
  snap: AnalyzerSnapshot;
  costPrice: number;
  salePrice: number;
  onCostChange: (v: number) => void;
  onSaleChange: (v: number) => void;
  profit: number;
  roi: number;
  maxCost: number;
  currencySymbol?: string;
  currency?: string;
  fxRate?: number;
  costInMarket?: number;
}


function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: "good" | "warn" | "bad" }) {
  const tone =
    accent === "good" ? "text-emerald-600 dark:text-emerald-400" :
    accent === "warn" ? "text-amber-600 dark:text-amber-400" :
    accent === "bad" ? "text-rose-600 dark:text-rose-400" : "text-foreground";
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`text-lg font-semibold mt-1 ${tone}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

export default function QuickInfoCards({
  snap, costPrice, salePrice, onCostChange, onSaleChange, profit, roi, maxCost,
  currencySymbol = "$", currency = "USD", fxRate = 1, costInMarket,
}: Props) {
  const q = snap.quickInfo;
  const roiTone = roi >= 30 ? "good" : roi >= 15 ? "warn" : "bad";
  const showFx = currency !== "USD" && fxRate !== 1 && costPrice > 0;
  const costNative = costInMarket != null ? costInMarket : costPrice * fxRate;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
      <Stat label="Eligible" value={q.eligible == null ? "Unknown" : q.eligible ? "Yes" : "No"} accent={q.eligible === false ? "bad" : "good"} />
      <Stat label="Alerts" value={q.alertsCount} accent={q.alertsCount > 2 ? "warn" : "good"} />
      <Stat label="BSR" value={q.bsr ? `${(q.bsr / 1000).toFixed(0)}k${q.bsrTopPercent ? ` (${q.bsrTopPercent}%)` : ""}` : "—"} />
      <Stat label="Est. Sales" value={q.estimatedSales} />
      <Stat label={`Max Cost (${currency})`} value={`${currencySymbol}${maxCost.toFixed(2)}`} accent="good" />
      <Card>
        <CardContent className="p-3">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Cost Price (USD)</Label>
          <Input
            type="number"
            step="0.01"
            value={costPrice || ""}
            onChange={(e) => onCostChange(parseFloat(e.target.value) || 0)}
            className="h-8 mt-1"
          />
          {showFx && (
            <div className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">
              ≈ {currencySymbol}{costNative.toFixed(2)} {currency}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-3">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Sale Price ({currency})</Label>
          <Input
            type="number"
            step="0.01"
            value={salePrice || ""}
            onChange={(e) => onSaleChange(parseFloat(e.target.value) || 0)}
            className="h-8 mt-1"
          />
        </CardContent>
      </Card>
      <Stat label={`Profit (${currency})`} value={`${currencySymbol}${profit.toFixed(2)}`} accent={profit > 0 ? "good" : "bad"} />
      <Stat label="ROI" value={`${roi.toFixed(2)}%`} accent={roiTone} />
    </div>
  );
}

