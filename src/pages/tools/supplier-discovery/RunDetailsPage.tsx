import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Loader2, RefreshCw, ArrowLeft, ExternalLink, Sparkles,
} from "lucide-react";
import {
  DiscoveryRun, Candidate, SavedSource, toneClass, fmtPrice, Stat,
  pickBestCandidate, computeQualityBadge, qualityBadgeMeta,
  BestCandidateGate, DEFAULT_GATE, IdentityForScoring,
} from "./shared";
import CandidatesTable from "./CandidatesTable";
import BestCandidateCard from "./BestCandidateCard";
import BestCandidateGateControls from "./BestCandidateGateControls";
import DomainInsights from "./DomainInsights";
import SavedSourcesPanel from "./SavedSourcesPanel";
import RunComparisonPanel from "./RunComparisonPanel";
import { useAmazonPrice } from "./useAmazonPrice";

const RunDetailsPage = () => {
  const { runId } = useParams<{ runId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [run, setRun] = useState<DiscoveryRun | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [savedSources, setSavedSources] = useState<SavedSource[]>([]);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [bulkRefreshing, setBulkRefreshing] = useState<"extracted" | "blocked_unresolved" | null>(null);
  const [recheckingSavedId, setRecheckingSavedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [gate, setGate] = useState<BestCandidateGate>(DEFAULT_GATE);

  const amazonPrice = useAmazonPrice(run?.asin || null, user?.id || null);
  const identity: IdentityForScoring = useMemo(() => ({
    title: run?.amazon_title ?? null,
    brand: run?.brand ?? null,
    amazonPrice,
  }), [run?.amazon_title, run?.brand, amazonPrice]);
  const bestCandidate = useMemo(
    () => pickBestCandidate(candidates, identity, gate),
    [candidates, identity, gate],
  );
  const savedUrls = useMemo(() => new Set(savedSources.map((s) => s.source_url)), [savedSources]);
  const quality = run ? computeQualityBadge(run, candidates) : null;
  const qualityMeta = quality ? qualityBadgeMeta(quality) : null;

  const loadAll = useCallback(async () => {
    if (!runId) return;
    const [{ data: r }, { data: c }] = await Promise.all([
      supabase.from("source_discovery_runs").select("*").eq("id", runId).maybeSingle(),
      supabase.from("source_candidates").select("*").eq("run_id", runId).order("match_score", { ascending: false }),
    ]);
    if (!r) { setNotFound(true); setLoading(false); return; }
    setRun(r as DiscoveryRun);
    setCandidates((c as Candidate[]) || []);

    if (user && r) {
      const { data: saved } = await supabase
        .from("saved_sources").select("*")
        .eq("user_id", user.id).eq("asin", (r as DiscoveryRun).asin);
      setSavedSources((saved as SavedSource[]) || []);
    }
    setLoading(false);
  }, [runId, user]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Poll while still in-flight
  useEffect(() => {
    if (!run) return;
    if (run.status === "completed" || run.status === "failed") return;
    const id = setInterval(loadAll, 3000);
    return () => clearInterval(id);
  }, [run, loadAll]);

  const handleRefreshCandidate = async (candidate: Candidate) => {
    setRefreshingId(candidate.id);
    try {
      const { data, error } = await supabase.functions.invoke("extract-product-price", {
        body: { url: candidate.source_url, force_refresh: true },
      });
      if (error) throw new Error(error.message || "Extract failed");

      await supabase.from("source_candidates").update({
        phase1_status: data.phase1_status ?? null,
        phase2_status: data.phase2_status ?? null,
        block_provider: data.block_provider ?? null,
        final_resolution: data.final_resolution ?? null,
        extraction_method: data.extraction_method ?? null,
        current_price: data.price_current ?? null,
        original_price: data.price_original ?? null,
        currency: data.currency ?? null,
        availability: data.availability ?? null,
        confidence_score: data.confidence_score ?? null,
        needs_review: data.needs_review ?? null,
        review_reasons: data.review_reasons ?? null,
        image_url: data.image_url ?? null,
        extracted_at: new Date().toISOString(),
        last_checked_at: new Date().toISOString(),
      }).eq("id", candidate.id);

      await loadAll();
      toast.success("Refreshed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshingId(null);
    }
  };

  const handleSaveSource = async (c: Candidate) => {
    if (!user || !run) return;
    try {
      const { error } = await supabase.from("saved_sources").insert({
        user_id: user.id,
        asin: run.asin,
        source_url: c.source_url,
        domain: c.domain,
        price: c.current_price,
        currency: c.currency,
        source_title: c.source_title,
        source_image: c.image_url,
        candidate_id: c.id,
        run_id: run.id,
      });
      if (error) throw error;
      toast.success("Saved as source");
      await loadAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleUnsaveSource = async (url: string) => {
    if (!user || !run) return;
    await supabase.from("saved_sources").delete()
      .eq("user_id", user.id).eq("asin", run.asin).eq("source_url", url);
    toast.success("Removed");
    await loadAll();
  };

  const handleTogglePreferred = async (s: SavedSource) => {
    if (!user || !run) return;
    const next = !s.is_preferred;
    // If marking preferred, clear other preferred for this ASIN first
    if (next) {
      await supabase.from("saved_sources")
        .update({ is_preferred: false })
        .eq("user_id", user.id).eq("asin", run.asin);
    }
    await supabase.from("saved_sources")
      .update({ is_preferred: next })
      .eq("id", s.id);
    toast.success(next ? "Marked as preferred" : "Removed preferred mark");
    await loadAll();
  };

  const handleUpdateNotes = async (s: SavedSource, notes: string) => {
    await supabase.from("saved_sources")
      .update({ notes: notes || null })
      .eq("id", s.id);
    toast.success("Note saved");
    await loadAll();
  };

  const handleRecheckSaved = async (s: SavedSource) => {
    setRecheckingSavedId(s.id);
    try {
      const { data, error } = await supabase.functions.invoke("extract-product-price", {
        body: { url: s.source_url, force_refresh: true },
      });
      if (error) throw new Error(error.message || "Recheck failed");
      const fr = data?.final_resolution || "";
      let last_status = "unresolved";
      if (fr === "price_extracted" && (data?.price_current || 0) > 0) last_status = "extracted";
      else if (fr.startsWith("blocked_") || fr === "phase2_timeout" || fr === "phase2_render_failed") last_status = "blocked";
      else if (fr === "non_product_page") last_status = "invalid";
      await supabase.from("saved_sources").update({
        price: data?.price_current ?? s.price,
        currency: data?.currency ?? s.currency,
        last_checked_at: new Date().toISOString(),
        last_status,
        last_resolution: data?.final_resolution ?? null,
        last_confidence: data?.confidence_score ?? null,
      }).eq("id", s.id);
      toast.success("Rechecked");
      await loadAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRecheckingSavedId(null);
    }
  };

  const handleBulkRefresh = async (which: "extracted" | "blocked_unresolved") => {
    const targets = candidates.filter((c) => {
      if (which === "extracted") {
        return c.final_resolution === "price_extracted" && (c.current_price || 0) > 0;
      }
      const fr = c.final_resolution || "";
      return fr.startsWith("blocked_") || fr === "phase2_timeout"
        || fr === "phase2_render_failed" || (c.extracted_at && fr !== "price_extracted" && fr !== "non_product_page");
    });
    if (targets.length === 0) { toast.info("No matching candidates to refresh"); return; }
    setBulkRefreshing(which);
    let done = 0;
    for (const c of targets) {
      try {
        await handleRefreshCandidate(c);
      } catch { /* continue */ }
      done++;
    }
    toast.success(`Refreshed ${done} candidate${done === 1 ? "" : "s"}`);
    setBulkRefreshing(null);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)]">
        <Navbar />
        <main className="flex-grow pt-24 pb-12 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </main>
      </div>
    );
  }

  if (notFound || !run) {
    return (
      <div className="min-h-screen flex flex-col bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)]">
        <Navbar />
        <main className="flex-grow pt-24 pb-12">
          <div className="container mx-auto px-4 max-w-3xl text-center">
            <p className="text-muted-foreground">Run not found.</p>
            <Button variant="outline" className="mt-4" onClick={() => navigate("/tools/supplier-discovery")}>
              <ArrowLeft className="h-4 w-4 mr-2" /> Back to discovery
            </Button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)]">
      <Helmet>
        <title>Run {run.asin} — Supplier Discovery | ArbiProSeller</title>
        <meta name="description" content="Detailed view of a Supplier Discovery run with full candidate breakdown, statuses, and saved sources." />
      </Helmet>

      <Navbar />

      <main className="flex-grow pt-24 pb-12">
        <div className="container mx-auto px-4 max-w-6xl">
          <Link to="/tools/supplier-discovery" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-white mb-4">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to discovery
          </Link>

          {/* Header */}
          <Card className="p-5 bg-card/50 backdrop-blur border-border/50 mb-6">
            <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
              <div className="min-w-0 flex-1">
                <div className="inline-flex items-center gap-2 px-2 py-0.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-2">
                  <Sparkles className="h-3 w-3" /> Run · {new Date(run.created_at).toLocaleString()}
                </div>
                <h1 className="text-2xl font-bold text-white font-mono">{run.asin}</h1>
                {run.amazon_title && (
                  <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{run.amazon_title}</p>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
                {qualityMeta && (
                  <Badge variant="outline" className={toneClass(qualityMeta.tone)}>
                    Quality · {qualityMeta.label}
                  </Badge>
                )}
                <Badge variant="outline" className={
                  run.status === "completed" ? toneClass("good")
                  : run.status === "failed" ? toneClass("bad")
                  : toneClass("ai")
                }>
                  {(run.status === "discovering" || run.status === "extracting") &&
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                  {run.status}
                </Badge>
                <Button size="sm" variant="outline" onClick={loadAll}>
                  <RefreshCw className="h-3 w-3 mr-1" /> Refresh
                </Button>
              </div>
            </div>

            {/* Identity used */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs mt-3">
              <IdField label="Brand" value={run.brand} />
              <IdField label="Model" value={run.model_number} />
              <IdField label="UPC / EAN" value={run.upc} />
              <IdField label="Amazon price" value={fmtPrice(amazonPrice, "USD")} />
            </div>

            <Separator className="my-4" />

            <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 text-center">
              <Stat label="Total" value={run.total_candidates} />
              <Stat label="Extracted" value={run.extracted_count} tone="good" />
              <Stat label="Blocked" value={run.blocked_count} tone="bad" />
              <Stat label="Unresolved" value={run.unresolved_count} tone="ai" />
              <Stat label="Invalid" value={run.invalid_count} tone="bad" />
              <Stat label="Needs review" value={run.needs_review_count} tone="ai" />
            </div>
          </Card>

          {/* Tunable best-candidate gate */}
          <BestCandidateGateControls gate={gate} onChange={setGate} />

          {/* Best candidate hero */}
          <BestCandidateCard
            best={bestCandidate}
            amazonPrice={amazonPrice}
            candidates={candidates}
            identity={identity}
            gate={gate}
            saved={bestCandidate ? savedUrls.has(bestCandidate.source_url) : false}
            refreshing={bestCandidate ? refreshingId === bestCandidate.id : false}
            onRefresh={() => bestCandidate && handleRefreshCandidate(bestCandidate)}
            onSave={() => bestCandidate && handleSaveSource(bestCandidate)}
            onUnsave={() => bestCandidate && handleUnsaveSource(bestCandidate.source_url)}
          />

          {/* Run-to-run comparison */}
          <RunComparisonPanel currentRun={run} currentCandidates={candidates} />

          {/* Saved sources */}
          <SavedSourcesPanel
            saved={savedSources}
            recheckingId={recheckingSavedId}
            onUnsave={handleUnsaveSource}
            onTogglePreferred={handleTogglePreferred}
            onUpdateNotes={handleUpdateNotes}
            onRecheck={handleRecheckSaved}
          />

          {/* Domain insights */}
          <DomainInsights candidates={candidates} />

          {/* Candidates */}
          <Card className="p-0 bg-card/50 backdrop-blur border-border/50 mb-8 overflow-hidden">
            <div className="px-5 py-3 border-b border-border/50">
              <h2 className="text-sm font-semibold text-white">Source candidates</h2>
            </div>
            <CandidatesTable
              candidates={candidates}
              savedUrls={savedUrls}
              amazonPrice={amazonPrice}
              identity={identity}
              gate={gate}
              refreshingId={refreshingId}
              onRefresh={handleRefreshCandidate}
              onSave={handleSaveSource}
              onUnsave={handleUnsaveSource}
              onBulkRefresh={handleBulkRefresh}
              bulkRefreshing={bulkRefreshing}
            />
          </Card>
        </div>
      </main>
    </div>
  );
};

function IdField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="text-white font-mono break-all">{value || "—"}</div>
    </div>
  );
}

export default RunDetailsPage;
