import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { supabase } from "@/integrations/supabase/client";
import {
  Loader2, Search, ExternalLink, CheckCircle2, AlertTriangle,
  XCircle, Image as ImageIcon, FileSearch, Tag, MapPin,
} from "lucide-react";
import { toast } from "sonner";

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
  needs_review?: boolean;
  review_reasons?: string[];
  page_type?: string;
  cached?: boolean;
  phase1_status?: string;
  phase2_status?: string;
  final_resolution?: string;
  error: string | null;
}

interface DetectionResult {
  name: string | null;
  path: string | null;
  url: string | null;
  confidence: "high" | "medium" | "low";
  source: string;
  listing_verified?: boolean;
  verification_status?: "verified_from_listing" | "not_verified_first_page" | "verification_failed";
  verification?: {
    listing_verified: boolean;
    state?: "verified" | "not_verified_first_page" | "failed";
    reason: string;
    category_url_checked: string | null;
    product_id_checked: string | null;
    product_link_count?: number;
    matched_via?: string;
  };
}

interface InspectionData {
  productUrl: string;
  supplierDomain: string | null;
  extraction: ExtractionResult | null;
  extractionError: string | null;
  detection: DetectionResult | null;
  detectionError: string | null;
}

const StatusPill = ({
  ok, label,
}: { ok: boolean | null; label: string }) => {
  if (ok === null) {
    return <Badge variant="outline" className="text-xs">{label}</Badge>;
  }
  return ok ? (
    <Badge className="text-xs gap-1 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30">
      <CheckCircle2 className="h-3 w-3" /> {label}
    </Badge>
  ) : (
    <Badge variant="secondary" className="text-xs gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
      <AlertTriangle className="h-3 w-3" /> {label}
    </Badge>
  );
};

const Field = ({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) => (
  <div className="grid grid-cols-[140px,1fr] gap-3 text-sm">
    <div className="text-muted-foreground">{label}</div>
    <div className={mono ? "font-mono text-xs break-all" : "break-words"}>
      {value ?? <span className="text-muted-foreground italic">—</span>}
    </div>
  </div>
);

export default function ProductInspectorTab() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<InspectionData | null>(null);

  const inspect = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      toast.error("Paste a supplier product URL first");
      return;
    }
    let supplierDomain: string | null = null;
    try {
      supplierDomain = new URL(trimmed).hostname.replace(/^www\./, "");
    } catch {
      toast.error("Invalid URL");
      return;
    }
    setLoading(true);
    setData(null);

    // Run both diagnostics in parallel — read-only / single product
    const [extractRes, detectRes] = await Promise.allSettled([
      supabase.functions.invoke("extract-product-price", {
        body: { url: trimmed, force_refresh: true },
      }),
      supabase.functions.invoke("detect-supplier-category", {
        body: { product_url: trimmed },
      }),
    ]);

    let extraction: ExtractionResult | null = null;
    let extractionError: string | null = null;
    if (extractRes.status === "fulfilled") {
      const { data: ed, error } = extractRes.value;
      if (error) extractionError = error.message;
      else extraction = ed as ExtractionResult;
    } else {
      extractionError = extractRes.reason?.message || "Extraction failed";
    }

    let detection: DetectionResult | null = null;
    let detectionError: string | null = null;
    if (detectRes.status === "fulfilled") {
      const { data: dd, error } = detectRes.value;
      if (error) detectionError = error.message;
      else if (!dd?.ok) detectionError = dd?.error || "Could not detect category";
      else detection = dd.detection as DetectionResult;
    } else {
      detectionError = detectRes.reason?.message || "Detection failed";
    }

    setData({
      productUrl: trimmed,
      supplierDomain,
      extraction,
      extractionError,
      detection,
      detectionError,
    });
    setLoading(false);
  };

  const ext = data?.extraction;
  const det = data?.detection;
  const ver = det?.verification;

  // Verification tri-state: verified | not_verified_first_page (soft warning) | failed (hard)
  const verState = det?.verification?.state ?? (det?.listing_verified ? "verified" : undefined);
  const verHardFailed = verState === "failed";
  const verSoftWarn = verState === "not_verified_first_page";

  // Scan suitability — only block on extraction failure or HARD verification failure.
  // "Not on first page" is a warning, not a blocker (Target/Walmart paginate listings).
  const extractionOk = !!ext && !!ext.title && ext.price_current != null;
  const scanSafe = extractionOk && !!det?.url && !verHardFailed;

  const scanReasons: string[] = [];
  const scanWarnings: string[] = [];
  if (data) {
    if (!ext) scanReasons.push("Product extraction failed");
    else {
      if (!ext.title) scanReasons.push("Missing title");
      if (ext.price_current == null) scanReasons.push("Missing price");
      if (ext.needs_review) scanWarnings.push("Extraction flagged needs_review");
    }
    if (!det) scanReasons.push("Category not detected");
    else {
      if (!det.url) scanReasons.push("No category URL discovered");
      if (det.url && verHardFailed) {
        scanReasons.push(
          `Category listing could not be verified${det.verification?.reason ? ` (${det.verification.reason.replace(/_/g, " ")})` : ""}`,
        );
      }
      if (det.url && verSoftWarn) {
        scanWarnings.push(
          "Product not found on first page of category listing — may exist on later pages (suppliers paginate/personalize results). Category is likely still valid.",
        );
      }
    }
  }

  return (
    <div className="space-y-6">
      {/* Input */}
      <Card className="p-5 bg-card/50 backdrop-blur border-border/50">
        <div className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Supplier Product Inspector</h2>
            <p className="text-xs text-muted-foreground">
              Paste a single supplier product URL to diagnose extraction, category detection, and listing verification. Read-only — does not affect saved scans.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1 relative">
              <FileSearch className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.target.com/p/..."
                className="pl-9"
                disabled={loading}
                onKeyDown={(e) => { if (e.key === "Enter") inspect(); }}
              />
            </div>
            <Button onClick={inspect} disabled={loading} className="min-w-[160px]">
              {loading ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Inspecting…</>
              ) : (
                <><Search className="h-4 w-4 mr-2" /> Inspect Product</>
              )}
            </Button>
          </div>
        </div>
      </Card>

      {!data && !loading && (
        <Card className="p-10 text-center text-muted-foreground bg-card/30 border-dashed">
          <FileSearch className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm">Paste a supplier product URL above to run diagnostics.</p>
        </Card>
      )}

      {data && (
        <>
          {/* Scan Suitability Summary */}
          <Card className={`p-5 border-2 ${
            scanSafe && !verSoftWarn
              ? "border-emerald-500/40 bg-emerald-500/5"
              : scanSafe && verSoftWarn
              ? "border-yellow-500/40 bg-yellow-500/5"
              : "border-amber-500/40 bg-amber-500/5"
          }`}>
            <div className="flex items-start gap-3">
              {scanSafe && !verSoftWarn ? (
                <CheckCircle2 className="h-6 w-6 text-emerald-500 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className={`h-6 w-6 shrink-0 mt-0.5 ${scanSafe ? "text-yellow-500" : "text-amber-500"}`} />
              )}
              <div className="flex-1">
                <h3 className="font-semibold">
                  {scanSafe && !verSoftWarn
                    ? "Safe to use for category scan"
                    : scanSafe && verSoftWarn
                    ? "Safe to use — with one caveat"
                    : "Not fully safe for category scan"}
                </h3>
                {scanReasons.length > 0 && (
                  <ul className="mt-2 text-xs text-muted-foreground space-y-1 list-disc list-inside">
                    {scanReasons.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                )}
                {scanWarnings.length > 0 && (
                  <ul className="mt-2 text-xs text-yellow-700 dark:text-yellow-400 space-y-1 list-disc list-inside">
                    {scanWarnings.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                )}
                <div className="mt-3 text-xs text-muted-foreground">
                  Domain: <span className="font-mono">{data.supplierDomain}</span>
                </div>
              </div>
            </div>
          </Card>

          <div className="grid lg:grid-cols-2 gap-4">
            {/* Product Extraction */}
            <Card className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold flex items-center gap-2">
                  <Tag className="h-4 w-4 text-primary" />
                  Product extraction
                </h3>
                {ext && (
                  <StatusPill
                    ok={!!ext.title && ext.price_current != null && !ext.needs_review}
                    label={ext.needs_review ? "Needs review" : ext.title && ext.price_current != null ? "OK" : "Partial"}
                  />
                )}
              </div>

              {data.extractionError && (
                <div className="text-xs text-destructive bg-destructive/10 p-2 rounded flex items-start gap-2">
                  <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{data.extractionError}</span>
                </div>
              )}

              {ext && (
                <>
                  {ext.image_url && (
                    <div className="flex justify-center bg-muted/30 rounded p-2">
                      <img
                        src={ext.image_url}
                        alt={ext.title || "product"}
                        className="max-h-40 object-contain"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    </div>
                  )}
                  <div className="space-y-2">
                    <Field label="Title" value={ext.title} />
                    <Field
                      label="Price"
                      value={
                        ext.price_current != null ? (
                          <span className="font-mono">
                            {ext.currency || "$"}{Number(ext.price_current).toFixed(2)}
                            {ext.price_original && ext.price_original !== ext.price_current && (
                              <span className="ml-2 line-through text-muted-foreground">
                                {ext.currency || "$"}{Number(ext.price_original).toFixed(2)}
                              </span>
                            )}
                          </span>
                        ) : null
                      }
                    />
                    <Field label="Currency" value={ext.currency} mono />
                    <Field label="Availability" value={ext.availability} />
                    <Field label="Variant" value={ext.variant} />
                    <Field
                      label="Image URL"
                      value={ext.image_url ? (
                        <a href={ext.image_url} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                          <ImageIcon className="h-3 w-3" /> Open image
                        </a>
                      ) : null}
                    />
                    <Separator className="my-2" />
                    <Field label="Extraction method" value={<Badge variant="outline" className="text-xs font-mono">{ext.extraction_method}</Badge>} />
                    <Field label="Confidence" value={`${Math.round((ext.confidence_score || 0) * 100)}%`} />
                    <Field label="Raw price text" value={ext.raw_price_text} mono />
                    <Field label="Page type" value={ext.page_type} />
                    <Field label="Phase 1 status" value={ext.phase1_status} />
                    <Field label="Phase 2 status" value={ext.phase2_status} />
                    <Field label="Final resolution" value={ext.final_resolution} />
                    {ext.review_reasons && ext.review_reasons.length > 0 && (
                      <Field
                        label="Review reasons"
                        value={
                          <div className="flex flex-wrap gap-1">
                            {ext.review_reasons.map((r, i) => (
                              <Badge key={i} variant="secondary" className="text-[10px]">{r}</Badge>
                            ))}
                          </div>
                        }
                      />
                    )}
                  </div>
                </>
              )}
            </Card>

            {/* Category Detection + Verification */}
            <Card className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-primary" />
                  Category detection
                </h3>
                {det && (
                  <Badge
                    variant={det.confidence === "high" ? "default" : "secondary"}
                    className="text-xs capitalize"
                  >
                    {det.confidence}
                  </Badge>
                )}
              </div>

              {data.detectionError && (
                <div className="text-xs text-destructive bg-destructive/10 p-2 rounded flex items-start gap-2">
                  <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{data.detectionError}</span>
                </div>
              )}

              {det && (
                <div className="space-y-2">
                  <Field label="Category name" value={det.name} />
                  <Field label="Full path" value={det.path} />
                  <Field
                    label="Category URL"
                    value={det.url ? (
                      <a href={det.url} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1 break-all">
                        <span className="font-mono text-xs">{det.url}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    ) : null}
                  />
                  <Field
                    label="Source"
                    value={<Badge variant="outline" className="text-xs capitalize">{det.source.replace(/_/g, " ")}</Badge>}
                  />

                  <Separator className="my-2" />

                  <div className="flex items-center gap-2 text-sm font-medium flex-wrap">
                    Listing verification
                    {verState === "verified" && (
                      <Badge className="text-xs gap-1 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30">
                        <CheckCircle2 className="h-3 w-3" /> Verified on listing
                      </Badge>
                    )}
                    {verState === "not_verified_first_page" && (
                      <Badge className="text-xs gap-1 bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/30">
                        <AlertTriangle className="h-3 w-3" /> Not on first page
                      </Badge>
                    )}
                    {verState === "failed" && (
                      <Badge variant="secondary" className="text-xs gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                        <XCircle className="h-3 w-3" /> Verification failed
                      </Badge>
                    )}
                  </div>

                  {verState === "not_verified_first_page" && (
                    <div className="text-xs text-yellow-700 dark:text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 rounded p-2">
                      Product not found on first page of category listing. Many suppliers (Target, Walmart, Amazon)
                      paginate, personalize, or rotate listings — the category is likely still valid. The product may
                      appear on later pages.
                    </div>
                  )}

                  {ver && (
                    <div className="space-y-2 pl-2 border-l-2 border-border ml-1">
                      <Field
                        label="Reason"
                        value={
                          <span className={
                            verState === "verified"
                              ? "text-emerald-600 dark:text-emerald-400"
                              : verState === "not_verified_first_page"
                              ? "text-yellow-700 dark:text-yellow-400"
                              : "text-amber-700 dark:text-amber-400"
                          }>
                            {ver.reason.replace(/_/g, " ")}
                          </span>
                        }
                      />
                      <Field label="Matched via" value={ver.matched_via} mono />
                      <Field label="Product ID checked" value={ver.product_id_checked} mono />
                      <Field
                        label="URL checked"
                        value={ver.category_url_checked ? (
                          <a href={ver.category_url_checked} target="_blank" rel="noreferrer" className="text-primary hover:underline font-mono text-xs break-all">
                            {ver.category_url_checked}
                          </a>
                        ) : null}
                      />
                      <Field
                        label="Product links seen"
                        value={typeof ver.product_link_count === "number" ? `${ver.product_link_count} links on page 1` : null}
                      />
                    </div>
                  )}
                </div>
              )}
            </Card>
          </div>

          {/* Footer: source URL */}
          <Card className="p-3 bg-muted/30">
            <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
              <span>Source URL:</span>
              <a href={data.productUrl} target="_blank" rel="noreferrer" className="font-mono text-primary hover:underline inline-flex items-center gap-1 break-all">
                {data.productUrl}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
