import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { Loader2, Play, ListChecks, Download, ChevronDown } from "lucide-react";
import {
  DiscoveryRun, Candidate, Stat, toneClass, fmtPrice,
  toCSV, downloadCSV,
} from "./shared";

interface BatchAggregates {
  asinsTotal: number;
  asinsWithCandidates: number;
  candidatesTotal: number;
  extracted: number;
  blocked: number;
  unresolved: number;
  invalid: number;
  needsReview: number;
  topDomains: Array<{ domain: string; count: number }>;
  bestYieldDomains: Array<{ domain: string; valid: number; total: number; rate: number }>;
}

type RecentBatch = {
  id: string;
  name: string | null;
  total_asins: number;
  completed_asins: number;
  status: string;
  created_at: string;
};

type ExportFilter = "all" | "extracted" | "blocked" | "needs_review";

export default function BulkQATab() {
  const { user } = useAuth();
  const [asinsText, setAsinsText] = useState("");
  const [running, setRunning] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batchRuns, setBatchRuns] = useState<DiscoveryRun[]>([]);
  const [batchCands, setBatchCands] = useState<Candidate[]>([]);
  const [recentBatches, setRecentBatches] = useState<RecentBatch[]>([]);

  const loadBatchData = useCallback(async (id: string) => {
    const { data: runs } = await supabase
      .from("source_discovery_runs").select("*").eq("qa_batch_id", id);
    setBatchRuns((runs as DiscoveryRun[]) || []);
    const runIds = ((runs as DiscoveryRun[]) || []).map((r) => r.id);
    if (runIds.length > 0) {
      const { data: cands } = await supabase
        .from("source_candidates").select("*").in("run_id", runIds);
      setBatchCands((cands as Candidate[]) || []);
    } else {
      setBatchCands([]);
    }
  }, []);

  const loadRecentBatches = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("supplier_qa_batches").select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(10);
    setRecentBatches((data as RecentBatch[]) || []);
  }, [user]);

  useEffect(() => { loadRecentBatches(); }, [loadRecentBatches]);

  // Poll while running
  useEffect(() => {
    if (!batchId) return;
    const tick = async () => {
      await loadBatchData(batchId);
      const { data: batch } = await supabase
        .from("supplier_qa_batches").select("*").eq("id", batchId).maybeSingle();
      if (batch && batch.status === "completed") {
        setRunning(false);
        await loadRecentBatches();
      }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, [batchId, loadBatchData, loadRecentBatches]);

  const handleRun = async () => {
    if (!user) { toast.error("Sign in first"); return; }
    const list = asinsText
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z0-9]{10}$/.test(s));
    const unique = Array.from(new Set(list));
    if (unique.length === 0) { toast.error("Paste at least one valid ASIN"); return; }
    if (unique.length > 25) { toast.error("Max 25 ASINs per QA batch"); return; }

    setRunning(true);
    try {
      // Create batch record (persist asin_list)
      const { data: batch, error: batchErr } = await supabase
        .from("supplier_qa_batches")
        .insert({
          user_id: user.id,
          total_asins: unique.length,
          status: "running",
          asin_list: unique,
          run_ids: [],
        })
        .select().single();
      if (batchErr || !batch) throw batchErr || new Error("Failed to create batch");
      setBatchId(batch.id);
      setBatchRuns([]);
      setBatchCands([]);
      toast.success(`Running QA on ${unique.length} ASINs…`);

      // Fire discoveries sequentially in the background
      let completed = 0;
      const accumulatedRunIds: string[] = [];
      for (const asin of unique) {
        try {
          const { data } = await supabase.functions.invoke("discover-source-candidates", {
            body: { asin, auto_extract: true, auto_extract_limit: 10 },
          });
          if (data?.run_id) {
            accumulatedRunIds.push(data.run_id);
            await supabase
              .from("source_discovery_runs")
              .update({ qa_batch_id: batch.id })
              .eq("id", data.run_id);
          }
        } catch (e) {
          console.warn("QA discover failed for", asin, e);
        }
        completed++;
        await supabase
          .from("supplier_qa_batches")
          .update({ completed_asins: completed, run_ids: accumulatedRunIds })
          .eq("id", batch.id);
      }

      // Compute aggregate_metrics from final state and persist
      const { data: finalRuns } = await supabase
        .from("source_discovery_runs").select("*").eq("qa_batch_id", batch.id);
      const runsArr = (finalRuns as DiscoveryRun[]) || [];
      let aggExtracted = 0, aggBlocked = 0, aggUnresolved = 0, aggInvalid = 0, aggReview = 0, aggCands = 0, aggWith = 0;
      for (const r of runsArr) {
        aggCands += r.total_candidates || 0;
        aggExtracted += r.extracted_count || 0;
        aggBlocked += r.blocked_count || 0;
        aggUnresolved += r.unresolved_count || 0;
        aggInvalid += r.invalid_count || 0;
        aggReview += r.needs_review_count || 0;
        if ((r.total_candidates || 0) > 0) aggWith++;
      }
      const aggregateMetrics = {
        asins_total: runsArr.length,
        asins_with_candidates: aggWith,
        candidates_total: aggCands,
        extracted: aggExtracted,
        blocked: aggBlocked,
        unresolved: aggUnresolved,
        invalid: aggInvalid,
        needs_review: aggReview,
        discovery_rate: runsArr.length > 0 ? aggWith / runsArr.length : 0,
        extraction_rate: aggCands > 0 ? aggExtracted / aggCands : 0,
        blocked_rate: aggCands > 0 ? aggBlocked / aggCands : 0,
        computed_at: new Date().toISOString(),
      };

      await supabase
        .from("supplier_qa_batches")
        .update({
          status: "completed",
          completed_asins: completed,
          run_ids: accumulatedRunIds,
          aggregate_metrics: aggregateMetrics,
        })
        .eq("id", batch.id);
      setRunning(false);
      await loadRecentBatches();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  };

  const aggregates: BatchAggregates = useMemo(() => {
    const candidatesTotal = batchCands.length;
    let extracted = 0, blocked = 0, unresolved = 0, invalid = 0, needsReview = 0;
    const domainCounts = new Map<string, { valid: number; total: number }>();
    for (const c of batchCands) {
      const d = c.domain || "unknown";
      const cur = domainCounts.get(d) || { valid: 0, total: 0 };
      cur.total++;
      const fr = c.final_resolution || "";
      if (fr === "price_extracted" && (c.current_price || 0) > 0) { extracted++; cur.valid++; }
      else if (fr.startsWith("blocked_") || fr === "phase2_timeout" || fr === "phase2_render_failed") blocked++;
      else if (fr === "non_product_page") invalid++;
      else if (c.extracted_at) unresolved++;
      if (c.needs_review) needsReview++;
      domainCounts.set(d, cur);
    }
    const asinsWithCandidates = batchRuns.filter((r) => (r.total_candidates || 0) > 0).length;
    const topDomains = Array.from(domainCounts.entries())
      .map(([domain, v]) => ({ domain, count: v.total }))
      .sort((a, b) => b.count - a.count).slice(0, 8);
    const bestYieldDomains = Array.from(domainCounts.entries())
      .filter(([, v]) => v.total >= 2)
      .map(([domain, v]) => ({ domain, valid: v.valid, total: v.total, rate: v.valid / v.total }))
      .sort((a, b) => b.rate - a.rate || b.valid - a.valid).slice(0, 8);
    return {
      asinsTotal: batchRuns.length,
      asinsWithCandidates,
      candidatesTotal, extracted, blocked, unresolved, invalid, needsReview,
      topDomains, bestYieldDomains,
    };
  }, [batchRuns, batchCands]);

  const discoveryRate = aggregates.asinsTotal > 0
    ? Math.round((aggregates.asinsWithCandidates / aggregates.asinsTotal) * 100) : 0;
  const extractionRate = aggregates.candidatesTotal > 0
    ? Math.round((aggregates.extracted / aggregates.candidatesTotal) * 100) : 0;
  const blockedRate = aggregates.candidatesTotal > 0
    ? Math.round((aggregates.blocked / aggregates.candidatesTotal) * 100) : 0;

  const exportCSV = (filter: ExportFilter) => {
    const candsByRun = new Map<string, Candidate[]>();
    for (const c of batchCands) {
      const arr = candsByRun.get(c.run_id) || [];
      arr.push(c);
      candsByRun.set(c.run_id, arr);
    }

    const matchesFilter = (c: Candidate): boolean => {
      const fr = c.final_resolution || "";
      if (filter === "extracted") return fr === "price_extracted" && (c.current_price || 0) > 0;
      if (filter === "blocked") {
        return fr.startsWith("blocked_") || fr === "phase2_timeout" || fr === "phase2_render_failed";
      }
      if (filter === "needs_review") return !!c.needs_review;
      return true;
    };

    // Per-candidate rows for filtered exports, per-run summary for "all"
    if (filter === "all") {
      const rows = batchRuns.map((r) => {
        const list = candsByRun.get(r.id) || [];
        const extracted = list.filter((c) => c.current_price && c.current_price > 0);
        let bestMargin: number | null = null;
        if (extracted.length > 0 && r.top_valid_price != null) {
          const minSrc = Math.min(...extracted.map((c) => c.current_price as number));
          bestMargin = r.top_valid_price - minSrc;
        }
        return {
          asin: r.asin,
          title: r.amazon_title || "",
          quality_badge: r.quality_badge || "",
          candidates: r.total_candidates,
          extracted: r.extracted_count,
          blocked: r.blocked_count,
          unresolved: r.unresolved_count,
          invalid: r.invalid_count,
          needs_review: r.needs_review_count,
          top_valid_domain: r.top_valid_domain || "",
          top_valid_price: r.top_valid_price ?? "",
          best_margin: bestMargin != null ? bestMargin.toFixed(2) : "",
          run_url: `${window.location.origin}/tools/supplier-discovery/runs/${r.id}`,
        };
      });
      const csv = toCSV(rows);
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      downloadCSV(`supplier-qa-summary-${ts}.csv`, csv);
      return;
    }

    const rows: Array<Record<string, unknown>> = [];
    for (const r of batchRuns) {
      const list = candsByRun.get(r.id) || [];
      for (const c of list) {
        if (!matchesFilter(c)) continue;
        rows.push({
          asin: r.asin,
          source_url: c.source_url,
          domain: c.domain || "",
          source_title: c.source_title || "",
          source_price: c.current_price ?? "",
          currency: c.currency || "",
          confidence: c.confidence_score ?? "",
          match_score: c.match_score,
          final_resolution: c.final_resolution || "",
          block_provider: c.block_provider || "",
          needs_review: c.needs_review ? "yes" : "",
          review_reasons: (c.review_reasons || []).join("; "),
          extracted_at: c.extracted_at || "",
          last_checked_at: c.last_checked_at || "",
        });
      }
    }
    if (rows.length === 0) {
      toast.info("No rows match this filter");
      return;
    }
    const csv = toCSV(rows);
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadCSV(`supplier-qa-${filter}-${ts}.csv`, csv);
  };

  return (
    <div className="space-y-6">
      <Card className="p-5 bg-card/50 backdrop-blur border-border/50">
        <div className="flex items-center gap-2 mb-3">
          <ListChecks className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-white">Bulk QA</h2>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Paste up to 25 ASINs (one per line, comma- or space-separated). Each is run through full discovery + auto-extract.
        </p>
        <Textarea
          value={asinsText}
          onChange={(e) => setAsinsText(e.target.value)}
          placeholder={"B07XYZ1234\nB08ABC5678\nB09DEF9012"}
          className="min-h-[120px] font-mono text-sm"
          disabled={running}
        />
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-muted-foreground">
            Note: each ASIN consumes search-API quota. 10 candidates auto-extracted per ASIN.
          </span>
          <Button onClick={handleRun} disabled={running}>
            {running ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Running…</>
              : <><Play className="h-4 w-4 mr-2" /> Run Bulk QA</>}
          </Button>
        </div>
      </Card>

      {batchId && (
        <Card className="p-5 bg-card/50 backdrop-blur border-border/50">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h3 className="text-sm font-semibold text-white">Live QA results</h3>
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={batchRuns.length === 0}>
                    <Download className="h-3 w-3 mr-1" /> Export CSV
                    <ChevronDown className="h-3 w-3 ml-1" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => exportCSV("all")}>Per-ASIN summary (all)</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportCSV("extracted")}>Extracted candidates only</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportCSV("blocked")}>Blocked candidates only</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportCSV("needs_review")}>Needs-review only</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Badge variant="outline" className={running ? toneClass("ai") : toneClass("good")}>
                {running ? "Running" : "Completed"}
              </Badge>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <Stat label="ASINs" value={`${aggregates.asinsTotal}`} />
            <Stat label="Discovery rate" value={`${discoveryRate}%`} tone="good" />
            <Stat label="Extraction rate" value={`${extractionRate}%`} tone={extractionRate > 30 ? "good" : "ai"} />
            <Stat label="Blocked rate" value={`${blockedRate}%`} tone={blockedRate > 50 ? "bad" : "ai"} />
          </div>

          <Separator className="my-3" />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h4 className="text-xs text-muted-foreground mb-2">Top domains returned</h4>
              <div className="space-y-1">
                {aggregates.topDomains.length === 0 && <div className="text-xs text-muted-foreground">No data yet.</div>}
                {aggregates.topDomains.map((d) => (
                  <div key={d.domain} className="flex justify-between text-sm">
                    <span className="text-white truncate">{d.domain}</span>
                    <span className="text-muted-foreground">{d.count}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h4 className="text-xs text-muted-foreground mb-2">Best valid-price yield</h4>
              <div className="space-y-1">
                {aggregates.bestYieldDomains.length === 0 && <div className="text-xs text-muted-foreground">Need ≥2 candidates per domain.</div>}
                {aggregates.bestYieldDomains.map((d) => (
                  <div key={d.domain} className="flex justify-between text-sm">
                    <span className="text-white truncate">{d.domain}</span>
                    <span className="text-emerald-300">{d.valid}/{d.total} ({Math.round(d.rate * 100)}%)</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {batchRuns.length > 0 && (
            <>
              <Separator className="my-4" />
              <h4 className="text-xs text-muted-foreground mb-2">Per-ASIN runs</h4>
              <div className="space-y-1 max-h-80 overflow-auto">
                {batchRuns.map((r) => (
                  <a
                    key={r.id}
                    href={`/tools/supplier-discovery/runs/${r.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between gap-2 p-2 rounded bg-muted/10 hover:bg-muted/20 text-sm"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-mono text-white">{r.asin}</span>
                      <span className="text-xs text-muted-foreground line-clamp-1">{r.amazon_title || "—"}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs flex-shrink-0">
                      {r.quality_badge && (
                        <Badge variant="outline" className={
                          r.quality_badge === "strong" ? toneClass("good")
                            : r.quality_badge === "review_needed" ? toneClass("ai")
                            : toneClass("ok")
                        }>
                          {r.quality_badge}
                        </Badge>
                      )}
                      <span className="text-emerald-400">{r.extracted_count}✓</span>
                      <span className="text-rose-400">{r.blocked_count}✕</span>
                      <span className="text-muted-foreground">{r.total_candidates} total</span>
                      {r.top_valid_price != null && (
                        <span className="text-emerald-300 font-mono">{fmtPrice(r.top_valid_price, "USD")}</span>
                      )}
                    </div>
                  </a>
                ))}
              </div>
            </>
          )}
        </Card>
      )}

      {recentBatches.length > 0 && !batchId && (
        <Card className="p-5 bg-card/50 backdrop-blur border-border/50">
          <h3 className="text-sm font-semibold text-white mb-3">Recent QA batches</h3>
          <div className="space-y-2">
            {recentBatches.map((b) => (
              <button
                key={b.id}
                onClick={() => setBatchId(b.id)}
                className="w-full text-left flex items-center justify-between p-2 rounded hover:bg-muted/20"
              >
                <span className="text-sm text-white">
                  {b.completed_asins}/{b.total_asins} ASINs · <span className="text-muted-foreground">{new Date(b.created_at).toLocaleString()}</span>
                </span>
                <Badge variant="outline" className={b.status === "completed" ? toneClass("good") : toneClass("ai")}>{b.status}</Badge>
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
