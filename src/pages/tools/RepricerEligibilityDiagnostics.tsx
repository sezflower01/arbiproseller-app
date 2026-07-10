// Admin: Repricer Eligibility Diagnostics (Phase 2, read-only).
// Calls snapshot_repricer_eligibility() and shows mismatches between
// stored is_enabled and derive_repricer_eligibility().
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCw } from "lucide-react";
import { useModuleAccess } from "@/hooks/useModuleAccess";

type Row = {
  assignment_id: string;
  user_id: string;
  asin: string;
  marketplace_id: string;
  is_enabled_actual: boolean;
  derived_eligible: boolean;
  derived_reason: string;
  factors: any;
  matched: boolean;
  observed_at: string;
};

export default function RepricerEligibilityDiagnostics() {
  const { isAdmin, loading: accessLoading } = useModuleAccess();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<{ scanned: number; mismatch: number; inserted: number } | null>(null);

  async function load() {
    setLoading(true);
    const { data } = await supabase
      .from("v_repricer_eligibility_mismatches" as any)
      .select("*")
      .order("observed_at", { ascending: false })
      .limit(500);
    setRows(((data as unknown) as Row[]) || []);
    setLoading(false);
  }

  async function runSnapshot() {
    setRunning(true);
    const { data, error } = await supabase.rpc("snapshot_repricer_eligibility" as any, { _limit: 1000 });
    if (!error && Array.isArray(data) && data[0]) {
      setSummary({
        scanned: data[0].scanned_count,
        mismatch: data[0].mismatch_count,
        inserted: data[0].inserted_count,
      });
    }
    setRunning(false);
    await load();
  }

  useEffect(() => {
    if (!accessLoading && isAdmin) load();
  }, [accessLoading, isAdmin]);

  if (accessLoading) return <div className="p-6"><Loader2 className="animate-spin" /></div>;
  if (!isAdmin) return <div className="p-6 text-muted-foreground">Admin only.</div>;

  const mismatches = rows.filter((r) => r.is_enabled_actual !== r.derived_eligible);
  const lowConf = rows.filter((r) => r.factors?.confidence === "LOW");

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <Card>
        <CardHeader>
          <CardTitle>Repricer Eligibility Diagnostics — Phase 2 (read-only)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Button onClick={runSnapshot} disabled={running}>
              {running ? <Loader2 className="animate-spin h-4 w-4 mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Run snapshot
            </Button>
            <Button variant="outline" onClick={load} disabled={loading}>Reload</Button>
            {summary && (
              <span className="text-sm text-muted-foreground">
                Scanned {summary.scanned} · Mismatches {summary.mismatch} · Inserted {summary.inserted}
              </span>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <StatCard label="Total observed" value={rows.length} />
            <StatCard label="Mismatches (is_enabled ≠ derived)" value={mismatches.length} tone={mismatches.length > 0 ? "warn" : "ok"} />
            <StatCard label="Low confidence" value={lowConf.length} tone={lowConf.length > 0 ? "warn" : "ok"} />
          </div>

          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr className="text-left">
                  <th className="p-2">ASIN</th>
                  <th className="p-2">Mkt</th>
                  <th className="p-2">is_enabled</th>
                  <th className="p-2">derived</th>
                  <th className="p-2">reason</th>
                  <th className="p-2">conf</th>
                  <th className="p-2">facts</th>
                  <th className="p-2">observed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const mismatch = r.is_enabled_actual !== r.derived_eligible;
                  const f = r.factors?.factors || {};
                  return (
                    <tr key={r.assignment_id + r.observed_at} className={mismatch ? "bg-amber-500/5" : ""}>
                      <td className="p-2 font-mono">{r.asin}</td>
                      <td className="p-2">{r.marketplace_id || "US"}</td>
                      <td className="p-2">{String(r.is_enabled_actual)}</td>
                      <td className="p-2">{String(r.derived_eligible)}</td>
                      <td className="p-2">
                        <Badge variant={mismatch ? "destructive" : "secondary"}>{r.derived_reason}</Badge>
                      </td>
                      <td className="p-2">{r.factors?.confidence}</td>
                      <td className="p-2 text-xs text-muted-foreground">
                        a{f.available ?? "?"}/r{f.reserved ?? "?"}/i{f.inbound ?? "?"} · {f.amazon_listing_state}
                      </td>
                      <td className="p-2 text-xs">{new Date(r.observed_at).toLocaleString()}</td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">No audit rows yet — click "Run snapshot".</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value, tone = "ok" }: { label: string; value: number; tone?: "ok" | "warn" }) {
  return (
    <div className={`rounded-lg border p-3 ${tone === "warn" ? "border-amber-300 bg-amber-500/5" : ""}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}
