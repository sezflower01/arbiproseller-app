import { useState, useEffect, useCallback, useMemo } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "sonner";
import {
  Loader2, Search, Sparkles, RefreshCw, ChevronDown, History, ExternalLink, Network,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  DiscoveryRun, Candidate, SavedSource, toneClass, fmtPrice, Stat,
  pickBestCandidate, BestCandidateGate, DEFAULT_GATE, IdentityForScoring,
  Supplier, SupplierContext, EMPTY_SUPPLIER_CONTEXT, buildSupplierContext,
  findSupplierForCandidate, normalizeDomain, findRelatedSupplier,
} from "./supplier-discovery/shared";
import CandidatesTable from "./supplier-discovery/CandidatesTable";
import BestCandidateCard from "./supplier-discovery/BestCandidateCard";
import BestCandidateGateControls from "./supplier-discovery/BestCandidateGateControls";
import BulkQATab from "./supplier-discovery/BulkQATab";
import StoreScanTab from "./supplier-discovery/StoreScanTab";
import ProductInspectorTab from "./supplier-discovery/ProductInspectorTab";
import SupplierRegistryDialog from "./supplier-discovery/SupplierRegistryDialog";
import SupplierMultiSelect from "./supplier-discovery/SupplierMultiSelect";
import { useAmazonPrice } from "./supplier-discovery/useAmazonPrice";

const SupplierDiscovery = () => {
  const { user } = useAuth();
  const [asin, setAsin] = useState("");
  const [titleOverride, setTitleOverride] = useState("");
  const [brandOverride, setBrandOverride] = useState("");
  const [modelOverride, setModelOverride] = useState("");
  const [upcOverride, setUpcOverride] = useState("");
  const [overridesOpen, setOverridesOpen] = useState(false);

  const [discovering, setDiscovering] = useState(false);
  const [activeRun, setActiveRun] = useState<DiscoveryRun | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [savedSources, setSavedSources] = useState<SavedSource[]>([]);
  const [pastRuns, setPastRuns] = useState<DiscoveryRun[]>([]);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [bulkRefreshing, setBulkRefreshing] = useState<"extracted" | "blocked_unresolved" | null>(null);
  const [gate, setGate] = useState<BestCandidateGate>(DEFAULT_GATE);

  // Phase 1: Supplier registry
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [suppliersOnly, setSuppliersOnly] = useState(true);
  const [includeRelated, setIncludeRelated] = useState(true);
  const [supplierDialogOpen, setSupplierDialogOpen] = useState(false);
  // Explicit subset of suppliers the user picked from the dropdown.
  // Empty array = no subset (search across all registry suppliers per the toggle).
  const [selectedSupplierDomains, setSelectedSupplierDomains] = useState<string[]>([]);

  const supplierCtx: SupplierContext = useMemo(
    () => buildSupplierContext(suppliers),
    [suppliers],
  );

  const amazonPrice = useAmazonPrice(activeRun?.asin || null, user?.id || null);
  const identity: IdentityForScoring = useMemo(() => ({
    title: activeRun?.amazon_title ?? null,
    brand: activeRun?.brand ?? null,
    amazonPrice,
  }), [activeRun?.amazon_title, activeRun?.brand, amazonPrice]);

  // Filter logic — applied BEFORE ranking/best-candidate selection.
  // Rules:
  // - selectedSupplierDomains non-empty: search starts from that subset.
  //     - includeRelated ON  → also accept domains similar to the selected ones.
  //     - includeRelated OFF → exact selected domains only.
  // - selectedSupplierDomains empty + suppliersOnly ON: search across the full registry.
  //     - includeRelated ON  → also accept related domains.
  //     - includeRelated OFF → registry domains only.
  // - suppliersOnly OFF and no selection: no filter.
  const filteredCandidates = useMemo(() => {
    const selectedSet = new Set(selectedSupplierDomains.map((d) => normalizeDomain(d)));
    const hasExplicitSelection = selectedSet.size > 0;

    if (!suppliersOnly && !hasExplicitSelection) return candidates;

    // Build a scoped supplier context for "related" matching when a subset is selected.
    const scopedCtx: SupplierContext = hasExplicitSelection
      ? buildSupplierContext(suppliers.filter((s) => selectedSet.has(normalizeDomain(s.domain))))
      : supplierCtx;

    return candidates.filter((c) => {
      const d = normalizeDomain(c.domain);
      if (!d) return false;
      if (hasExplicitSelection) {
        if (selectedSet.has(d)) return true;
        if (includeRelated && findRelatedSupplier(c, scopedCtx)) return true;
        return false;
      }
      if (supplierCtx.byDomain.has(d)) return true;
      if (includeRelated && findRelatedSupplier(c, supplierCtx)) return true;
      return false;
    });
  }, [candidates, suppliersOnly, suppliers, supplierCtx, includeRelated, selectedSupplierDomains]);

  // Live human-readable scope label for the current control state.
  const scopeLabel = useMemo(() => {
    const hasSelection = selectedSupplierDomains.length > 0;
    if (hasSelection) {
      const n = selectedSupplierDomains.length;
      const base = `Searching ${n} selected supplier${n === 1 ? "" : "s"}`;
      return includeRelated ? `${base} + related domains` : `${base} only`;
    }
    if (suppliersOnly) {
      const base = "Searching all registry suppliers";
      return includeRelated ? `${base} + related domains` : `${base} only`;
    }
    return "Searching the open web (no supplier filter)";
  }, [selectedSupplierDomains, suppliersOnly, includeRelated]);

  const bestCandidate = useMemo(
    () => pickBestCandidate(filteredCandidates, identity, gate),
    [filteredCandidates, identity, gate],
  );

  const loadSuppliers = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("suppliers")
      .select("*")
      .eq("user_id", user.id);
    setSuppliers((data as Supplier[]) || []);
  }, [user]);

  useEffect(() => { loadSuppliers(); }, [loadSuppliers]);

  const loadPastRuns = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("source_discovery_runs")
      .select("*")
      .eq("user_id", user.id)
      .is("qa_batch_id", null)
      .order("created_at", { ascending: false })
      .limit(20);
    if (data) setPastRuns(data as DiscoveryRun[]);
  }, [user]);

  useEffect(() => { loadPastRuns(); }, [loadPastRuns]);

  const refreshRun = useCallback(async (runId: string) => {
    const [{ data: run }, { data: cands }] = await Promise.all([
      supabase.from("source_discovery_runs").select("*").eq("id", runId).maybeSingle(),
      supabase.from("source_candidates").select("*").eq("run_id", runId).order("match_score", { ascending: false }),
    ]);
    if (run) setActiveRun(run as DiscoveryRun);
    if (cands) setCandidates(cands as Candidate[]);
  }, []);

  // Load saved sources whenever active ASIN changes
  useEffect(() => {
    if (!user || !activeRun?.asin) { setSavedSources([]); return; }
    (async () => {
      const { data } = await supabase
        .from("saved_sources").select("*")
        .eq("user_id", user.id).eq("asin", activeRun.asin);
      setSavedSources((data as SavedSource[]) || []);
    })();
  }, [user, activeRun?.asin]);

  useEffect(() => {
    if (!activeRun) return;
    if (activeRun.status === "completed" || activeRun.status === "failed") return;
    const interval = setInterval(() => refreshRun(activeRun.id), 3000);
    return () => clearInterval(interval);
  }, [activeRun, refreshRun]);

  const handleDiscover = async () => {
    const cleanAsin = asin.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(cleanAsin)) {
      toast.error("Please enter a valid 10-character ASIN");
      return;
    }
    if (!user) { toast.error("Please sign in first"); return; }

    setDiscovering(true);
    try {
      const overrides: Record<string, string> = {};
      if (titleOverride.trim()) overrides.title = titleOverride.trim();
      if (brandOverride.trim()) overrides.brand = brandOverride.trim();
      if (modelOverride.trim()) overrides.model = modelOverride.trim();
      if (upcOverride.trim()) overrides.upc = upcOverride.trim();

      const { data, error } = await supabase.functions.invoke("discover-source-candidates", {
        body: {
          asin: cleanAsin,
          identity_overrides: overrides,
          auto_extract: true,
          auto_extract_limit: 10,
          // Cost-saving: pass desired ROI threshold so auto-extract can early-stop
          min_roi_pct: gate.minRoiPct > 0 ? gate.minRoiPct : null,
          amazon_price: amazonPrice ?? null,
          // Registry lock: when "My suppliers only" is on, the backend skips generic
          // queries and refuses any candidate whose domain is not in the user registry.
          trusted_only: suppliersOnly,
          // Explicit subset chosen via the supplier dropdown. When non-empty, the
          // backend will ONLY probe these domains (or related, if include_related is on).
          selected_supplier_domains:
            selectedSupplierDomains.length > 0 ? selectedSupplierDomains : null,
          // Allow the backend to expand from selected/registry domains to closely
          // related ones (e.g. .ca / .co.uk variants, sister brands).
          include_related: includeRelated,
        },
      });

      if (error) throw new Error(error.message || "Discovery failed");
      if (!data?.run_id) throw new Error(data?.error || "No run created");

      toast.success(`Found ${data.total_candidates} candidates — extracting top 10…`);
      await refreshRun(data.run_id);
      await loadPastRuns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscovering(false);
    }
  };

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

      if (activeRun) await refreshRun(activeRun.id);
      toast.success("Refreshed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshingId(null);
    }
  };

  const handleSaveSource = async (c: Candidate) => {
    if (!user || !activeRun) return;
    try {
      const { error } = await supabase.from("saved_sources").insert({
        user_id: user.id,
        asin: activeRun.asin,
        source_url: c.source_url,
        domain: c.domain,
        price: c.current_price,
        currency: c.currency,
        source_title: c.source_title,
        source_image: c.image_url,
        candidate_id: c.id,
        run_id: activeRun.id,
      });
      if (error) throw error;
      toast.success("Saved as source");
      const { data } = await supabase
        .from("saved_sources").select("*")
        .eq("user_id", user.id).eq("asin", activeRun.asin);
      setSavedSources((data as SavedSource[]) || []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const handleUnsaveSource = async (url: string) => {
    if (!user || !activeRun) return;
    await supabase.from("saved_sources").delete()
      .eq("user_id", user.id).eq("asin", activeRun.asin).eq("source_url", url);
    toast.success("Removed");
    setSavedSources((prev) => prev.filter((s) => s.source_url !== url));
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
      try { await handleRefreshCandidate(c); } catch { /* continue */ }
      done++;
    }
    toast.success(`Refreshed ${done} candidate${done === 1 ? "" : "s"}`);
    setBulkRefreshing(null);
  };

  const handleAddRelatedSupplier = useCallback(async (domain: string, relatedTo: string) => {
    if (!user) return;
    const normalized = normalizeDomain(domain);
    if (!normalized) {
      toast.error("Invalid domain");
      return;
    }
    try {
      const { error } = await supabase
        .from("suppliers")
        .upsert(
          {
            user_id: user.id,
            domain: normalized,
            supplier_type: "retail",
            trust_level: "unknown",
            source_origin: "user_added",
            supports_scraping: true,
            notes: `Added via domain similarity to ${relatedTo}`,
          },
          { onConflict: "user_id,domain", ignoreDuplicates: false },
        );
      if (error) throw error;
      toast.success(`Added ${normalized} to your registry (related to ${relatedTo})`);
      await loadSuppliers();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [user, loadSuppliers]);

  const savedUrls = new Set(savedSources.map((s) => s.source_url));

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)]">
      <Helmet>
        <title>Supplier Discovery — Find Retail Sources | ArbiProSeller</title>
        <meta name="description" content="Discover and verify retail product sources for an ASIN. Resilient pipeline with bulk QA, saved sources, and ROI-ready candidate data." />
      </Helmet>

      <Navbar />

      <main className="flex-grow pt-24 pb-12">
        <div className="container mx-auto px-4 max-w-6xl">
          <div className="mb-8">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-4">
              <Sparkles className="h-3.5 w-3.5" />
              <span>Find Retail Source</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-bold text-white mb-2">Supplier Discovery</h1>
            <p className="text-muted-foreground max-w-2xl">
              Discover retail product-page candidates for an ASIN. Auto-extracts the top 10 prices, ranks valid extractions for ROI, and keeps blocked or unresolved sources visible.
            </p>
          </div>

          <Tabs defaultValue="single" className="w-full">
            <TabsList className="mb-4">
              <TabsTrigger value="single">Single ASIN</TabsTrigger>
              <TabsTrigger value="bulk">Bulk QA</TabsTrigger>
              <TabsTrigger value="store-scan">Store Scan</TabsTrigger>
              <TabsTrigger value="inspector">Product Inspector</TabsTrigger>
            </TabsList>

            <TabsContent value="single" className="space-y-6">
              {/* Input */}
              <Card className="p-5 bg-card/50 backdrop-blur border-border/50">
                <div className="flex flex-col sm:flex-row gap-3">
                  <div className="flex-1 relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={asin}
                      onChange={(e) => setAsin(e.target.value)}
                      placeholder="ASIN (e.g. B07XYZ1234)"
                      className="pl-9 uppercase"
                      disabled={discovering}
                      maxLength={10}
                      onKeyDown={(e) => { if (e.key === "Enter") handleDiscover(); }}
                    />
                  </div>
                  <Button onClick={handleDiscover} disabled={discovering} className="min-w-[160px]">
                    {discovering ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Discovering…</>
                    ) : (
                      <><Search className="h-4 w-4 mr-2" /> Find Sources</>
                    )}
                  </Button>
                </div>

                {/* Supplier registry controls */}
                <div className="mt-4 flex flex-wrap items-center gap-3 pt-3 border-t border-border/30">
                  <SupplierMultiSelect
                    suppliers={suppliers}
                    selectedDomains={selectedSupplierDomains}
                    onChange={setSelectedSupplierDomains}
                    disabled={discovering}
                  />
                  <div className="flex items-center gap-2">
                    <Switch
                      id="suppliers-only"
                      checked={suppliersOnly}
                      onCheckedChange={setSuppliersOnly}
                      disabled={suppliers.length === 0}
                    />
                    <Label htmlFor="suppliers-only" className="text-xs text-muted-foreground cursor-pointer">
                      My suppliers only
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="include-related"
                      checked={includeRelated}
                      onCheckedChange={setIncludeRelated}
                    />
                    <Label htmlFor="include-related" className="text-xs text-muted-foreground cursor-pointer">
                      Include related domains (suggestions)
                    </Label>
                  </div>
                  <Badge variant="outline" className="text-xs">
                    {suppliers.length} supplier{suppliers.length === 1 ? "" : "s"} in registry
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    onClick={() => setSupplierDialogOpen(true)}
                  >
                    <Network className="h-3 w-3 mr-1" /> Manage suppliers
                  </Button>
                </div>

                {/* Live scope indicator — shows the exact search mode the user has configured */}
                <div className="mt-2 text-[11px] text-primary/80 italic flex items-center gap-1.5">
                  <Sparkles className="h-3 w-3" />
                  <span>{scopeLabel}</span>
                </div>

                <Collapsible open={overridesOpen} onOpenChange={setOverridesOpen} className="mt-4">
                  <CollapsibleTrigger asChild>
                    <button className="text-xs text-muted-foreground hover:text-white inline-flex items-center gap-1">
                      <ChevronDown className={`h-3 w-3 transition-transform ${overridesOpen ? "rotate-180" : ""}`} />
                      Identity overrides (optional — auto-fetched from your inventory if blank)
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Input value={titleOverride} onChange={(e) => setTitleOverride(e.target.value)} placeholder="Title" disabled={discovering} />
                    <Input value={brandOverride} onChange={(e) => setBrandOverride(e.target.value)} placeholder="Brand" disabled={discovering} />
                    <Input value={modelOverride} onChange={(e) => setModelOverride(e.target.value)} placeholder="Model number" disabled={discovering} />
                    <Input value={upcOverride} onChange={(e) => setUpcOverride(e.target.value)} placeholder="UPC / EAN" disabled={discovering} />
                  </CollapsibleContent>
                </Collapsible>
              </Card>

              {/* Active run summary */}
              {activeRun && (
                <Card className="p-5 bg-card/50 backdrop-blur border-border/50">
                  <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                    <div>
                      <div className="text-xs text-muted-foreground">Run for ASIN</div>
                      <div className="font-mono text-white">{activeRun.asin}</div>
                      {activeRun.amazon_title && (
                        <div className="text-sm text-muted-foreground mt-1 line-clamp-1 max-w-xl">{activeRun.amazon_title}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {activeRun.quality_badge && (
                        <Badge variant="outline" className={
                          activeRun.quality_badge === "strong" ? toneClass("good")
                            : activeRun.quality_badge === "review_needed" ? toneClass("ai")
                            : toneClass("ok")
                        }>
                          Quality · {activeRun.quality_badge}
                        </Badge>
                      )}
                      <Badge variant="outline" className={
                        activeRun.status === "completed" ? toneClass("good")
                        : activeRun.status === "failed" ? toneClass("bad")
                        : toneClass("ai")
                      }>
                        {(activeRun.status === "discovering" || activeRun.status === "extracting") &&
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                        {activeRun.status}
                      </Badge>
                      <Button size="sm" variant="outline" asChild>
                        <Link to={`/tools/supplier-discovery/runs/${activeRun.id}`}>
                          Open full run <ExternalLink className="h-3 w-3 ml-1" />
                        </Link>
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => refreshRun(activeRun.id)}>
                        <RefreshCw className="h-3 w-3 mr-1" /> Refresh
                      </Button>
                    </div>
                  </div>

                  <Separator className="my-3" />

                  <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 text-center">
                    <Stat label="Total" value={activeRun.total_candidates} />
                    <Stat label="Extracted" value={activeRun.extracted_count} tone="good" />
                    <Stat label="Blocked" value={activeRun.blocked_count} tone="bad" />
                    <Stat label="Unresolved" value={activeRun.unresolved_count} tone="ai" />
                    <Stat label="Invalid" value={activeRun.invalid_count} tone="bad" />
                    <Stat label="Needs review" value={activeRun.needs_review_count} tone="ai" />
                  </div>

                  {amazonPrice != null && (
                    <div className="mt-3 text-xs text-muted-foreground">
                      Amazon price reference: <span className="text-white font-mono">{fmtPrice(amazonPrice, "USD")}</span>
                    </div>
                  )}
                </Card>
              )}

              {/* Best candidate hero + gate controls */}
              {activeRun && candidates.length > 0 && (
                <>
                  <BestCandidateGateControls gate={gate} onChange={setGate} />
                  {suppliersOnly && filteredCandidates.length === 0 ? (
                    <Card className="p-6 bg-card/50 border-border/50 text-center text-sm text-muted-foreground">
                      No candidates from your supplier registry. Turn off <span className="text-foreground font-medium">My suppliers only</span> to see all results, or add more suppliers.
                    </Card>
                  ) : (
                    <BestCandidateCard
                      best={bestCandidate}
                      amazonPrice={amazonPrice}
                      candidates={filteredCandidates}
                      identity={identity}
                      gate={gate}
                      suppliers={supplierCtx}
                      saved={bestCandidate ? savedUrls.has(bestCandidate.source_url) : false}
                      refreshing={bestCandidate ? refreshingId === bestCandidate.id : false}
                      onRefresh={() => bestCandidate && handleRefreshCandidate(bestCandidate)}
                      onSave={() => bestCandidate && handleSaveSource(bestCandidate)}
                      onUnsave={() => bestCandidate && handleUnsaveSource(bestCandidate.source_url)}
                    />
                  )}
                </>
              )}

              {/* Candidates */}
              {activeRun && candidates.length > 0 && (
                <Card className="p-0 bg-card/50 backdrop-blur border-border/50 overflow-hidden">
                  <div className="px-5 py-3 border-b border-border/50 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-white">
                      Source candidates
                      {suppliersOnly && (
                        <span className="ml-2 text-xs text-muted-foreground font-normal">
                          ({filteredCandidates.length} from your suppliers · {candidates.length - filteredCandidates.length} hidden)
                        </span>
                      )}
                    </h2>
                    {savedSources.length > 0 && (
                      <Badge variant="outline" className={toneClass("good")}>
                        {savedSources.length} saved
                      </Badge>
                    )}
                  </div>
                  <CandidatesTable
                    candidates={filteredCandidates}
                    savedUrls={savedUrls}
                    amazonPrice={amazonPrice}
                    identity={identity}
                    gate={gate}
                    suppliers={supplierCtx}
                    refreshingId={refreshingId}
                    onRefresh={handleRefreshCandidate}
                    onSave={handleSaveSource}
                    onUnsave={handleUnsaveSource}
                    onAddRelatedSupplier={handleAddRelatedSupplier}
                    onBulkRefresh={handleBulkRefresh}
                    bulkRefreshing={bulkRefreshing}
                  />
                </Card>
              )}

              {activeRun && candidates.length === 0 && activeRun.status === "completed" && (
                <Card className="p-6 bg-card/50 border-border/50 text-center">
                  <p className="text-muted-foreground">No candidates found. Try providing identity overrides (title / brand / UPC).</p>
                </Card>
              )}

              {/* Past runs */}
              {pastRuns.length > 0 && (
                <Card className="p-5 bg-card/50 backdrop-blur border-border/50">
                  <div className="flex items-center gap-2 mb-3">
                    <History className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold text-foreground">Recent runs</h2>
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-border bg-table-row">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 z-10 bg-table-row-hover text-xs font-medium text-foreground border-b border-border">
                        <tr>
                          <th className="text-left py-2.5 px-3">ASIN</th>
                          <th className="text-left py-2.5 px-3">Title</th>
                          <th className="text-right py-2.5 px-3">Extracted</th>
                          <th className="text-right py-2.5 px-3">Blocked</th>
                          <th className="text-right py-2.5 px-3">Unresolved</th>
                          <th className="text-right py-2.5 px-3">Top price</th>
                          <th className="text-right py-2.5 px-3">When</th>
                          <th className="text-right py-2.5 px-3"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {pastRuns.map((r, idx) => (
                          <tr key={r.id} className={`border-t border-border/50 ${idx % 2 === 0 ? "bg-table-row" : "bg-table-row-alt"} hover:bg-table-row-hover transition-colors`}>
                            <td className="py-2.5 px-3 font-mono text-foreground">{r.asin}</td>
                            <td className="py-2.5 px-3 text-xs text-foreground max-w-xs">
                              <div className="line-clamp-1">{r.amazon_title || "—"}</div>
                            </td>
                            <td className="py-2.5 px-3 text-right text-emerald-400 font-medium">{r.extracted_count}</td>
                            <td className="py-2.5 px-3 text-right text-rose-400 font-medium">{r.blocked_count}</td>
                            <td className="py-2.5 px-3 text-right text-amber-400 font-medium">{r.unresolved_count}</td>
                            <td className="py-2.5 px-3 text-right font-mono text-emerald-300">
                              {r.top_valid_price != null ? fmtPrice(r.top_valid_price, "USD") : "—"}
                            </td>
                            <td className="py-2.5 px-3 text-right text-xs text-muted-foreground whitespace-nowrap">
                              {new Date(r.created_at).toLocaleDateString()}
                            </td>
                            <td className="py-2.5 px-3 text-right">
                              <div className="inline-flex gap-1">
                                <Button size="sm" variant="ghost" onClick={() => refreshRun(r.id)}>Open</Button>
                                <Button size="sm" variant="ghost" asChild>
                                  <Link to={`/tools/supplier-discovery/runs/${r.id}`}>
                                    <ExternalLink className="h-3 w-3" />
                                  </Link>
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="bulk">
              <BulkQATab />
            </TabsContent>

            <TabsContent value="store-scan">
              <StoreScanTab />
            </TabsContent>

            <TabsContent value="inspector">
              <ProductInspectorTab />
            </TabsContent>
          </Tabs>
        </div>
      </main>

      <SupplierRegistryDialog
        open={supplierDialogOpen}
        onOpenChange={setSupplierDialogOpen}
        onChanged={loadSuppliers}
      />
    </div>
  );
};

export default SupplierDiscovery;
