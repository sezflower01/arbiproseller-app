import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Loader2, Link2, ExternalLink, Wand2, Search, History, Trash2, AlertTriangle, CheckCircle2, Database, Sparkles, RefreshCw, Eye, ShieldAlert, Bug
} from "lucide-react";

interface ExtractionResult {
  url: string;
  domain: string | null;
  title: string | null;
  price_current: number | null;
  price_original: number | null;
  currency: string | null;
  availability: string | null;
  image_url: string | null;
  variant: string | null;
  extraction_method: string;
  confidence_score: number;
  raw_price_text: string | null;
  raw_payload: Record<string, unknown> | null;
  error: string | null;
  needs_review?: boolean;
  review_reasons?: string[];
  page_type?: string;
  cached?: boolean;
  debug?: Record<string, unknown>;
  // Access-strategy fields
  phase1_status?: string;
  phase2_status?: string;
  block_provider?: string | null;
  final_resolution?: string;
  domain_policy?: string;
  cache_ttl_hours?: number;
}

interface HistoryRow extends ExtractionResult {
  id: string;
  created_at: string;
}

const BLOCK_PROVIDER_LABELS: Record<string, string> = {
  perimeterx: "PerimeterX",
  datadome_captcha: "DataDome",
  cloudflare_challenge: "Cloudflare",
  cloudflare_jschallenge: "Cloudflare JS",
  walmart_press_and_hold: "Walmart Press & Hold",
  walmart_short_block_page: "Walmart block page",
  press_and_hold_captcha: "Press & Hold CAPTCHA",
  generic_robot_check: "Robot check",
  access_denied: "Access denied",
  distil_networks: "Distil",
  generic_human_verify: "Human verify",
  empty_or_tiny_response: "Empty response",
};

const RESOLUTION_LABELS: Record<string, { label: string; tone: "good" | "ok" | "ai" | "bad" }> = {
  price_extracted: { label: "Price extracted", tone: "good" },
  blocked_phase1: { label: "Blocked (Phase 1)", tone: "bad" },
  blocked_phase2: { label: "Blocked (P1 + P2)", tone: "bad" },
  blocked_all_phases: { label: "Blocked (all phases)", tone: "bad" },
  phase2_timeout: { label: "Phase 2 timeout", tone: "bad" },
  phase2_render_failed: { label: "Phase 2 render failed", tone: "bad" },
  phase2_extract_failed: { label: "Phase 2: no price after render", tone: "ai" },
  not_found_unblocked: { label: "Not found (accessible)", tone: "ai" },
  non_product_page: { label: "Not a product page", tone: "bad" },
  fetch_error: { label: "Fetch error", tone: "bad" },
};

const PHASE_STATUS_LABELS: Record<string, { label: string; tone: "good" | "ok" | "ai" | "bad" }> = {
  success: { label: "✓ success", tone: "good" },
  blocked: { label: "✕ blocked", tone: "bad" },
  no_price_found: { label: "no price", tone: "ai" },
  timeout: { label: "✕ timeout", tone: "bad" },
  render_failed: { label: "✕ render failed", tone: "bad" },
  extract_failed: { label: "no price after render", tone: "ai" },
  skipped: { label: "skipped", tone: "ok" },
  not_run: { label: "not run", tone: "ok" },
  error: { label: "✕ failed (legacy)", tone: "bad" },
};

function toneClass(tone: "good" | "ok" | "ai" | "bad") {
  return tone === "good" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
    : tone === "ok" ? "bg-sky-500/15 text-sky-300 border-sky-500/30"
    : tone === "ai" ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
    : "bg-rose-500/15 text-rose-300 border-rose-500/30";
}

const METHOD_LABELS: Record<string, { label: string; tone: "good" | "ok" | "ai" | "bad" }> = {
  json_ld: { label: "JSON-LD (structured)", tone: "good" },
  json_ld_aggregate: { label: "JSON-LD (aggregate offer)", tone: "ok" },
  microdata_meta: { label: "Microdata / Meta", tone: "good" },
  walmart_next_data: { label: "Walmart __NEXT_DATA__", tone: "good" },
  hydration_next: { label: "Next.js hydration", tone: "ok" },
  hydration_shopify: { label: "Shopify JSON", tone: "ok" },
  hydration_state: { label: "Embedded state", tone: "ok" },
  selector_data_price: { label: "data-price selector", tone: "ok" },
  "selector_sale-price": { label: "Sale price selector", tone: "ok" },
  "selector_current-price": { label: "Current price selector", tone: "ok" },
  "selector_class-price": { label: "Generic .price selector", tone: "ok" },
  ai_fallback: { label: "AI fallback (last resort)", tone: "ai" },
  skipped_non_product: { label: "Skipped — not a product page", tone: "bad" },
  blocked_bot_challenge: { label: "Blocked — anti-bot challenge", tone: "bad" },
  phase2_timeout: { label: "Phase 2 — timeout", tone: "bad" },
  phase2_render_failed: { label: "Phase 2 — render failed", tone: "bad" },
  phase2_extract_failed: { label: "Phase 2 — no price after render", tone: "ai" },
  failed: { label: "No reliable price found", tone: "bad" },
};

function methodBadge(method: string) {
  // Handle Phase 2 browser-rendered methods: "browser_rendered_walmart_next_data" → "🌐 Browser + Walmart __NEXT_DATA__"
  let displayMethod = method;
  let prefix = "";
  if (method?.startsWith("browser_rendered_")) {
    prefix = "🌐 Browser + ";
    displayMethod = method.slice("browser_rendered_".length);
  }
  const m = METHOD_LABELS[displayMethod] || { label: displayMethod, tone: "ok" as const };
  const tone = prefix ? "good" : m.tone;
  const cls =
    tone === "good" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" :
    tone === "ok" ? "bg-sky-500/15 text-sky-300 border-sky-500/30" :
    tone === "ai" ? "bg-amber-500/15 text-amber-300 border-amber-500/30" :
    "bg-rose-500/15 text-rose-300 border-rose-500/30";
  return <Badge variant="outline" className={cls}>{prefix}{m.label}</Badge>;
}

function confidenceBadge(score: number) {
  const pct = Math.round((score || 0) * 100);
  let cls = "bg-rose-500/15 text-rose-300 border-rose-500/30";
  let label = "Low";
  if (pct >= 80) { cls = "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"; label = "High"; }
  else if (pct >= 60) { cls = "bg-sky-500/15 text-sky-300 border-sky-500/30"; label = "Medium"; }
  else if (pct >= 40) { cls = "bg-amber-500/15 text-amber-300 border-amber-500/30"; label = "Uncertain"; }
  return <Badge variant="outline" className={cls}>{label} · {pct}%</Badge>;
}

function fmtPrice(value: number | null, currency: string | null) {
  if (value == null) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency || ""} ${value.toFixed(2)}`.trim();
  }
}

const PriceExtractor = () => {
  const { user } = useAuth();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showDebug, setShowDebug] = useState(false);

  useEffect(() => {
    if (!user) { setIsAdmin(false); return; }
    supabase.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle()
      .then(({ data }) => setIsAdmin(!!data));
  }, [user]);

  const loadHistory = async () => {
    if (!user) return;
    setHistoryLoading(true);
    try {
      const { data, error } = await supabase
        .from("extracted_product_data")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(25);
      if (error) throw error;
      setHistory((data || []) as HistoryRow[]);
    } catch (e: any) {
      console.error(e);
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => { loadHistory(); }, [user]);

  const handleExtract = async (force = false) => {
    if (!url.trim()) {
      toast.error("Please enter a product URL");
      return;
    }
    let normalized = url.trim();
    if (!/^https?:\/\//i.test(normalized)) normalized = "https://" + normalized;

    setLoading(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("extract-product-price", {
        body: { url: normalized, save: true, force },
      });
      if (error) throw error;
      const r = data as ExtractionResult;
      setResult(r);
      if (r?.cached) {
        toast.info("Returned cached result (last 24h) — click Refresh to re-extract");
      } else if (r?.price_current && !r?.needs_review) {
        toast.success("Price extracted");
      } else if (r?.needs_review) {
        toast.warning("Result needs review — see flags below");
      } else {
        toast.warning(r?.error || "Could not extract a reliable price");
      }
      loadHistory();
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || "Extraction failed");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await supabase.from("extracted_product_data").delete().eq("id", id);
      if (error) throw error;
      setHistory(h => h.filter(r => r.id !== id));
      toast.success("Removed");
    } catch (e: any) {
      toast.error(e?.message || "Could not remove");
    }
  };

  const isFailed = result && (result.error || !result.price_current);
  const isAi = result?.extraction_method === "ai_fallback";

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)]">
      <Helmet>
        <title>Universal Price Extractor — ArbiProSeller</title>
        <meta name="description" content="Extract product prices from any URL with a layered pipeline: structured data, selectors, hydration state, and AI fallback." />
      </Helmet>

      <Navbar />

      <main className="flex-grow pt-24 pb-12 relative">
        <div className="container mx-auto px-4 max-w-5xl">
          <div className="mb-8">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-4">
              <Sparkles className="h-3.5 w-3.5" />
              <span>Phase 1 + AI fallback</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-bold text-white mb-2">
              Universal Price Extractor
            </h1>
            <p className="text-muted-foreground max-w-2xl">
              Paste any single-product URL. The pipeline tries JSON-LD, microdata, meta tags, common selectors, and embedded hydration data — falling back to AI only when nothing else works.
            </p>
          </div>

          {/* Input */}
          <Card className="p-5 bg-card/50 backdrop-blur border-border/50 mb-6">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1 relative">
                <Link2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.example.com/product/123"
                  className="pl-9"
                  disabled={loading}
                  onKeyDown={(e) => { if (e.key === "Enter") handleExtract(false); }}
                />
              </div>
              <Button onClick={() => handleExtract(false)} disabled={loading} className="min-w-[140px]">
                {loading ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Extracting…</>
                ) : (
                  <><Search className="h-4 w-4 mr-2" /> Extract price</>
                )}
              </Button>
              {result && !loading && (
                <Button onClick={() => handleExtract(true)} variant="outline" disabled={loading} title="Bypass 24h cache">
                  <RefreshCw className="h-4 w-4 mr-2" /> Refresh
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              Tip: works best on single product pages — not search or category pages.
            </p>
          </Card>

          {/* Result */}
          {result && (
            <Card className={`p-6 mb-8 border ${isFailed ? "border-rose-500/30 bg-rose-500/5" : "border-border/50 bg-card/50"} backdrop-blur`}>
              <div className="flex items-start gap-4">
                {result.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={result.image_url}
                    alt={result.title || "Product"}
                    className="w-24 h-24 object-contain rounded-md bg-muted/30 border border-border/40 flex-shrink-0"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                ) : (
                  <div className="w-24 h-24 rounded-md bg-muted/30 border border-border/40 flex items-center justify-center flex-shrink-0">
                    <Database className="h-8 w-8 text-muted-foreground" />
                  </div>
                )}

                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    {result.final_resolution && RESOLUTION_LABELS[result.final_resolution] && (
                      <Badge variant="outline" className={toneClass(RESOLUTION_LABELS[result.final_resolution].tone)}>
                        {RESOLUTION_LABELS[result.final_resolution].label}
                      </Badge>
                    )}
                    {methodBadge(result.extraction_method)}
                    {confidenceBadge(result.confidence_score)}
                    {result.block_provider && (
                      <Badge variant="outline" className="bg-rose-500/15 text-rose-300 border-rose-500/30">
                        <ShieldAlert className="h-3 w-3 mr-1" />
                        {BLOCK_PROVIDER_LABELS[result.block_provider] || result.block_provider}
                      </Badge>
                    )}
                    {result.cached && (
                      <Badge variant="outline" className="bg-sky-500/15 text-sky-300 border-sky-500/30">
                        <RefreshCw className="h-3 w-3 mr-1" />
                        Cached ({result.cache_ttl_hours ?? 24}h)
                      </Badge>
                    )}
                    {result.needs_review && (
                      <Badge variant="outline" className="bg-amber-500/15 text-amber-300 border-amber-500/30">
                        <ShieldAlert className="h-3 w-3 mr-1" /> Needs review
                      </Badge>
                    )}
                    {result.page_type && result.page_type !== "product" && result.page_type !== "unknown" && (
                      <Badge variant="outline" className="bg-rose-500/15 text-rose-300 border-rose-500/30">
                        Page: {result.page_type}
                      </Badge>
                    )}
                    {isAi && (
                      <Badge variant="outline" className="bg-amber-500/15 text-amber-300 border-amber-500/30">
                        <Wand2 className="h-3 w-3 mr-1" /> AI fallback
                      </Badge>
                    )}
                    {isFailed && !result.block_provider && (
                      <Badge variant="outline" className="bg-rose-500/15 text-rose-300 border-rose-500/30">
                        <AlertTriangle className="h-3 w-3 mr-1" /> {result.error || "No price found"}
                      </Badge>
                    )}
                  </div>

                  {(result.phase1_status || result.phase2_status) && (
                    <div className="flex flex-wrap items-center gap-1.5 mb-2 text-[11px] text-muted-foreground">
                      <span className="opacity-70">Access:</span>
                      {result.phase1_status && PHASE_STATUS_LABELS[result.phase1_status] && (
                        <Badge variant="outline" className={`${toneClass(PHASE_STATUS_LABELS[result.phase1_status].tone)} text-[10px] px-1.5 py-0 h-5`}>
                          P1 {PHASE_STATUS_LABELS[result.phase1_status].label}
                        </Badge>
                      )}
                      {result.phase2_status && result.phase2_status !== "not_run" && PHASE_STATUS_LABELS[result.phase2_status] && (
                        <Badge variant="outline" className={`${toneClass(PHASE_STATUS_LABELS[result.phase2_status].tone)} text-[10px] px-1.5 py-0 h-5`}>
                          P2 {PHASE_STATUS_LABELS[result.phase2_status].label}
                        </Badge>
                      )}
                      {result.domain_policy && (
                        <span className="opacity-60">· policy: <span className="font-mono">{result.domain_policy}</span></span>
                      )}
                    </div>
                  )}

                  <h2 className="text-lg font-semibold text-white truncate">
                    {result.title || result.domain || result.url}
                  </h2>
                  <a href={result.url} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1 mt-1">
                    {result.domain || result.url} <ExternalLink className="h-3 w-3" />
                  </a>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-5">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Current price</div>
                      <div className="text-2xl font-bold text-white">{fmtPrice(result.price_current, result.currency)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Original price</div>
                      <div className="text-base text-muted-foreground line-through">
                        {result.price_original ? fmtPrice(result.price_original, result.currency) : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Currency</div>
                      <div className="text-base text-white">{result.currency || "—"}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Availability</div>
                      <div className="text-base text-white truncate">{result.availability || "—"}</div>
                    </div>
                  </div>

                  {result.review_reasons && result.review_reasons.length > 0 && (
                    <>
                      <Separator className="my-4" />
                      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                        <div className="text-xs font-semibold text-amber-300 mb-1.5 inline-flex items-center gap-1.5">
                          <ShieldAlert className="h-3.5 w-3.5" /> Why this needs review
                        </div>
                        <ul className="text-xs text-amber-200/90 space-y-1 list-disc list-inside">
                          {result.review_reasons.map((r, i) => <li key={i}>{r}</li>)}
                        </ul>
                      </div>
                    </>
                  )}

                  {result.raw_price_text && (
                    <>
                      <Separator className="my-4" />
                      <div className="text-xs text-muted-foreground">
                        Raw match: <span className="font-mono text-foreground/80">{result.raw_price_text}</span>
                      </div>
                    </>
                  )}

                  {isAdmin && (
                    <>
                      <Separator className="my-4" />
                      <div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowDebug(s => !s)}
                          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <Bug className="h-3.5 w-3.5 mr-1.5" /> {showDebug ? "Hide" : "Show"} admin debug
                        </Button>
                        {showDebug && (
                          <pre className="mt-2 text-[10px] leading-relaxed bg-muted/30 border border-border/40 rounded-md p-3 overflow-auto max-h-72 text-foreground/80">
{JSON.stringify({
  final_resolution: result.final_resolution,
  domain_policy: result.domain_policy,
  cache_ttl_hours: result.cache_ttl_hours,
  phase1_status: result.phase1_status,
  phase2_status: result.phase2_status,
  block_provider: result.block_provider,
  page_type: result.page_type,
  extraction_method: result.extraction_method,
  confidence_score: result.confidence_score,
  cached: result.cached || false,
  needs_review: result.needs_review,
  review_reasons: result.review_reasons,
  raw_price_text: result.raw_price_text,
  debug: result.debug,
  raw_payload: result.raw_payload,
  error: result.error,
}, null, 2)}
                          </pre>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </Card>
          )}

          {/* History */}
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold text-white inline-flex items-center gap-2">
              <History className="h-4 w-4" /> Recent extractions
            </h3>
            <Button variant="ghost" size="sm" onClick={loadHistory} disabled={historyLoading}>
              {historyLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Refresh"}
            </Button>
          </div>

          <Card className="bg-card/50 backdrop-blur border-border/50 divide-y divide-border/40">
            {history.length === 0 && !historyLoading && (
              <div className="p-8 text-center text-sm text-muted-foreground">
                No extractions yet — paste a URL above to begin.
              </div>
            )}
            {history.map((row) => (
              <div key={row.id} className="p-4 flex items-center gap-4 hover:bg-muted/10 transition-colors">
                {row.image_url ? (
                  <img src={row.image_url} alt="" className="w-12 h-12 object-contain rounded bg-muted/30 border border-border/40 flex-shrink-0"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                ) : (
                  <div className="w-12 h-12 rounded bg-muted/30 border border-border/40 flex items-center justify-center flex-shrink-0">
                    <Database className="h-4 w-4 text-muted-foreground" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-white truncate max-w-md">
                      {row.title || row.domain || row.url}
                    </span>
                    {row.price_current ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                    <span>{row.domain}</span>
                    <span>·</span>
                    <span>{new Date(row.created_at).toLocaleString()}</span>
                    <span>·</span>
                    {methodBadge(row.extraction_method)}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-base font-semibold text-white">{fmtPrice(row.price_current, row.currency)}</div>
                  <div className="text-xs text-muted-foreground">{Math.round((row.confidence_score || 0) * 100)}% conf.</div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => handleDelete(row.id)}>
                  <Trash2 className="h-4 w-4 text-muted-foreground hover:text-rose-400" />
                </Button>
              </div>
            ))}
          </Card>
        </div>
      </main>
    </div>
  );
};

export default PriceExtractor;
