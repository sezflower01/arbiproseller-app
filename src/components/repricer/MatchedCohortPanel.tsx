import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { RefreshCw, AlertTriangle, Info, GitCompare } from "lucide-react";
import { toast } from "sonner";

interface WindowSummary {
  asin?: string;
  marketplace?: string;
  profile: string;
  n_asins?: number;
  asins?: string[];
  window: { start: string | null; end: string | null; n_days: number };
  sample_size: { n_orders: number; n_decisions: number; n_bb_snapshots: number; n_raises_submitted: number };
  units_per_day: number | null;
  revenue_per_day: number | null;
  profit_per_day: number | null;
  roi_pct: number | null;
  avg_selling_price: number | null;
  buybox_win_rate_pct: number | null;
  raise_attempts: number;
  raise_blocked_cooldown: number;
  raise_rejected_floor_support: number;
  raise_to_bb_loss_rate_pct: number | null;
  raises_checked: number;
}

interface SameAsinComparison {
  asin: string;
  marketplace: string;
  windows: WindowSummary[];
}

interface MatchedCohortComparison {
  cohort: string;
  profiles: WindowSummary[];
}

interface ApiResponse {
  window_days: number;
  momentum_smart_v2_cutover: string;
  same_asin_comparisons: SameAsinComparison[];
  matched_cohort_comparisons: MatchedCohortComparison[];
  excluded: {
    windows_below_min_days: number;
    min_days_threshold: number;
    unattributed_orders: number;
    unattributed_raises: number;
    raises_checked_capped_at?: number;
    rule_ids_skipped_timeout: { rule_id: string; smart_profile: string | null }[];
    cohort_note: string | null;
  };
  methodology_note: string;
  error?: string;
}

const PROFILE_LABELS: Record<string, string> = {
  MOMENTUM_BUILDER: "Momentum Builder",
  SMART_MATCH: "Smart Match",
  MOMENTUM_SMART_V1: "Momentum Smart V1",
  MOMENTUM_SMART_V2: "Momentum Smart V2",
};

const fmtMoney = (v: number | null) => v == null ? "—" : `$${v.toFixed(2)}`;
const fmtPct = (v: number | null) => v == null ? "—" : `${v.toFixed(1)}%`;
const fmtCohort = (key: string) => key.split("|").map((part) => {
  const [dim, tier] = part.split("_").length > 2 ? [part.split("_").slice(0, -1).join("_"), part.split("_").slice(-1)[0]] : part.split("_");
  return `${dim} ${tier}`;
}).join(", ");

function WindowRow({ w, label }: { w: WindowSummary; label: string }) {
  return (
    <TableRow>
      <TableCell className="font-medium">
        {label}
        <div className="text-xs text-muted-foreground">
          {w.window.start} → {w.window.end} ({w.window.n_days} {w.n_asins ? "ASIN-days" : "days"})
        </div>
      </TableCell>
      <TableCell className="text-right">{w.units_per_day ?? "—"}</TableCell>
      <TableCell className="text-right">{fmtMoney(w.revenue_per_day)}</TableCell>
      <TableCell className="text-right">{fmtMoney(w.profit_per_day)}</TableCell>
      <TableCell className="text-right">{fmtPct(w.roi_pct)}</TableCell>
      <TableCell className="text-right">{fmtMoney(w.avg_selling_price)}</TableCell>
      <TableCell className="text-right">{fmtPct(w.buybox_win_rate_pct)}</TableCell>
      <TableCell className="text-right">{w.raise_attempts}</TableCell>
      <TableCell className="text-right">
        {w.raises_checked === 0 ? "—" : `${fmtPct(w.raise_to_bb_loss_rate_pct)} (n=${w.raises_checked})`}
      </TableCell>
    </TableRow>
  );
}

export default function MatchedCohortPanel() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await supabase.functions.invoke("repricer-matched-cohort", { body: { days: 30 } });
      if (resp.error) throw new Error(resp.error.message || "Request failed");
      const body = resp.data as ApiResponse;
      if (body?.error) throw new Error(body.error);
      setData(body);
    } catch (e: any) {
      setError(e?.message || "Failed to load");
      toast.error("Failed to load matched-cohort comparison: " + (e?.message || "unknown error"));
    } finally {
      setLoading(false);
    }
  }, []);

  const headerRow = (
    <TableRow>
      <TableHead>Preset / window</TableHead>
      <TableHead className="text-right">Units/day</TableHead>
      <TableHead className="text-right">Revenue/day</TableHead>
      <TableHead className="text-right">Profit/day</TableHead>
      <TableHead className="text-right">ROI</TableHead>
      <TableHead className="text-right">Avg price</TableHead>
      <TableHead className="text-right">BB %</TableHead>
      <TableHead className="text-right">Raise attempts</TableHead>
      <TableHead className="text-right">Raise → lost BB</TableHead>
    </TableRow>
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2"><GitCompare className="h-5 w-5" /> Matched-ASIN Comparison</CardTitle>
            <CardDescription>
              How the SAME (or comparable) products perform under different presets, instead of raw account-wide totals which mix different product portfolios per preset.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            {data ? "Refresh" : "Run comparison"}
          </Button>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            This scans up to 30 days of per-ASIN decision history across every rule and can take up to ~1-2 minutes to run — it is not meant to be refreshed often.
          </p>
        </CardContent>
      </Card>

      {loading && !data && (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground flex items-center gap-2">
          <RefreshCw className="h-4 w-4 animate-spin" /> Scanning decision history — this can take a minute or two for an active account…
        </CardContent></Card>
      )}

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 flex items-center gap-2 text-destructive text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </CardContent>
        </Card>
      )}

      {data && (
        <>
          <Card className="border-amber-400/40 bg-amber-500/5">
            <CardContent className="pt-6 text-sm">
              <p className="font-semibold mb-1">Descriptive, not causal</p>
              <p className="text-muted-foreground">{data.methodology_note}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Same-ASIN comparisons ({data.same_asin_comparisons.length})</CardTitle>
              <CardDescription>The same product, under different presets at different times — the strongest evidence available.</CardDescription>
            </CardHeader>
            <CardContent>
              {data.same_asin_comparisons.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">No ASIN had meaningful exposure to 2+ presets in this window.</p>
              ) : (
                <div className="space-y-6">
                  {data.same_asin_comparisons.map((c) => (
                    <div key={`${c.asin}::${c.marketplace}`} className="overflow-x-auto">
                      <div className="text-sm font-medium mb-2">{c.asin} <Badge variant="outline">{c.marketplace}</Badge></div>
                      <Table>
                        <TableHeader>{headerRow}</TableHeader>
                        <TableBody>
                          {c.windows.map((w, i) => (
                            <WindowRow key={i} w={w} label={PROFILE_LABELS[w.profile] || w.profile} />
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Matched-cohort comparisons ({data.matched_cohort_comparisons.length})</CardTitle>
              <CardDescription>
                ASINs that only ever saw one preset, bucketed by comparable sales-volume and price tercile, then compared bucket-by-bucket.
                {data.excluded.cohort_note && <span className="block mt-1">{data.excluded.cohort_note}</span>}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.matched_cohort_comparisons.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">No matched-cohort comparisons this window.</p>
              ) : (
                <div className="space-y-6">
                  {data.matched_cohort_comparisons.map((c) => (
                    <div key={c.cohort} className="overflow-x-auto">
                      <div className="text-sm font-medium mb-2">Cohort: {fmtCohort(c.cohort)}</div>
                      <Table>
                        <TableHeader>{headerRow}</TableHeader>
                        <TableBody>
                          {c.profiles.map((w, i) => (
                            <WindowRow key={i} w={w} label={`${PROFILE_LABELS[w.profile] || w.profile} (n=${w.n_asins} ASINs)`} />
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm">Coverage notes</CardTitle></CardHeader>
            <CardContent className="text-xs text-muted-foreground space-y-1">
              <p>{data.excluded.windows_below_min_days} ASIN/preset windows had fewer than {data.excluded.min_days_threshold} days of decision data and were excluded.</p>
              <p>{data.excluded.unattributed_orders} orders and {data.excluded.unattributed_raises} raises fell outside any known preset window and were excluded.</p>
              {data.excluded.rule_ids_skipped_timeout.length > 0 && (
                <p>{data.excluded.rule_ids_skipped_timeout.length} rule(s) had too much decision history to scan in time this run and were skipped: {data.excluded.rule_ids_skipped_timeout.map((r) => PROFILE_LABELS[r.smart_profile || ""] || r.smart_profile).join(", ")}. Try again — which rules time out can vary run to run.</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
