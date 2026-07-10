import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface Props {
  costPrice: number;
  salePrice: number;
  feeRate: number;
  onCostChange: (v: number) => void;
  onSaleChange: (v: number) => void;
  onFeeRateChange: (v: number) => void;
  currencySymbol?: string;
  currency?: string;
  fxRate?: number;
  costInMarket?: number;
}


export interface CalcResult {
  profit: number;
  roi: number;
  margin: number;
  totalFees: number;
  amazonPayout: number;
  breakeven: number;
  maxCost: number;
}

export function computeCalc(cost: number, sale: number, feeRate: number, fulfillment: "FBA" | "FBM", storageMonths: number, qty: number): CalcResult {
  const fees = sale * feeRate + (fulfillment === "FBA" ? 0.10 * storageMonths : 0);
  const profit = (sale - fees - cost) * qty;
  const roi = cost > 0 ? ((sale - fees - cost) / cost) * 100 : 0;
  const margin = sale > 0 ? ((sale - fees - cost) / sale) * 100 : 0;
  const amazonPayout = sale - fees;
  const breakeven = cost + fees;
  // Max cost for 15% target ROI
  const maxCost = (sale - fees) / 1.15;
  return { profit, roi, margin, totalFees: fees, amazonPayout, breakeven, maxCost };
}

export default function ProfitCalculator({
  costPrice, salePrice, feeRate, onCostChange, onSaleChange, onFeeRateChange,
  currencySymbol = "$", currency = "USD", fxRate = 1, costInMarket,
}: Props) {
  const [fulfillment, setFulfillment] = useState<"FBA" | "FBM">("FBA");
  const [storage, setStorage] = useState(0);
  const [qty, setQty] = useState(1);

  const costForCalc = costInMarket != null ? costInMarket : costPrice * fxRate;
  const showFx = currency !== "USD" && fxRate !== 1 && costPrice > 0;

  const calc = useMemo(
    () => computeCalc(costForCalc, salePrice, feeRate, fulfillment, storage, qty),
    [costForCalc, salePrice, feeRate, fulfillment, storage, qty],
  );
  const sym = currencySymbol;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Profit Calculator{currency !== "USD" ? ` · ${currency}` : ""}</CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <div>
            <Label className="text-xs">Cost Price (USD)</Label>
            <Input type="number" step="0.01" value={costPrice || ""} onChange={(e) => onCostChange(parseFloat(e.target.value) || 0)} className="h-8" />
            {showFx && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                ≈ {sym}{costForCalc.toFixed(2)} {currency} @ 1 USD = {fxRate.toFixed(4)}
              </p>
            )}
          </div>
          <div>
            <Label className="text-xs">Sale Price ({currency})</Label>
            <Input type="number" step="0.01" value={salePrice || ""} onChange={(e) => onSaleChange(parseFloat(e.target.value) || 0)} className="h-8" />
          </div>
          <div>
            <Label className="text-xs">Fulfillment</Label>
            <Tabs value={fulfillment} onValueChange={(v) => setFulfillment(v as "FBA" | "FBM")}>
              <TabsList className="h-8">
                <TabsTrigger value="FBA" className="text-xs h-6">FBA</TabsTrigger>
                <TabsTrigger value="FBM" className="text-xs h-6">FBM</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Storage (months)</Label>
              <Input type="number" step="1" value={storage} onChange={(e) => setStorage(parseFloat(e.target.value) || 0)} className="h-8" />
            </div>
            <div>
              <Label className="text-xs">Quantity</Label>
              <Input type="number" step="1" value={qty} onChange={(e) => setQty(parseFloat(e.target.value) || 1)} className="h-8" />
            </div>
          </div>
          <div>
            <Label className="text-xs">Fee rate (estimated)</Label>
            <Input type="number" step="0.01" value={feeRate} onChange={(e) => onFeeRateChange(parseFloat(e.target.value) || 0)} className="h-8" />
            <p className="text-[11px] text-muted-foreground mt-1">Default 0.30 (30%) — referral + FBA combined estimate.</p>
          </div>
        </div>
        <div className="space-y-1.5 text-sm">
          <Row label="Profit" value={`${sym}${calc.profit.toFixed(2)}`} tone={calc.profit > 0 ? "good" : "bad"} />
          <Row label="ROI" value={`${calc.roi.toFixed(2)}%`} tone={calc.roi >= 30 ? "good" : calc.roi >= 15 ? "warn" : "bad"} />
          <Row label="Profit Margin" value={`${calc.margin.toFixed(2)}%`} />
          <Row label="Total Fees" value={`${sym}${calc.totalFees.toFixed(2)}`} />
          <Row label="Estimated Amazon Payout" value={`${sym}${calc.amazonPayout.toFixed(2)}`} />
          <Row label="Breakeven Sale Price" value={`${sym}${calc.breakeven.toFixed(2)}`} />
          <Row label="Maximum Cost (≥15% ROI)" value={`${sym}${calc.maxCost.toFixed(2)}`} tone="good" />
        </div>
      </CardContent>
    </Card>
  );
}


function Row({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  const c = tone === "good" ? "text-emerald-600 dark:text-emerald-400" : tone === "warn" ? "text-amber-600 dark:text-amber-400" : tone === "bad" ? "text-rose-600 dark:text-rose-400" : "";
  return (
    <div className="flex items-center justify-between border-b last:border-0 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium ${c}`}>{value}</span>
    </div>
  );
}
