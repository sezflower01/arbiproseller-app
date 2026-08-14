import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { RefreshCw, TrendingUp, TrendingDown, Info, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface ProfileResult {
  smart_profile: string;
  buybox: { winning: number; losing: number; unknown: number; win_rate_pct: number | null };
  units_per_day: number;
  revenue_per_day: number;
  profit_per_day: number;
  roi_pct: number | null;
  avg_selling_price: number | null;
  raises: { total: number; checked: number; lost_bb_after: number; lost_bb_after_pct: number | null; no_snapshot_data: number };
  order_count: number;
}

interface ApiResponse {
  window_days: number;
  results: ProfileResult[];
  raises_checked: number;
  raises_check_capped_at: number;
  methodology_note: string;
  error?: string;
}

const PROFILE_LABELS: Record<string, string> = {
  VELOCITY_DOMINATOR: "Aggressive Capture",
  MOMENTUM_BUILDER: "Momentum Builder",
  PROFIT_EXTRACTOR: "Profit Extractor",
  MATCH_BUYBOX: "Match Buy Box",
  MATCH_LOWEST: "Match Lowest",
  SMART_MATCH: "Smart Match",
  MOMENTUM_SMART: "Momentum Smart",
  CUSTOM: "Custom",
};

const fmtMoney = (v: number | null) => v == null ? "—" : `$${v.toFixed(2)}`;
const fmtPct = (v: number | null) => v == null ? "—" : `${v.toFixed(1)}%`;

export default function RulePerformancePanel() {
  const [days, setDays] = useState("30");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) throw new Error("Not signed in");
      const resp = await supabase.functions.invoke("repricer-rule-performance", {
        body: { days: Number(days) },
      });
      if (resp.error) throw new Error(resp.error.message || "Request failed");
      const body = resp.data as ApiResponse;
      if (body?.error) throw new Error(body.error);
      setData(body);
    } catch (e: any) {
      setError(e?.message || "Failed to load");
      toast.error("Failed to load rule performance: " + (e?.message || "unknown error"));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const results = data?.results || [];
  // Highlight the hybrid preset specifically, if present -- that's what this
  // page was built to monitor.
  const momentumSmart = results.find((r) => r.smart_profile === "MOMENTUM_SMART");

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Per-Preset Performance</CardTitle>
            <CardDescription>
              Buy Box %, units/revenue/profit per day, ROI, ASP, and raise safety — grouped by which repricer preset (smart_profile) each listing is currently on.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="7">7 days</SelectItem>
                <SelectItem value="14">14 days</SelectItem>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="60">60 days</SelectItem>
                <SelectItem value="90">90 days</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
      </Card>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 flex items-center gap-2 text-destructive text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </CardContent>
        </Card>
      )}

      {momentumSmart && (
        <Card className="border-primary/40 bg-primary/5">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              Momentum Smart: is the market-supported raise gate working?
            </CardTitle>
            <CardDescription>
              The hybrid preset is designed to raise ASP without materially increasing Buy Box losses. Below is what actually happened.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-muted-foreground text-xs">Avg selling price</div>
                <div className="text-xl font-semibold">{fmtMoney(momentumSmart.avg_selling_price)}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Buy Box win rate</div>
                <div className="text-xl font-semibold">{fmtPct(momentumSmart.buybox.win_rate_pct)}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Raises checked</div>
                <div className="text-xl font-semibold">{momentumSmart.raises.checked} / {momentumSmart.raises.total}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Raises that lost BB after</div>
                <div className="text-xl font-semibold flex items-center gap-1.5">
                  {fmtPct(momentumSmart.raises.lost_bb_after_pct)}
                  {momentumSmart.raises.lost_bb_after_pct != null && (
                    momentumSmart.raises.lost_bb_after_pct <= 15
                      ? <Badge variant="outline" className="text-emerald-600 border-emerald-400/50">looks safe</Badge>
                      : <Badge variant="outline" className="text-amber-600 border-amber-400/50">worth watching</Badge>
                  )}
                </div>
              </div>
            </div>
            {momentumSmart.raises.checked < 20 && (
              <p className="text-xs text-muted-foreground mt-4 flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5 shrink-0" />
                Only {momentumSmart.raises.checked} raises had enough snapshot data to check — this preset needs more real runtime before the raise-safety number is meaningful.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-6">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Preset</TableHead>
                  <TableHead className="text-right">BB Win %</TableHead>
                  <TableHead className="text-right">Units/day</TableHead>
                  <TableHead className="text-right">Revenue/day</TableHead>
                  <TableHead className="text-right">Profit/day</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                  <TableHead className="text-right">Avg price</TableHead>
                  <TableHead className="text-right">Raises → lost BB</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.length === 0 && !loading && (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">No data in this window.</TableCell></TableRow>
                )}
                {results
                  .sort((a, b) => b.order_count - a.order_count)
                  .map((r) => (
                    <TableRow key={r.smart_profile} className={r.smart_profile === "MOMENTUM_SMART" ? "bg-primary/5" : undefined}>
                      <TableCell className="font-medium">
                        {PROFILE_LABELS[r.smart_profile] || r.smart_profile}
                        <div className="text-xs text-muted-foreground">{r.order_count} orders</div>
                      </TableCell>
                      <TableCell className="text-right">{fmtPct(r.buybox.win_rate_pct)}</TableCell>
                      <TableCell className="text-right">{r.units_per_day.toFixed(1)}</TableCell>
                      <TableCell className="text-right">{fmtMoney(r.revenue_per_day)}</TableCell>
                      <TableCell className={`text-right ${r.profit_per_day < 0 ? "text-destructive" : ""}`}>
                        <span className="inline-flex items-center gap-1">
                          {r.profit_per_day < 0 ? <TrendingDown className="h-3 w-3" /> : null}
                          {fmtMoney(r.profit_per_day)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">{fmtPct(r.roi_pct)}</TableCell>
                      <TableCell className="text-right">{fmtMoney(r.avg_selling_price)}</TableCell>
                      <TableCell className="text-right">
                        {r.raises.total === 0 ? "—" : `${r.raises.lost_bb_after}/${r.raises.checked} (${fmtPct(r.raises.lost_bb_after_pct)})`}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {data?.methodology_note && (
        <p className="text-xs text-muted-foreground flex items-start gap-1.5">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          {data.methodology_note}
        </p>
      )}
    </div>
  );
}
