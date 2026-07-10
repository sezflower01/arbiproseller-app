import { useState } from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Loader2, Search, Sparkles, AlertCircle, Store, ArrowRight, ShieldAlert, HelpCircle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Link } from "react-router-dom";

interface RunSummary {
  id: string;
  asin: string;
  amazon_title: string | null;
  brand: string | null;
  status: string;
  total_candidates: number;
  extracted_count: number;
  top_valid_price: number | null;
  top_valid_url: string | null;
  top_valid_domain: string | null;
  quality_badge: string | null;
  created_at: string;
}

interface Candidate {
  id: string;
  source_url: string;
  domain: string | null;
  source_type: string | null;
  source_title: string | null;
  source_snippet: string | null;
  match_score: number | null;
  phase1_status: string | null;
  phase2_status: string | null;
  final_resolution: string | null;
  current_price: number | null;
  original_price: number | null;
  currency: string | null;
  availability: string | null;
  image_url: string | null;
  confidence_score: number | null;
}

type CandidateBucket = "extracted" | "blocked" | "unresolved" | "invalid";

function bucketFor(c: Candidate): CandidateBucket {
  const fr = c.final_resolution || "";
  if (fr === "price_extracted" && (c.current_price ?? 0) > 0) return "extracted";
  if (fr.startsWith("blocked_") || fr === "phase2_timeout" || fr === "phase2_render_failed") return "blocked";
  if (fr === "non_product_page") return "invalid";
  return "unresolved";
}

const RESOLUTION_LABEL: Record<string, string> = {
  price_extracted: "Price extracted",
  blocked_phase1: "Supplier protected — open manually",
  blocked_phase2: "Supplier protected — open manually",
  blocked_all_phases: "Supplier protected — open manually",
  phase2_timeout: "Verification timed out",
  phase2_render_failed: "Supplier protected — open manually",
  phase2_extract_failed: "Price not found on page",
  not_found_unblocked: "Not found on page",
  non_product_page: "Not a product page",
  fetch_error: "Source page unreachable",
};

const UserSupplierDiscovery = () => {
  const [asin, setAsin] = useState("");
  const [loading, setLoading] = useState(false);
  const [run, setRun] = useState<RunSummary | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searched, setSearched] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onSearch = async () => {
    const cleaned = asin.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(cleaned)) {
      toast.error("Enter a valid 10-character ASIN");
      return;
    }
    setLoading(true);
    setSearched(true);
    setMessage(null);
    try {
      const { data, error } = await supabase.functions.invoke("user-browse-admin-data", {
        body: { mode: "supplier_discovery", asin: cleaned },
      });
      if (error) throw error;
      setRun(data?.run ?? null);
      setCandidates((data?.candidates ?? []) as Candidate[]);
      setMessage(data?.message ?? null);
    } catch (e: any) {
      toast.error(`Search failed: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Helmet>
        <title>Supplier Discovery — ArbiProSeller</title>
        <meta name="description" content="Look up supplier candidates already discovered for any ASIN — no API credits required." />
      </Helmet>
      <Navbar />
      <main className="flex-grow pt-24 pb-16">
        <div className="container mx-auto px-4 max-w-6xl">
          {/* Header */}
          <div className="mb-8">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-3">
              <Sparkles className="h-3.5 w-3.5" />
              <span>Curated library — no API credits used</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-bold mb-2">Supplier Discovery</h1>
            <p className="text-muted-foreground max-w-2xl">
              Search by ASIN to view supplier candidates our team has already discovered, ranked, and price-extracted.
            </p>
          </div>

          {/* Cross-link to Store Scan */}
          <Link
            to="/tools/user-store-scan"
            className="group block mb-6 rounded-xl border border-primary/20 bg-primary/5 hover:bg-primary/10 transition-colors p-4"
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-500 to-green-600 text-white shrink-0">
                <Store className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold flex items-center gap-2">
                  Browse Store Scan
                  <Badge variant="secondary" className="text-[10px]">Free</Badge>
                </div>
                <p className="text-xs text-muted-foreground">Pick a supplier and category to browse pre-scanned profitable matches.</p>
              </div>
              <ArrowRight className="h-4 w-4 text-primary group-hover:translate-x-1 transition-transform" />
            </div>
          </Link>

          {/* Search */}
          <Card className="p-4 mb-6">
            <div className="flex gap-2">
              <Input
                placeholder="Enter ASIN (e.g. B0CWPPJNPX)"
                value={asin}
                onChange={(e) => setAsin(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") onSearch(); }}
                className="font-mono uppercase"
                maxLength={10}
              />
              <Button onClick={onSearch} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Search className="h-4 w-4 mr-2" />}
                Search Library
              </Button>
            </div>
          </Card>

          {/* Empty / no result */}
          {searched && !loading && !run && (
            <Card className="p-12 text-center">
              <AlertCircle className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
              <div className="font-medium mb-1">No saved scan for this ASIN yet</div>
              <p className="text-sm text-muted-foreground">{message || "Our team hasn't discovered suppliers for this ASIN yet — check back soon."}</p>
            </Card>
          )}

          {/* Results */}
          {run && (() => {
            const counts = candidates.reduce(
              (acc, c) => { acc[bucketFor(c)]++; return acc; },
              { extracted: 0, blocked: 0, unresolved: 0, invalid: 0 } as Record<CandidateBucket, number>,
            );
            return (
            <>
              <Card className="p-4 mb-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground mb-0.5">ASIN <span className="font-mono">{run.asin}</span></div>
                    <div className="font-semibold truncate">{run.amazon_title || "—"}</div>
                    {run.brand && <div className="text-sm text-muted-foreground">Brand: {run.brand}</div>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{candidates.length} candidates</Badge>
                    {run.quality_badge && <Badge>{run.quality_badge}</Badge>}
                    <Badge variant="secondary">
                      Scanned {new Date(run.created_at).toLocaleDateString()}
                    </Badge>
                  </div>
                </div>
                {/* Bucket counters */}
                <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-border">
                  <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/30">
                    <CheckCircle2 className="h-3 w-3 mr-1" /> {counts.extracted} verified
                  </Badge>
                  <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/30">
                    <ShieldAlert className="h-3 w-3 mr-1" /> {counts.blocked} blocked by site
                  </Badge>
                  <Badge variant="outline" className="bg-muted text-muted-foreground">
                    <HelpCircle className="h-3 w-3 mr-1" /> {counts.unresolved} unresolved
                  </Badge>
                  {counts.invalid > 0 && (
                    <Badge variant="outline" className="bg-muted text-muted-foreground">
                      {counts.invalid} not a product page
                    </Badge>
                  )}
                </div>
                {counts.blocked > 0 && (
                  <p className="text-xs text-muted-foreground mt-2">
                    <ShieldAlert className="h-3 w-3 inline mr-1 text-amber-500" />
                    Blocked candidates were found but the supplier site rejected automated price verification (e.g. HTTP 403, bot protection). Open them manually to inspect.
                  </p>
                )}
              </Card>

              {candidates.length === 0 ? (
                <Card className="p-8 text-center text-sm text-muted-foreground">
                  No candidates found in this run.
                </Card>
              ) : (
                <div className="space-y-2">
                  {candidates.map((c) => {
                    const bucket = bucketFor(c);
                    const fr = c.final_resolution || "";
                    const resLabel = RESOLUTION_LABEL[fr] || fr || "Pending";
                    const borderClass =
                      bucket === "extracted" ? "border-emerald-500/30" :
                      bucket === "blocked" ? "border-amber-500/30" : "";
                    const badgeClass =
                      bucket === "extracted" ? "bg-emerald-500/15 text-emerald-500 border-emerald-500/30" :
                      bucket === "blocked" ? "bg-amber-500/15 text-amber-500 border-amber-500/30" :
                      bucket === "invalid" ? "bg-rose-500/10 text-rose-500 border-rose-500/30" :
                      "bg-muted text-muted-foreground";
                    return (
                      <Card key={c.id} className={`p-3 ${borderClass}`}>
                        <div className="flex gap-3">
                          <img
                            src={c.image_url || "/placeholder.svg"}
                            alt={c.source_title || "Candidate"}
                            className="w-14 h-14 object-contain rounded bg-muted/40 flex-shrink-0"
                            loading="lazy"
                          />
                          <div className="flex-grow min-w-0">
                            <div className="flex flex-wrap items-center gap-2 mb-1">
                              <span className="text-xs font-medium text-muted-foreground">{c.domain}</span>
                              {c.source_type && <Badge variant="outline" className="text-[10px]">{c.source_type}</Badge>}
                              <Badge variant="outline" className={`text-[10px] ${badgeClass}`}>
                                {bucket === "blocked" && <ShieldAlert className="h-2.5 w-2.5 mr-1" />}
                                {resLabel}
                              </Badge>
                              {c.match_score != null && (
                                <Badge variant="outline" className="text-[10px]">match {c.match_score}%</Badge>
                              )}
                            </div>
                            <div className="text-sm font-medium line-clamp-1">{c.source_title || c.source_url}</div>
                            {bucket === "blocked" ? (
                              <div className="text-xs text-amber-500/90 mt-0.5">
                                Candidate found, but supplier page blocked automated verification — open it manually to confirm price.
                              </div>
                            ) : c.source_snippet ? (
                              <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{c.source_snippet}</div>
                            ) : null}
                          </div>
                          <div className="flex flex-col items-end gap-1 flex-shrink-0">
                            {c.current_price != null && bucket === "extracted" && (
                              <div className="text-right">
                                <div className="font-semibold">{c.currency || "USD"} {Number(c.current_price).toFixed(2)}</div>
                                {c.original_price != null && c.original_price > c.current_price && (
                                  <div className="text-[11px] text-muted-foreground line-through">
                                    {Number(c.original_price).toFixed(2)}
                                  </div>
                                )}
                              </div>
                            )}
                            <a href={c.source_url} target="_blank" rel="noreferrer">
                              <Button size="sm" variant={bucket === "blocked" ? "default" : "outline"} className="h-7 text-[11px]">
                                {bucket === "blocked" ? "Open manually" : "Open"} <ExternalLink className="h-3 w-3 ml-1" />
                              </Button>
                            </a>
                          </div>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
            </>
            );
          })()}
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default UserSupplierDiscovery;
