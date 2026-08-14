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
import { RefreshCw, TrendingUp, TrendingDown, Info, AlertTriangle, DollarSign, ShoppingCart, Target, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

interface ProfileResult {
  smart_profile: string;
  buybox: { winning: number; losing: number; unknown: number; win_rate_pct: number | null };
  units_per_day: number;
  revenue_per_day: number;
  profit_per_day: number;
  roi_pct: number | null;
  avg_selling_price: number | null;
  raises: {
    submitted: number; checked: number; lost_bb_after: number; lost_bb_after_pct: number | null; no_snapshot_data: number;
    attempted: number; blocked_by_cooldown: number; rejected_floor_support: number;
  };
  order_count: number;
}

interface ApiResponse {
  window_days: number;
  results: ProfileResult[];
  raises_checked: number;
  raises_check_capped_at: number;
  momentum_smart_v2_cutover?: string;
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
  MOMENTUM_SMART_V1: "Momentum Smart V1",
  MOMENTUM_SMART_V2: "Momentum Smart V2",
  CUSTOM: "Custom",
};

const isMomentumSmart = (profile: string) => profile.startsWith("MOMENTUM_SMART");

const fmtMoney = (v: number | null) => v == null ? "—" : `$${v.toFixed(2)}`;
const fmtPct = (v: number | null) => v == null ? "—" : `${v.toFixed(1)}%`;
const fmtNum = (v: number) => v.toFixed(1);

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

  const results = [...(data?.results || [])].sort((a, b) => b.order_count - a.order_count);
  const momentumSmartV2 = results.find((r) => r.smart_profile === "MOMENTUM_SMART_V2");
  const momentumSmartV1 = results.find((r) => r.smart_profile === "MOMENTUM_SMART_V1");

  const rowClass = (profile: string) => isMomentumSmart(profile) ? "bg-primary/5" : undefined;
  const nameCell = (r: ProfileResult) => (
    <TableCell className="font-medium">
      {PROFILE_LABELS[r.smart_profile] || r.smart_profile}
      <div className="text-xs text-muted-foreground">{r.order_count} orders</div>
    </TableCell>
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Per-Preset Performance</CardTitle>
            <CardDescription>
              Is Momentum Smart increasing sales while preserving profit, and is V2 reducing the risk of unnecessary raises? Grouped by which repricer preset each listing is currently on.
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

      {(momentumSmartV1 || momentumSmartV2) && (
        <Card className="border-primary/40 bg-primary/5">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              Momentum Smart V1 vs V2: is the tightened raise gate working?
            </CardTitle>
            <CardDescription>
              V2 (floor-support ratio ≥ 50% + 2h post-raise cooldown) went live {data?.momentum_smart_v2_cutover ? new Date(data.momentum_smart_v2_cutover).toLocaleString() : "recently"}. Buy Box win rate is always shown under V2 — it's a live snapshot of current behavior, not a historical trend, so it can't be split by day.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: "V1 (before)", r: momentumSmartV1 },
                { label: "V2 (after)", r: momentumSmartV2 },
              ].map(({ label, r }) => (
                <div key={label} className="rounded-lg border p-4 space-y-3">
                  <div className="text-sm font-semibold">{label}</div>
                  {!r ? (
                    <div className="text-xs text-muted-foreground">No data in this window.</div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <div className="text-muted-foreground text-xs">Raise attempts</div>
                        <div className="text-lg font-semibold">{r.raises.attempted}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground text-xs">Blocked (cooldown)</div>
                        <div className="text-lg font-semibold">{r.raises.blocked_by_cooldown}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground text-xs">Rejected (floor support)</div>
                        <div className="text-lg font-semibold">{r.raises.rejected_floor_support}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground text-xs">Raise → lost BB</div>
                        <div className="text-lg font-semibold flex items-center gap-1.5">
                          {r.raises.checked === 0 ? "—" : `${r.raises.lost_bb_after}/${r.raises.checked}`}
                          {r.raises.lost_bb_after_pct != null && (
                            r.raises.lost_bb_after_pct <= 15
                              ? <Badge variant="outline" className="text-emerald-600 border-emerald-400/50">safe</Badge>
                              : <Badge variant="outline" className="text-amber-600 border-amber-400/50">watch</Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  {r && r.raises.checked > 0 && r.raises.checked < 20 && (
                    <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                      <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      Only {r.raises.checked} raises had enough snapshot data — too little runtime to trust this % yet.
                    </p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><ShoppingCart className="h-4 w-4" /> Sales</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Preset</TableHead>
                  <TableHead className="text-right">Units/day</TableHead>
                  <TableHead className="text-right">Revenue/day</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.length === 0 && !loading && (
                  <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground py-8">No data in this window.</TableCell></TableRow>
                )}
                {results.map((r) => (
                  <TableRow key={r.smart_profile} className={rowClass(r.smart_profile)}>
                    {nameCell(r)}
                    <TableCell className="text-right">{fmtNum(r.units_per_day)}</TableCell>
                    <TableCell className="text-right">{fmtMoney(r.revenue_per_day)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><DollarSign className="h-4 w-4" /> Profitability</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Preset</TableHead>
                  <TableHead className="text-right">Profit/day</TableHead>
                  <TableHead className="text-right">ROI</TableHead>
                  <TableHead className="text-right">Avg selling price</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.length === 0 && !loading && (
                  <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-8">No data in this window.</TableCell></TableRow>
                )}
                {results.map((r) => (
                  <TableRow key={r.smart_profile} className={rowClass(r.smart_profile)}>
                    {nameCell(r)}
                    <TableCell className={`text-right ${r.profit_per_day < 0 ? "text-destructive" : ""}`}>
                      <span className="inline-flex items-center gap-1">
                        {r.profit_per_day < 0 ? <TrendingDown className="h-3 w-3" /> : null}
                        {fmtMoney(r.profit_per_day)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{fmtPct(r.roi_pct)}</TableCell>
                    <TableCell className="text-right">{fmtMoney(r.avg_selling_price)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Target className="h-4 w-4" /> Buy Box</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Preset</TableHead>
                  <TableHead className="text-right">Winning</TableHead>
                  <TableHead className="text-right">Losing</TableHead>
                  <TableHead className="text-right">Win rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.length === 0 && !loading && (
                  <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground py-8">No data in this window.</TableCell></TableRow>
                )}
                {results.map((r) => (
                  <TableRow key={r.smart_profile} className={rowClass(r.smart_profile)}>
                    {nameCell(r)}
                    <TableCell className="text-right">{r.buybox.winning}</TableCell>
                    <TableCell className="text-right">{r.buybox.losing}</TableCell>
                    <TableCell className="text-right">{fmtPct(r.buybox.win_rate_pct)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Raise safety</CardTitle>
          <CardDescription>
            "Attempted / blocked / rejected" only apply to Momentum Smart — its V2 gates are the only ones in the system today. Every preset's submitted raises are still checked for a subsequent Buy Box loss.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Preset</TableHead>
                  <TableHead className="text-right">Submitted raises</TableHead>
                  <TableHead className="text-right">Raise → lost BB</TableHead>
                  <TableHead className="text-right">Attempted</TableHead>
                  <TableHead className="text-right">Blocked (cooldown)</TableHead>
                  <TableHead className="text-right">Rejected (floor support)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.length === 0 && !loading && (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No data in this window.</TableCell></TableRow>
                )}
                {results.map((r) => (
                  <TableRow key={r.smart_profile} className={rowClass(r.smart_profile)}>
                    {nameCell(r)}
                    <TableCell className="text-right">{r.raises.submitted}</TableCell>
                    <TableCell className="text-right">
                      {r.raises.submitted === 0 ? "—" : `${r.raises.lost_bb_after}/${r.raises.checked} (${fmtPct(r.raises.lost_bb_after_pct)})`}
                    </TableCell>
                    <TableCell className="text-right">{isMomentumSmart(r.smart_profile) ? r.raises.attempted : "—"}</TableCell>
                    <TableCell className="text-right">{isMomentumSmart(r.smart_profile) ? r.raises.blocked_by_cooldown : "—"}</TableCell>
                    <TableCell className="text-right">{isMomentumSmart(r.smart_profile) ? r.raises.rejected_floor_support : "—"}</TableCell>
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
