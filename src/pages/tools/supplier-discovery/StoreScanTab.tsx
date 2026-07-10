import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Loader2, Play, Store, ExternalLink, History, Target, Trash2, Save, RefreshCw, Search, X, Check } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { StoreScanRoiCell } from "./StoreScanRoiCell";
import { FirecrawlCreditsBadge } from "@/components/FirecrawlCreditsBadge";
import { CategoryDetector, type DetectedCategory } from "@/components/scan-categories/CategoryDetector";
import AddSupplierDialog from "./AddSupplierDialog";
import { normalizeSupplierImageUrl } from "./lib/normalizeImage";

interface ScanProfile {
  id: string;
  domain: string;
  display_name: string;
  max_pages_per_run: number;
  max_products_per_run: number;
  is_enabled: boolean;
  notes: string | null;
}

interface ScanRun {
  id: string;
  supplier_domain: string;
  scope_urls: string[];
  status: string;
  pages_crawled: number;
  products_found: number;
  products_new: number;
  products_extracted: number;
  products_matched: number;
  products_unmatched: number;
  products_blocked: number;
  products_failed: number;
  failure_reasons: Record<string, number> | null;
  max_products_cap: number;
  error_message: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at: string | null;
}

interface ScanItem {
  id: string;
  source_url: string;
  source_title: string | null;
  source_price: number | null;
  source_currency: string | null;
  source_image_url: string | null;
  matched_asin: string | null;
  amz_title: string | null;
  amz_price: number | null;
  amz_image_url: string | null;
  match_score: number | null;
  match_method: string | null;
  match_confidence?: string | null;
  amz_candidates?: Array<{
    asin: string | null;
    title: string | null;
    price: number | null;
    image: string | null;
    link?: string | null;
    score: number;
    confidence: string;
    verdict?: "exact_match" | "likely_match" | "same_base_product_different_pack" | "not_match" | null;
    engine_confidence?: number | null;
    decision_signal?: string | null;
    verdict_source?: "engine" | "ai" | "hybrid" | null;
    verdict_reason?: string | null;
  }> | null;
  normalized_query?: string | null;
  roi: number | null;
  margin_pct: number | null;
  status: string;
  error: string | null;
  created_at: string;
  is_new?: boolean | null;
  url_key?: string | null;
  product_id?: string | null;
  source_availability?: string | null;
  source_availability_status?: "in_stock" | "out_of_stock" | "preorder" | "backorder" | "unknown" | null;
  last_refresh_status?: string | null;
  // ── Precision layer (added Apr 2026): composite trust score, sanity flag,
  // and Review-bucket routing. All optional so legacy rows still render.
  confidence_score?: number | null;
  confidence_band?: "trusted" | "review" | "rejected" | null;
  price_sanity?: "ok" | "too_low" | "too_high" | "unknown" | null;
  review_required?: boolean | null;
  match_quality_signals?: Record<string, unknown> | null;
}

const hasImageMismatch = (item: Pick<ScanItem, "match_quality_signals">): boolean => {
  const signals = item.match_quality_signals;
  if (!signals || typeof signals !== "object") return false;
  return signals.image_mismatch === true;
};

// Phase 2: read normalized DB column first; fall back to parsing raw text
// for legacy rows that haven't been re-scanned yet.
type AdminStockState = "in_stock" | "out_of_stock" | "preorder" | "backorder" | "unknown";
const VALID_ADMIN_STOCK = new Set<AdminStockState>([
  "in_stock", "out_of_stock", "preorder", "backorder", "unknown",
]);
const normalizeAdminStockFromRaw = (raw?: string | null): AdminStockState => {
  if (!raw) return "unknown";
  const s = String(raw).toLowerCase().replace("https://schema.org/", "").replace("http://schema.org/", "");
  if (/instock|in_stock|in stock|available|add to cart|add to bag|limitedavailability|limited stock|only \d+ left/.test(s)) return "in_stock";
  if (/outofstock|out_of_stock|out of stock|sold ?out|unavailable|currently unavailable|no longer available|discontinued|soldout/.test(s)) return "out_of_stock";
  if (/preorder|pre-order/.test(s)) return "preorder";
  if (/backorder|back-order/.test(s)) return "backorder";
  return "unknown";
};
const getAdminStockState = (item: { source_availability_status?: string | null; source_availability?: string | null }): AdminStockState => {
  const norm = item.source_availability_status as AdminStockState | null | undefined;
  if (norm && VALID_ADMIN_STOCK.has(norm) && norm !== "unknown") return norm;
  const fromRaw = normalizeAdminStockFromRaw(item.source_availability);
  if (fromRaw !== "unknown") return fromRaw;
  return (norm && VALID_ADMIN_STOCK.has(norm)) ? norm : "unknown";
};

const getStoreScanBlockedState = (status: string | null | undefined, raw: string | null | undefined) => {
  const s = (status ?? "").toLowerCase();
  const text = (raw ?? "").toLowerCase();
  const code = text.split(" ")[0]?.trim() ?? "";

  const blockedByReasonCode = code.startsWith("blocked_") || code === "render_timeout" || code === "render_failed";
  const blockedByHttp = /fetch failed:\s*http\s*403\b/i.test(raw ?? "");
  const blockedBySignals = /captcha|press\s*&?\s*hold|access denied|verify you are human|anti-bot|supplier_access_denied|cloudflare|perimeterx|datadome/i.test(text);

  return {
    isBlocked: blockedByReasonCode || blockedByHttp || blockedBySignals,
    isErrorLike: s === "error" || s === "partial",
    blockedByHttp,
    code,
  };
};

const prettifyStoreScanStatus = (
  status: string | null | undefined,
  raw: string | null | undefined,
  matchMethod?: string | null,
  lastRefreshStatus?: string | null,
  matchedAsin?: string | null,
) => {
  const method = (matchMethod ?? "").toLowerCase();
  const hasAsin = !!matchedAsin;

  // Listing-fallback recovery: PDP was blocked but we recovered title/image/price
  // from the category page. Differentiate three sub-states so users see the truth:
  //  - matched ASIN → "Matched (listing data)"  (green)
  //  - no Amazon hit → "No Amazon match"        (amber)
  //  - search not yet run → "Listing data only" (muted)
  if (lastRefreshStatus === "listing_fallback") {
    if (hasAsin) {
      return { label: "Matched (listing data)", className: "border-success/40 text-success" };
    }
    if (method === "no_results" || method === "no_valid_match" || method === "no_verified_match") {
      return { label: "No Amazon match", className: "border-amber-500/40 text-amber-300" };
    }
    return { label: "Listing data only", className: "border-muted-foreground text-muted-foreground" };
  }

  const blocked = getStoreScanBlockedState(status, raw);
  if (blocked.isBlocked && blocked.isErrorLike) {
    return { label: "Supplier protected", className: "border-amber-500/40 text-amber-300" };
  }

  switch ((status ?? "").toLowerCase()) {
    case "matched":
      return { label: "Open", className: "border-success text-success" };
    case "unmatched":
      if (method === "no_results") {
        return { label: "No Amazon match", className: "border-amber-500/40 text-amber-300" };
      }
      if (method === "no_valid_match" || method === "no_verified_match") {
        return { label: "Missing opportunity", className: "border-amber-500/40 text-amber-300" };
      }
      if (method === "queued" || method === "" || method === "extracted") {
        return { label: "Queued — not yet matched", className: "border-muted-foreground text-muted-foreground" };
      }
      return { label: "Not matched", className: "border-muted-foreground text-muted-foreground" };
    case "partial":
      return { label: "Skipped", className: "border-muted-foreground text-muted-foreground" };
    case "error":
      return { label: "Error", className: "border-destructive/40 text-destructive" };
    case "processing":
      return { label: "Processing", className: "border-primary/40 text-primary" };
    case "pending":
      return { label: "Queued", className: "border-muted-foreground text-muted-foreground" };
    case "cancelled":
      return { label: "Cancelled", className: "border-muted-foreground text-muted-foreground" };
    default:
      return { label: status || "—", className: "border-muted-foreground text-muted-foreground" };
  }
};

const prettifyStoreScanReason = (
  raw: string | null | undefined,
  status?: string | null | undefined,
  lastRefreshStatus?: string | null,
  matchedAsin?: string | null,
  matchMethod?: string | null,
) => {
  if (lastRefreshStatus === "listing_fallback") {
    if (matchedAsin) {
      return "Supplier protected — matched using listing data (title, image, price from category page).";
    }
    const m = (matchMethod ?? "").toLowerCase();
    if (m === "no_results" || m === "no_valid_match" || m === "no_verified_match") {
      return "Supplier protected — recovered listing data, but no Amazon match was found.";
    }
    return "Supplier protected — listing data captured. Amazon search pending.";
  }
  if (!raw) return null;

  const blocked = getStoreScanBlockedState(status, raw);
  if (blocked.isBlocked) {
    if (blocked.blockedByHttp) {
      return "Supplier blocked automated verification (HTTP 403). Open manually to confirm.";
    }
    switch (blocked.code) {
      case "blocked_target":
        return "Target blocked automated verification. Open manually to confirm.";
      case "blocked_walmart":
        return "Walmart blocked automated verification. Open manually to confirm.";
      case "render_timeout":
        return "Supplier blocked or delayed automated verification during rendering.";
      case "render_failed":
        return "Supplier blocked automated verification during browser rendering.";
      default:
        return "Supplier blocked automated verification. Open manually to confirm.";
    }
  }

  const code = raw.split(" ")[0].trim();
  switch (code) {
    case "price_missing":
      return "Price missing on supplier page";
    case "title_missing":
      return "Title missing on supplier page";
    case "title_ok_price_missing":
      return "Title found but no price";
    case "no_title_no_price":
      return "No title and no price found";
    case "render_ok_no_price":
      return "Page rendered but price not extracted";
    case "fetch_error":
      return "Supplier page fetch failed";
    case "fetch_timeout":
      return "Supplier page fetch timed out";
    case "non_product_page":
      return "Not a product page";
    case "worker_exception":
      return "Unexpected worker error";
    default:
      if (code.startsWith("unmatched_")) return "No Amazon match found";
      if (code.startsWith("extractor_4")) return "Extractor returned 4xx error";
      if (code.startsWith("extractor_5")) return "Extractor returned 5xx error";
      if (code.startsWith("matched_")) return "Matched with lower confidence";
      return raw.replace(/_/g, " ");
  }
};

interface CuratedCategory {
  id: string;
  name: string;
  supplier_domain: string;
  urls: string[];
}

const StoreScanTab = () => {
  const { user, session } = useAuth();
  const [profiles, setProfiles] = useState<ScanProfile[]>([]);
  // Persist supplier + curated-category selection so they survive any
  // re-render / re-mount (e.g. after a scan completes and parent components
  // refresh). Without this, the dropdowns appeared to "switch back to default".
  const [selectedDomain, setSelectedDomain] = useState<string>(
    () => (typeof window !== "undefined" ? sessionStorage.getItem("storeScan.selectedDomain") ?? "" : ""),
  );
  const [categoryUrlsRaw, setCategoryUrlsRaw] = useState<string>("");
  const [maxProducts, setMaxProducts] = useState<number>(10000);
  const [running, setRunning] = useState(false);
  const [activeRun, setActiveRun] = useState<ScanRun | null>(null);
  const [items, setItems] = useState<ScanItem[]>([]);
  const [pastRuns, setPastRuns] = useState<ScanRun[]>([]);
  const [minRoiPct, setMinRoiPct] = useState<number>(-100);
  const [searchQuery, setSearchQuery] = useState<string>("");
  // Quality bucket filter — routes rows into Trusted / Review / Rejected.
  // "all" shows trusted+review (the useful working set); "review" surfaces
  // only borderline rows; "rejected" shows likely-wrong matches; "any"
  // disables the filter entirely (legacy/unscored rows always pass).
  const [bucketFilter, setBucketFilter] = useState<"all" | "trusted" | "review" | "rejected" | "any">("all");
  const [liveRoi, setLiveRoi] = useState<Record<string, number | null>>({});
  const [livePrice, setLivePrice] = useState<Record<string, number | null>>({});
  const [pendingDelete, setPendingDelete] = useState<ScanRun | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 50;
  const [roiRefreshKey, setRoiRefreshKey] = useState<Record<string, number>>({});
  const [isAdmin, setIsAdmin] = useState(false);
  const [curatedCategories, setCuratedCategories] = useState<CuratedCategory[]>([]);

  // Detect admin role — only admins can re-fetch live Amazon prices/ROI
  // from SP-API. Regular users see saved values from the original scan only.
  useEffect(() => {
    if (!user?.id) { setIsAdmin(false); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();
      if (!cancelled) setIsAdmin(!!data);
    })();
    return () => { cancelled = true; };
  }, [user?.id]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(
    () => (typeof window !== "undefined" ? sessionStorage.getItem("storeScan.selectedCategoryId") ?? "" : ""),
  );

  // Mirror selection to sessionStorage so the dropdowns are sticky across re-renders.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (selectedDomain) sessionStorage.setItem("storeScan.selectedDomain", selectedDomain);
    else sessionStorage.removeItem("storeScan.selectedDomain");
  }, [selectedDomain]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (selectedCategoryId) sessionStorage.setItem("storeScan.selectedCategoryId", selectedCategoryId);
    else sessionStorage.removeItem("storeScan.selectedCategoryId");
  }, [selectedCategoryId]);
  const [runDebug, setRunDebug] = useState<{
    tone: "muted" | "info" | "success" | "error";
    message: string;
  }>({
    tone: "muted",
    message: "Idle — ready to run scan.",
  });
  const [newCategoryName, setNewCategoryName] = useState<string>("");
  const [savingCategory, setSavingCategory] = useState(false);
  const [saveFromRun, setSaveFromRun] = useState<ScanRun | null>(null);
  const [saveFromRunName, setSaveFromRunName] = useState<string>("");
  const [savingFromRun, setSavingFromRun] = useState(false);
  // Row selection for "Retry selected" bulk re-extraction
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [retryingSelected, setRetryingSelected] = useState(false);

  const selectedProfile = useMemo(
    () => profiles.find((p) => p.domain === selectedDomain) ?? null,
    [profiles, selectedDomain],
  );

  const categoryUrls = useMemo(
    () => categoryUrlsRaw.split("\n").map((s) => s.trim()).filter(Boolean),
    [categoryUrlsRaw],
  );

  const scopeLabel = useMemo(() => {
    if (!selectedProfile) return "Select a supplier to begin";
    const n = categoryUrls.length;
    if (n === 0) return `${selectedProfile.display_name} — paste at least one category URL`;
    return `Scanning ${selectedProfile.display_name} • ${n} categor${n === 1 ? "y" : "ies"} • cap ${maxProducts} products`;
  }, [selectedProfile, categoryUrls.length, maxProducts]);

  const runButtonDisabled = running || !selectedProfile || categoryUrls.length === 0;

  const runDebugClassName = useMemo(() => {
    if (runDebug.tone === "error") return "text-destructive";
    if (runDebug.tone === "success") return "text-success";
    if (runDebug.tone === "info") return "text-foreground";
    return "text-muted-foreground";
  }, [runDebug.tone]);

  const loadProfiles = useCallback(async () => {
    const { data } = await supabase
      .from("supplier_scan_profiles")
      .select("*")
      .eq("is_enabled", true)
      .order("display_name");
    if (data) setProfiles(data as ScanProfile[]);
  }, []);

  const loadCuratedCategories = useCallback(async () => {
    const { data } = await supabase
      .from("scan_categories")
      .select("id, name, supplier_domain, urls")
      .eq("is_active", true)
      .order("supplier_domain")
      .order("name");
    if (data) setCuratedCategories(data as CuratedCategory[]);
  }, []);

  const loadPastRuns = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("store_scan_runs")
      .select("*")
      .eq("user_id", user.id)
      .order("started_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(10);
    if (data) setPastRuns(data as ScanRun[]);
  }, [user]);

  const loadItems = useCallback(async (runId: string) => {
    const { data } = await supabase
      .from("store_scan_items")
      .select("*")
      .eq("run_id", runId)
      .order("created_at", { ascending: false });
    if (data) setItems(data as unknown as ScanItem[]);
  }, []);

  useEffect(() => { loadProfiles(); loadPastRuns(); loadCuratedCategories(); }, [loadProfiles, loadPastRuns, loadCuratedCategories]);

  // Poll active run — lightweight progress only (no row streaming).
  // ALSO acts as a stalled-run watchdog: if no DB progress for >2 min, calls
  // store-scan-run with mode=resume so the chunk loop self-recovers without
  // requiring the user to refresh or re-trigger anything manually.
  useEffect(() => {
    if (!activeRun || activeRun.status === "done" || activeRun.status === "error") return;
    let lastSeenUpdate = (activeRun as any).updated_at ?? (activeRun as any).started_at ?? new Date().toISOString();
    let lastProgressAt = Date.now();
    let resumeInFlight = false;

    const i = setInterval(async () => {
      const { data } = await supabase
        .from("store_scan_runs")
        .select("*")
        .eq("id", activeRun.id)
        .maybeSingle();
      if (!data) return;
      const next = data as ScanRun;
      setActiveRun(next);

      // Detect progress via updated_at change
      const nextUpdate = (next as any).updated_at ?? lastSeenUpdate;
      if (nextUpdate !== lastSeenUpdate) {
        lastSeenUpdate = nextUpdate;
        lastProgressAt = Date.now();
        // Refresh items table so users can watch matched/unmatched fill in
        // live instead of staring at "queued" rows until the run terminates.
        loadItems(next.id);
      }

      // Terminal — final table load + stop watchdog
      if (next.status === "done" || next.status === "error") {
        loadItems(next.id);
        loadPastRuns();
        return;
      }

      // Watchdog: if no progress for 2 min, auto-resume
      const STALL_MS = 120_000;
      if (!resumeInFlight && Date.now() - lastProgressAt > STALL_MS) {
        resumeInFlight = true;
        try {
          console.warn(`[StoreScan] run ${next.id} appears stalled — auto-resuming`);
          const { error: resumeErr } = await supabase.functions.invoke("store-scan-run", {
            body: { mode: "resume", run_id: next.id },
          });
          if (resumeErr) {
            console.error("[StoreScan] resume failed:", resumeErr);
          } else {
            toast.info("Scan was stalled — automatically resuming…");
            lastProgressAt = Date.now();
          }
        } finally {
          setTimeout(() => { resumeInFlight = false; }, 60_000);
        }
      }
    }, 2500);
    return () => clearInterval(i);
  }, [activeRun, loadItems, loadPastRuns]);

  const invokeStoreScan = useCallback(async (payload: {
    profile_id: string;
    supplier_domain: string;
    category_urls: string[];
    max_products: number;
    category_id?: string;
  }) => {
    console.log("[StoreScan] calling store-scan-run");
    const primary = await supabase.functions.invoke("store-scan-run", { body: payload });
    if (!primary.error) return primary;

    const primaryMessage = primary.error.message ?? "";
    const primaryName = (primary.error as any)?.name ?? "";
    const isTransportError =
      primaryName === "FunctionsFetchError" ||
      /Failed to send a request to the Edge Function|Failed to fetch/i.test(primaryMessage);

    if (!isTransportError) return primary;

    const accessToken = session?.access_token
      ?? (await supabase.auth.getSession()).data.session?.access_token
      ?? null;

    if (!accessToken) return primary;

    console.warn("[StoreScan] invoke transport failed, retrying direct fetch");
    setRunDebug({ tone: "info", message: "Primary request failed — retrying direct function call…" });

    try {
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/store-scan-run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        return {
          data: null,
          error: new Error(data?.error ?? `HTTP ${response.status}`),
        };
      }

      return { data, error: null };
    } catch (fetchError: any) {
      return {
        data: null,
        error: fetchError instanceof Error ? fetchError : new Error(String(fetchError)),
      };
    }
  }, [session?.access_token]);

  const upsertCuratedCategory = useCallback(async ({
    supplierDomain,
    name,
    urls,
    preferredCategoryId,
    silent = false,
  }: {
    supplierDomain: string;
    name: string;
    urls: string[];
    preferredCategoryId?: string;
    silent?: boolean;
  }): Promise<string> => {
    if (!user) throw new Error("Sign in first");

    const trimmedName = name.trim();
    const dedupedUrls = Array.from(new Set(urls.map((u) => u.trim()).filter(Boolean)));
    if (!supplierDomain) throw new Error("Select a supplier first");
    if (!trimmedName) throw new Error("Enter a category name");
    if (dedupedUrls.length === 0) throw new Error("Paste at least one category URL");

    let existing: CuratedCategory | null = null;
    if (preferredCategoryId) {
      existing = curatedCategories.find((c) => c.id === preferredCategoryId) ?? null;
    }
    if (!existing) {
      const { data: matches } = await supabase
        .from("scan_categories")
        .select("id, name, supplier_domain, urls")
        .eq("supplier_domain", supplierDomain)
        .ilike("name", trimmedName)
        .limit(1);
      if (matches && matches.length > 0) existing = matches[0] as CuratedCategory;
    }

    let categoryId: string;
    if (existing) {
      const merged = Array.from(new Set([...(existing.urls ?? []), ...dedupedUrls]));
      const added = merged.length - (existing.urls?.length ?? 0);
      const { error: updErr } = await supabase
        .from("scan_categories")
        .update({ urls: merged, is_active: true, name: trimmedName })
        .eq("id", existing.id);
      if (updErr) throw updErr;
      categoryId = existing.id;
      if (!silent) {
        toast.success(
          added > 0
            ? `Merged into "${existing.name}" (+${added} new URL${added === 1 ? "" : "s"})`
            : `"${existing.name}" already has these URLs — nothing to add`,
        );
      }
    } else {
      const { data, error } = await supabase
        .from("scan_categories")
        .insert({
          name: trimmedName,
          supplier_domain: supplierDomain,
          urls: dedupedUrls,
          created_by: user.id,
          is_active: true,
        })
        .select("id")
        .single();
      if (error || !data?.id) throw error ?? new Error("Failed to save category");
      categoryId = data.id;
      if (!silent) {
        toast.success(`Saved category "${trimmedName}" — users can now scan it directly`);
      }
    }

    setSelectedCategoryId(categoryId);
    setNewCategoryName(trimmedName);
    await loadCuratedCategories();
    return categoryId;
  }, [curatedCategories, loadCuratedCategories, user]);

  const handleRun = async () => {
    console.log("[StoreScan] Run Scan clicked", {
      running,
      hasUser: !!user,
      hasSession: !!session,
      hasSelectedProfile: !!selectedProfile,
      categoryUrlCount: categoryUrls.length,
      maxProducts,
    });

    setRunDebug({ tone: "info", message: "Clicked — validating scan inputs…" });

    if (!user) {
      console.warn("[StoreScan] blocked: missing user");
      setRunDebug({ tone: "error", message: "Error: sign in first." });
      toast.error("Sign in first");
      return;
    }
    if (!session) {
      console.warn("[StoreScan] blocked: missing session");
      setRunDebug({ tone: "error", message: "Error: session missing. Refresh and sign in again." });
      toast.error("Session missing — refresh and sign in again");
      return;
    }
    if (!selectedProfile) {
      console.warn("[StoreScan] blocked: missing supplier profile");
      setRunDebug({ tone: "error", message: "Error: select a supplier." });
      toast.error("Select a supplier");
      return;
    }
    if (categoryUrls.length === 0) {
      console.warn("[StoreScan] blocked: no category URLs");
      setRunDebug({ tone: "error", message: "Error: paste at least one category URL." });
      toast.error("Paste at least one category URL");
      return;
    }
    const bad = categoryUrls.find((u) => {
      try { return !new URL(u).hostname.toLowerCase().includes(selectedProfile.domain); }
      catch { return true; }
    });
    if (bad) {
      console.warn("[StoreScan] blocked: invalid category URL", bad);
      setRunDebug({ tone: "error", message: `Error: URL not on ${selectedProfile.domain}.` });
      toast.error(`URL not on ${selectedProfile.domain}: ${bad}`);
      return;
    }

    setRunning(true);
    try {
      let categoryIdForRun = selectedCategoryId || undefined;
      if (!categoryIdForRun && newCategoryName.trim()) {
        setRunDebug({ tone: "info", message: "Auto-saving detected category before scan…" });
        categoryIdForRun = await upsertCuratedCategory({
          supplierDomain: selectedProfile.domain,
          name: newCategoryName,
          urls: categoryUrls,
          silent: true,
        });
      }

      setRunDebug({ tone: "info", message: "Calling function — starting scan…" });
      const payload = {
        profile_id: selectedProfile.id,
        supplier_domain: selectedProfile.domain,
        category_urls: categoryUrls,
        max_products: maxProducts,
        category_id: categoryIdForRun,
      };
      console.log("[StoreScan] invoking store-scan-run with payload:", payload);

      const { data, error } = await invokeStoreScan(payload);
      console.log("[StoreScan] response:", { data, error });
      if (error) {
        const ctx: any = (error as any).context;
        let serverMsg = error.message;
        if (ctx instanceof Response) {
          try { const j = await ctx.json(); serverMsg = j.error ?? serverMsg; } catch { /* ignore */ }
        } else if (ctx?.body) {
          try {
            const parsed = typeof ctx.body === "string" ? JSON.parse(ctx.body) : ctx.body;
            serverMsg = parsed.error ?? serverMsg;
          } catch { /* ignore */ }
        }
        throw new Error(serverMsg);
      }
      if (data?.error) throw new Error(data.error);
      if (!data?.run_id) throw new Error("No run_id returned from server");

      setRunDebug({ tone: "success", message: "Run created — loading progress…" });
      toast.success("Scan started — crawling now…");
      const { data: runRow } = await supabase
        .from("store_scan_runs")
        .select("*")
        .eq("id", data.run_id)
        .maybeSingle();
      if (runRow) {
        setActiveRun(runRow as ScanRun);
        setItems([]);
      } else {
        setRunDebug({ tone: "success", message: "Run created — waiting for history to refresh…" });
      }
      loadPastRuns();
    } catch (e: any) {
      console.error("[StoreScan] scan failed:", e);
      setRunDebug({ tone: "error", message: `Error: ${e?.message ?? "Scan failed"}` });
      toast.error(e?.message ?? "Scan failed", { duration: 8000 });
    } finally {
      setRunning(false);
    }
  };

  // Per-bucket counts so the toggle can show how many rows live in each
  // tier without forcing the user to switch filters first.
  const bucketCounts = useMemo(() => {
    let trusted = 0, review = 0, rejected = 0, unscored = 0;
    for (const it of items) {
      if (!it.matched_asin) { unscored++; continue; }
      const hasMismatch = hasImageMismatch(it);
      const b = hasMismatch && it.confidence_band === "trusted" ? "review" : it.confidence_band;
      if (b === "trusted") trusted++;
      else if (b === "review" || it.review_required) review++;
      else if (b === "rejected") rejected++;
      else unscored++;
    }
    return { trusted, review, rejected, unscored };
  }, [items]);

  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return items.filter((item) => {
      const effectiveRoi = liveRoi[item.id] ?? item.roi;
      const passesRoi = minRoiPct <= -100 || (typeof effectiveRoi === "number" && effectiveRoi >= minRoiPct);
      if (!passesRoi) return false;

      // ── Confidence-bucket gate (price sanity + composite score)
      // Legacy rows without a confidence_band always pass so we never hide
      // historical scans. Unmatched / blocked / errored rows also bypass
      // the bucket filter — they have their own status badges.
      if (bucketFilter !== "any" && item.matched_asin) {
        const band = hasImageMismatch(item) && item.confidence_band === "trusted"
          ? "review"
          : (item.confidence_band ?? null);
        if (band) {
          if (bucketFilter === "trusted" && band !== "trusted") return false;
          if (bucketFilter === "review" && band !== "review" && !item.review_required) return false;
          if (bucketFilter === "rejected" && band !== "rejected") return false;
          // "all" → hide rejected, keep trusted + review
          if (bucketFilter === "all" && band === "rejected") return false;
        }
      }

      if (!query) return true;

      return [
        item.source_title,
        item.amz_title,
        item.matched_asin,
        item.source_url,
      ].some((value) => value?.toLowerCase().includes(query));
    });
  }, [items, liveRoi, minRoiPct, searchQuery, bucketFilter]);

  const handleLiveRoi = useCallback((itemId: string, roi: number | null) => {
    setLiveRoi((prev) => (prev[itemId] === roi ? prev : { ...prev, [itemId]: roi }));
  }, []);

  const handleLivePrice = useCallback((itemId: string, price: number | null) => {
    setLivePrice((prev) => (prev[itemId] === price ? prev : { ...prev, [itemId]: price }));
  }, []);

  const clearItemSelection = useCallback(() => {
    setSelectedItemIds(new Set());
  }, []);

  const toggleItemSelected = useCallback((itemId: string, checked: boolean) => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }, []);

  const togglePageSelected = useCallback((checked: boolean) => {
    const start = (currentPage - 1) * PAGE_SIZE;
    const end = currentPage * PAGE_SIZE;
    const visibleIds = filteredItems.slice(start, end).map((item) => item.id);

    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      for (const id of visibleIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, [PAGE_SIZE, currentPage, filteredItems]);

  const selectFailedOnly = useCallback(() => {
    const failedIds = filteredItems
      .filter((it) => it.status === "error" || it.status === "exception" || it.status === "failed" || it.status === "partial" || it.status === "unmatched" || !!it.error)
      .map((it) => it.id);

    setSelectedItemIds(new Set(failedIds));
    if (failedIds.length === 0) toast.info("No failed rows to select.");
  }, [filteredItems]);

  const retrySelectedItems = useCallback(async () => {
    toast.info("Retry selected is temporarily unavailable.");
  }, []);

  // Smart save: if a category with the same (supplier_domain, name) already
  // exists, OR a category is currently selected, merge the current URLs into
  // that existing record instead of creating a duplicate. This is the fix for
  // "I cannot link the same category I already have with a new scan".
  const handleSaveCategory = async () => {
    if (!selectedProfile) { toast.error("Select a supplier first"); return; }
    const bad = categoryUrls.find((u) => {
      try { return !new URL(u).hostname.toLowerCase().includes(selectedProfile.domain); }
      catch { return true; }
    });
    if (bad) { toast.error(`URL not on ${selectedProfile.domain}: ${bad}`); return; }

    setSavingCategory(true);
    try {
      await upsertCuratedCategory({
        supplierDomain: selectedProfile.domain,
        name: newCategoryName,
        urls: categoryUrls,
        preferredCategoryId: selectedCategoryId || undefined,
      });
    } catch (e: any) {
      console.error("[StoreScan] save category failed:", e);
      toast.error(e?.message ?? "Failed to save category");
    } finally {
      setSavingCategory(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Always-visible Min ROI filter — top of Store Scan */}
      <Card className="p-4 border-primary/30 bg-primary/5">
        <div className="flex items-center justify-between gap-4 mb-2">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-primary" />
            <Label className="text-sm font-semibold">Min ROI filter</Label>
            <Badge variant="outline" className="font-mono text-xs">
              {minRoiPct <= -100 ? "off (all incl. negative)" : `≥ ${minRoiPct}%`}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {[-100, 0, 10, 20, 30, 40, 50].map((v) => (
              <Button
                key={v}
                size="sm"
                variant={minRoiPct === v ? "default" : "outline"}
                className="h-7 px-2.5 text-xs"
                onClick={() => setMinRoiPct(v)}
              >
                {v === -100 ? "Off" : v === 0 ? "0%" : `${v}%`}
              </Button>
            ))}
          </div>
        </div>
        <Slider
          value={[minRoiPct]}
          min={-100}
          max={200}
          step={5}
          onValueChange={(v) => setMinRoiPct(v[0] ?? -100)}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Hides products below this ROI from the results table. Set to <strong>Off</strong> to see everything.
        </p>

        {/* ── Quality bucket filter (Trusted / Review / Rejected) ── */}
        <div className="mt-4 pt-4 border-t border-primary/20">
          <div className="flex items-center justify-between gap-4 mb-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Target className="h-4 w-4 text-primary" />
              <Label className="text-sm font-semibold">Match quality</Label>
              <Badge variant="outline" className="font-mono text-xs">
                {bucketFilter === "all" ? "trusted + review" : bucketFilter}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {([
                { id: "all", label: `All (${bucketCounts.trusted + bucketCounts.review})` },
                { id: "trusted", label: `Trusted (${bucketCounts.trusted})` },
                { id: "review", label: `Review (${bucketCounts.review})` },
                { id: "rejected", label: `Rejected (${bucketCounts.rejected})` },
                { id: "any", label: "Show all" },
              ] as const).map((opt) => (
                <Button
                  key={opt.id}
                  size="sm"
                  variant={bucketFilter === opt.id ? "default" : "outline"}
                  className="h-7 px-2.5 text-xs"
                  onClick={() => setBucketFilter(opt.id)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Routes matches by composite trust score (text + price sanity + verification depth).
            <strong> Review</strong> = borderline rows (e.g. large price gap) — open manually to confirm.
          </p>
        </div>
        <div className="mt-4 pt-4 border-t border-primary/20">
          <Label htmlFor="store-scan-search" className="text-sm font-semibold flex items-center gap-2 mb-2">
            <Search className="h-4 w-4 text-primary" />
            Search products
            {searchQuery.trim() && (
              <Badge variant="outline" className="font-mono text-xs">
                {filteredItems.length} match{filteredItems.length === 1 ? "" : "es"}
              </Badge>
            )}
          </Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              id="store-scan-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by supplier title, Amazon title, ASIN, or URL…"
              className="pl-9 pr-9"
            />
            {searchQuery && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card className="p-6 space-y-5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Store className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">Store Scan</h2>
            <Badge variant="secondary">Phase 2 · Beta</Badge>
          </div>
          <FirecrawlCreditsBadge />
        </div>
        <p className="text-sm text-muted-foreground">
          Pick a supplier, paste one or more category URLs, and we'll crawl those pages, extract products, and (next) match them to Amazon.
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>Supplier</Label>
              {isAdmin && (
                <div className="flex items-center gap-1">
                  {selectedProfile && (
                    <AddSupplierDialog
                      mode="edit"
                      editTarget={{
                        id: selectedProfile.id,
                        display_name: selectedProfile.display_name,
                        domain: selectedProfile.domain,
                      }}
                      onAdded={async (newDomain, oldDomain) => {
                        await loadProfiles();
                        // newDomain is "" when deleted — clear selection in that case
                        setSelectedDomain(newDomain || "");
                      }}
                    />
                  )}
                  <AddSupplierDialog
                    onAdded={async (newDomain) => {
                      await loadProfiles();
                      setSelectedDomain(newDomain);
                    }}
                  />
                </div>
              )}
            </div>
            <Select value={selectedDomain} onValueChange={setSelectedDomain}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a pilot supplier" />
              </SelectTrigger>
              <SelectContent>
                {profiles.map((p) => (
                  <SelectItem key={p.id} value={p.domain}>
                    {p.display_name} — {p.domain}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedProfile?.notes && (
              <p className="text-xs text-muted-foreground">{selectedProfile.notes}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Max products (cap)</Label>
            <Input
              type="number"
              min={5}
              max={10000}
              value={maxProducts}
              onChange={(e) => setMaxProducts(Math.max(5, Math.min(
                10000,
                Number(e.target.value) || 0,
              )))}
            />
            <p className="text-xs text-muted-foreground">
              Hard limit per scan (up to 10,000). Larger scans take longer and consume more Firecrawl credits.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Label>Curated category (optional — links results to user-facing Store Scan)</Label>
          {(() => {
            const visibleCategories = curatedCategories.filter(
              (c) => !selectedProfile || c.supplier_domain === selectedProfile.domain,
            );
            const isNoneSelected = !selectedCategoryId;
            const pickNone = () => {
              setSelectedCategoryId("");
              setNewCategoryName("");
            };
            const pickCategory = (id: string) => {
              if (selectedCategoryId === id) {
                // Click the already-selected row to deselect it.
                setSelectedCategoryId("");
                setNewCategoryName("");
                return;
              }
              setSelectedCategoryId(id);
              const cat = curatedCategories.find((c) => c.id === id);
              if (cat) {
                setCategoryUrlsRaw((cat.urls ?? []).join("\n"));
                setNewCategoryName(cat.name);
              }
            };
            return (
              <div
                role="listbox"
                aria-label="Curated category"
                aria-disabled={!selectedProfile}
                tabIndex={selectedProfile ? 0 : -1}
                className={`border border-input rounded-md bg-background max-h-64 overflow-y-auto divide-y divide-border/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${!selectedProfile ? "opacity-60 cursor-not-allowed" : ""}`}
              >
                {!selectedProfile ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    Select a supplier first
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isNoneSelected}
                      onClick={pickNone}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-accent transition-colors ${isNoneSelected ? "bg-accent/60 font-medium" : ""}`}
                    >
                      <span
                        className={`h-5 w-5 rounded border-2 flex items-center justify-center shrink-0 ${
                          isNoneSelected
                            ? "bg-primary border-primary text-primary-foreground"
                            : "border-muted-foreground/40 bg-background"
                        }`}
                      >
                        {isNoneSelected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                      </span>
                      <span className="text-muted-foreground italic">— Ad-hoc scan (URLs only, not visible to users) —</span>
                    </button>
                    {visibleCategories.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        No saved categories for this supplier yet.
                      </div>
                    ) : (
                      visibleCategories.map((c) => {
                        const checked = selectedCategoryId === c.id;
                        return (
                          <button
                            key={c.id}
                            type="button"
                            role="option"
                            aria-selected={checked}
                            onClick={() => pickCategory(c.id)}
                            className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-accent transition-colors ${checked ? "bg-accent/60 font-medium" : ""}`}
                          >
                            <span
                              className={`h-5 w-5 rounded border-2 flex items-center justify-center shrink-0 ${
                                checked
                                  ? "bg-primary border-primary text-primary-foreground"
                                  : "border-muted-foreground/40 bg-background"
                              }`}
                            >
                              {checked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                            </span>
                            <span className="flex-1 truncate">{c.name}</span>
                            <span className="text-xs text-muted-foreground shrink-0">
                              {c.urls?.length ?? 0} url{(c.urls?.length ?? 0) === 1 ? "" : "s"}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </>
                )}
              </div>
            );
          })()}
          {selectedCategoryId && (
            <p className="text-xs text-success">
              ✓ Results will appear in the user-facing Store Scan under this category.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label>Category URLs (one per line)</Label>
          <Textarea
            placeholder={selectedProfile
              ? `https://www.${selectedProfile.domain}/c/...\nhttps://www.${selectedProfile.domain}/c/...`
              : "https://www.target.com/c/electronics"}
            value={categoryUrlsRaw}
            onChange={(e) => setCategoryUrlsRaw(e.target.value)}
            rows={4}
            className="font-mono text-xs"
          />
          <CategoryDetector
            label="Don't want to pick a category? Paste a supplier product URL and we'll find it for you."
            onDetected={(d: DetectedCategory) => {
              // Pre-fill supplier dropdown if domain matches an enabled profile
              const profile = profiles.find((p) => p.domain.toLowerCase() === d.supplier_domain.toLowerCase());
              if (profile) {
                setSelectedDomain(profile.domain);
              } else {
                toast.warning(`Supplier "${d.supplier_domain}" is not in the enabled profiles list.`);
              }
              // Append the detected category URL into the scope textarea (de-duped)
              if (d.url) {
                const existing = categoryUrlsRaw
                  .split(/\r?\n/)
                  .map((s) => s.trim())
                  .filter(Boolean);
                if (!existing.some((u) => u.toLowerCase() === d.url!.toLowerCase())) {
                  const next = existing.concat([d.url]).join("\n");
                  setCategoryUrlsRaw(next);
                  toast.success(`Added detected category URL (${d.confidence} confidence)`);
                } else {
                  toast.info("Detected URL is already in the list");
                }
              } else {
                toast.info(`Detected "${d.name}" but no category URL was found on the page.`);
              }
              // Suggest a category name if empty — use the breadcrumb path WITHOUT the leading
              // store/root segment (e.g. drop "Target" from "Target > Toys > ...").
              if (!newCategoryName.trim() && (d.path || d.name)) {
                const rawPath = (d.path && d.path.trim().length > 0) ? d.path.trim() : d.name;
                const parts = rawPath.split(">").map((s) => s.trim()).filter(Boolean);
                const domainRoot = d.supplier_domain.split(".")[0]?.toLowerCase() ?? "";
                if (parts.length > 1 && domainRoot && parts[0].toLowerCase() === domainRoot) {
                  parts.shift();
                }
                setNewCategoryName(parts.join(" > "));
              }
            }}
          />
        </div>

        {pastRuns.length > 0 && (
          <div className="space-y-1 rounded-md border border-dashed border-primary/30 bg-primary/5 p-3">
            <Label className="text-xs text-muted-foreground">Load from a recent scan (auto-fills supplier + URLs, and links to its category if known)</Label>
            <Select
              value=""
              onValueChange={(runId) => {
                const run = pastRuns.find((r) => r.id === runId);
                if (!run) return;
                const profile = profiles.find((p) => p.domain === run.supplier_domain);
                if (profile) {
                  setSelectedDomain(profile.domain);
                } else {
                  toast.warning(`Supplier "${run.supplier_domain}" is not in the enabled profiles list.`);
                }
                const urls = Array.isArray(run.scope_urls) ? run.scope_urls : [];
                setCategoryUrlsRaw(urls.join("\n"));

                // Try to auto-link this run to an existing curated category
                // (same domain + overlapping URL) so rescans show the real name.
                const norm = (u: string) =>
                  u.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
                const runUrlSet = new Set(urls.map(norm));
                const matchedCategory = curatedCategories.find((c) => {
                  if (c.supplier_domain !== run.supplier_domain) return false;
                  const catUrls = (c.urls ?? []).map(norm);
                  if (catUrls.length === 0) return false;
                  return catUrls.some((u) => runUrlSet.has(u));
                });

                if (matchedCategory) {
                  setSelectedCategoryId(matchedCategory.id);
                  setNewCategoryName(matchedCategory.name);
                  toast.success(`Loaded "${matchedCategory.name}" — rescan ready`);
                } else {
                  setSelectedCategoryId("");
                  setNewCategoryName("");
                  toast.success(`Loaded ${urls.length} URL${urls.length === 1 ? "" : "s"} from ${run.supplier_domain}`);
                }
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Pick a previous scan to reuse its URLs…" />
              </SelectTrigger>
              <SelectContent>
                {pastRuns
                  .filter((r) => Array.isArray(r.scope_urls) && r.scope_urls.length > 0)
                  .map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.supplier_domain} · {r.scope_urls.length} url{r.scope_urls.length === 1 ? "" : "s"} · Last scan {new Date(r.started_at ?? r.created_at).toLocaleString()}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground pt-1">
              Categories are managed on the <span className="font-medium">Categories</span> page — rescans automatically reuse the existing category, no duplicates created.
            </p>
          </div>
        )}

        <div className="space-y-2 rounded-md bg-muted/50 px-3 py-2">
          <div className="flex items-center justify-between gap-4">
            <div className="text-xs text-muted-foreground">{scopeLabel}</div>
            <Button onClick={handleRun} disabled={runButtonDisabled}>
              {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              {running ? "Starting scan…" : "Run Scan"}
            </Button>
          </div>
          <div aria-live="polite" className={`text-xs ${runDebugClassName}`}>
            {runDebug.message}
          </div>
        </div>
      </Card>

      {activeRun && (
        <Card className="p-6 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              {(() => {
                const norm = (u: string) => {
                  try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/+$/, "").toLowerCase(); }
                  catch { return (u || "").trim().replace(/\/+$/, "").toLowerCase(); }
                };
                const runUrls = new Set((activeRun.scope_urls ?? []).map(norm));
                const matched = curatedCategories.find((c) => {
                  if (c.supplier_domain !== activeRun.supplier_domain) return false;
                  const catUrls = (c.urls ?? []).map(norm);
                  return catUrls.some((u) => runUrls.has(u));
                });
                const label = matched?.name ?? activeRun.supplier_domain;
                return <h3 className="font-semibold">Active run · {label}</h3>;
              })()}
              <Badge variant={activeRun.status === "done" ? "default" : "secondary"}>{activeRun.status}</Badge>
            </div>
            <div className="flex items-center gap-2">
              {activeRun.status !== "done" && activeRun.status !== "error" && (
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 gap-1 text-xs"
                  onClick={async () => {
                    if (!activeRun) return;
                    if (!confirm("Cancel this scan? Workers will stop claiming new chunks.")) return;
                    try {
                      const { error: updErr } = await supabase
                        .from("store_scan_runs")
                        .update({
                          status: "error",
                          error_message: "Cancelled by user",
                          completed_at: new Date().toISOString(),
                          chunk_lease_until: null,
                        })
                        .eq("id", activeRun.id);
                      if (updErr) throw updErr;
                      await supabase
                        .from("store_scan_items")
                        .update({ status: "cancelled", error: "Run cancelled by user" })
                        .eq("run_id", activeRun.id)
                        .eq("status", "pending");
                      toast.success("Scan cancelled");
                      setActiveRun({ ...activeRun, status: "error", error_message: "Cancelled by user" });
                      await loadPastRuns();
                      await loadItems(activeRun.id);
                    } catch (e: any) {
                      toast.error(`Failed to cancel: ${e?.message ?? e}`);
                    }
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Cancel scan
                </Button>
              )}
              {(() => {
                const errorCount = items.filter(
                  (it) => it.status === "error" || it.status === "exception" || it.status === "failed" || !!it.error,
                ).length;
                if (errorCount === 0) return null;
                return (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs text-destructive hover:bg-destructive/10"
                    onClick={async () => {
                      if (!activeRun) return;
                      const ids = items
                        .filter((it) => it.status === "error" || it.status === "exception" || it.status === "failed" || !!it.error)
                        .map((it) => it.id);
                      if (ids.length === 0) { toast.info("No errors to clear"); return; }
                      try {
                        const { error: delErr, data: del } = await supabase
                          .from("store_scan_items")
                          .delete()
                          .in("id", ids)
                          .select("id");
                        if (delErr) throw delErr;
                        toast.success(`Cleared ${del?.length ?? 0} error row${del?.length === 1 ? "" : "s"}`);
                        await loadItems(activeRun.id);
                      } catch (err: any) {
                        console.error("[StoreScan] clear errors failed:", err);
                        toast.error(err?.message ?? "Failed to clear errors");
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear {errorCount} error{errorCount === 1 ? "" : "s"}
                  </Button>
                );
              })()}
              <div className="text-xs text-muted-foreground">
                {new Date(activeRun.created_at).toLocaleString()}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-7">
            <div><span className="text-muted-foreground">Pages</span><div className="font-mono">{activeRun.pages_crawled}</div></div>
            <div><span className="text-muted-foreground">Found</span><div className="font-mono">{activeRun.products_found}</div></div>
            <div>
              <span className="text-muted-foreground">New</span>
              <div className="font-mono text-primary" title="Listings discovered for the first time in this scan">
                🔥 {activeRun.products_new ?? 0}
              </div>
            </div>
            <div><span className="text-muted-foreground">Extracted</span><div className="font-mono">{activeRun.products_extracted}</div></div>
            <div><span className="text-muted-foreground">Matched</span><div className="font-mono text-success">{activeRun.products_matched}</div></div>
            <div><span className="text-muted-foreground">Unmatched</span><div className="font-mono text-foreground">{activeRun.products_unmatched}</div></div>
            <div><span className="text-muted-foreground">Blocked</span><div className="font-mono text-destructive">{activeRun.products_blocked}</div></div>
            <div><span className="text-muted-foreground">Failed</span><div className="font-mono text-destructive">{activeRun.products_failed}</div></div>
          </div>

          {/* Live progress — visible while extracting so user sees "Processed X / Y" */}
          {activeRun.status === "extracting" && activeRun.products_found > 0 && (() => {
            const processed =
              (activeRun.products_extracted ?? 0) +
              (activeRun.products_unmatched ?? 0) +
              (activeRun.products_failed ?? 0);
            const total = activeRun.products_found ?? 0;
            const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
            return (
              <div className="rounded-md border bg-muted/20 p-3">
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-medium">Processed {processed} of {total}</span>
                  <span className="font-mono text-muted-foreground">{pct}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground">
                  Processing in chunks — this view updates every 2.5 s. Safe to leave open.
                </div>
              </div>
            );
          })()}

          {activeRun.failure_reasons && Object.keys(activeRun.failure_reasons).length > 0 && (
            <div className="rounded-md border bg-muted/30 p-3">
              <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">Failure reasons</div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(activeRun.failure_reasons).map(([k, v]) => (
                  <Badge key={k} variant="outline" className="text-xs">{k}: {v}</Badge>
                ))}
              </div>
            </div>
          )}

          {items.length > 0 && filteredItems.length === 0 && (
            <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
              No products meet Min ROI ≥ {minRoiPct}%. Lower the slider above to see more.
            </div>
          )}

          {filteredItems.length > 0 && (
            <div className="overflow-x-auto rounded-md border">
              <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-2 py-1.5">
                <span className="text-[11px] text-muted-foreground">
                  {isAdmin
                    ? "ROI shown is the saved value from the scan. Use the buttons to fetch fresh live prices + fees from Amazon."
                    : "ROI and Amazon price shown are from the most recent scan."}
                </span>
                {isAdmin && (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 text-xs"
                      onClick={() => {
                        const start = (currentPage - 1) * PAGE_SIZE;
                        const end = currentPage * PAGE_SIZE;
                        const visible = filteredItems.slice(start, end);
                        if (visible.length === 0) return;
                        const ts = Date.now();
                        setRoiRefreshKey((prev) => {
                          const next = { ...prev };
                          for (const it of visible) {
                            if (it.matched_asin && it.source_price && it.source_price > 0) {
                              next[it.id] = ts;
                            }
                          }
                          return next;
                        });
                        toast.info(`Refreshing ROI for ${visible.length} row${visible.length === 1 ? "" : "s"}…`);
                      }}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Refresh ROI (page)
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 text-xs"
                      onClick={() => {
                        // Only retry rows currently showing n/a (no live ROI AND no saved ROI),
                        // typically caused by SP-API throttling on the previous bulk refresh.
                        const naRows = filteredItems.filter((it) => {
                          if (!it.matched_asin || !it.source_price || it.source_price <= 0) return false;
                          const live = liveRoi[it.id];
                          const saved = it.roi;
                          const hasValue = (live != null && Number.isFinite(live)) || (saved != null && Number.isFinite(saved));
                          return !hasValue;
                        });
                        if (naRows.length === 0) {
                          toast.info("No n/a rows to fix.");
                          return;
                        }
                        const ts = Date.now();
                        setRoiRefreshKey((prev) => {
                          const next = { ...prev };
                          for (const it of naRows) next[it.id] = ts;
                          return next;
                        });
                        toast.info(`Retrying ${naRows.length} n/a row${naRows.length === 1 ? "" : "s"} (throttle-safe)…`);
                      }}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Fix n/a (throttled)
                    </Button>
                  </div>
                )}
              </div>
              {/* Selection / bulk-retry bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    onClick={selectFailedOnly}
                    disabled={retryingSelected}
                    title="Select all rows that failed extraction (Skipped / Error / Missing opportunity)"
                  >
                    Select failed only
                  </Button>
                  {selectedItemIds.size > 0 && (
                    <>
                      <Badge variant="outline" className="text-[11px]">
                        {selectedItemIds.size} selected
                      </Badge>
                      <Button
                        size="sm"
                        variant="default"
                        className="h-7 gap-1 text-xs"
                        onClick={retrySelectedItems}
                        disabled={retryingSelected}
                        title="Re-run extractor for the selected rows"
                      >
                        {retryingSelected
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <RefreshCw className="h-3.5 w-3.5" />}
                        Retry selected
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={clearItemSelection}
                        disabled={retryingSelected}
                      >
                        Clear
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase">
                  <tr>
                    <th className="p-2 w-8">
                      {(() => {
                        const start = (currentPage - 1) * PAGE_SIZE;
                        const end = currentPage * PAGE_SIZE;
                        const visible = filteredItems.slice(start, end);
                        const allSel = visible.length > 0 && visible.every((it) => selectedItemIds.has(it.id));
                        const someSel = visible.some((it) => selectedItemIds.has(it.id)) && !allSel;
                        return (
                          <Checkbox
                            checked={allSel ? true : someSel ? "indeterminate" : false}
                            onCheckedChange={(v) => togglePageSelected(v === true)}
                            aria-label="Select all rows on this page"
                          />
                        );
                      })()}
                    </th>
                    <th className="p-2 text-left">Image</th>
                    <th className="p-2 text-left">Title</th>
                    <th className="p-2 text-right">Price</th>
                    <th className="p-2 text-left">Match</th>
                    <th className="p-2 text-right">Amazon Price</th>
                    <th className="p-2 text-right">ROI</th>
                    <th className="p-2 text-left">Status</th>
                    <th className="p-2 text-left">Link</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map((it) => (
                    <tr key={it.id} className="border-t">
                      <td className="p-2">
                        <Checkbox
                          checked={selectedItemIds.has(it.id)}
                          onCheckedChange={(v) => toggleItemSelected(it.id, v === true)}
                          aria-label="Select row"
                        />
                      </td>
                      <td className="p-2">
                        {it.source_image_url
                          ? <img src={normalizeSupplierImageUrl(it.source_image_url) ?? ""} alt="" className="h-10 w-10 rounded object-cover" loading="lazy" />
                          : <div className="h-10 w-10 rounded bg-muted" />}
                      </td>
                      <td className="p-2 max-w-md truncate">
                        <div className="flex items-center gap-1.5">
                          {it.is_new && (
                            <Badge
                              variant="outline"
                              className="border-primary text-primary text-[10px] px-1 py-0 h-4 shrink-0"
                              title="Newly discovered in this scan"
                            >
                              NEW
                            </Badge>
                          )}
                          <span className="truncate">{it.source_title ?? "—"}</span>
                        </div>
                      </td>
                      <td className="p-2 text-right font-mono">
                        {it.source_price != null ? `${it.source_currency ?? "$"} ${it.source_price.toFixed(2)}` : "—"}
                      </td>
                      <td className="p-2">
                        {it.matched_asin ? (
                          <div className="flex flex-col gap-0.5">
                            <a href={`https://www.amazon.com/dp/${it.matched_asin}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                              <span className="font-mono text-xs">{it.matched_asin}</span>
                              {it.match_score != null && <span className="text-xs text-muted-foreground">({it.match_score}%)</span>}
                            </a>
                            {it.match_confidence && it.confidence_band !== "review" && it.confidence_band !== "rejected" && (
                              <Badge
                                variant="outline"
                                className={`text-[10px] w-fit ${
                                  it.match_confidence === "high" ? "border-success text-success"
                                  : it.match_confidence === "medium" ? "border-primary text-primary"
                                  : "border-muted-foreground text-muted-foreground"
                                }`}
                              >
                                {it.match_confidence}
                              </Badge>
                            )}
                          </div>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            <span className="text-xs text-muted-foreground">{it.match_method ?? "—"}</span>
                            {it.amz_candidates && it.amz_candidates.length > 0 && (() => {
                              const groups = {
                                exact: it.amz_candidates.filter((c) => c.verdict === "exact_match" || c.verdict === "same_base_product_different_pack"),
                                likely: it.amz_candidates.filter((c) => c.verdict === "likely_match"),
                                review: it.amz_candidates.filter((c) => !c.verdict || c.verdict === null),
                                rejected: it.amz_candidates.filter((c) => c.verdict === "not_match"),
                              };
                              const total = it.amz_candidates.length;
                              const renderRow = (c: typeof it.amz_candidates[number], idx: number) => (
                                <a
                                  key={`${c.asin}-${idx}`}
                                  href={c.asin ? `https://www.amazon.com/dp/${c.asin}` : c.link ?? "#"}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="block text-primary hover:underline truncate max-w-[260px]"
                                  title={`${c.title ?? ""}${c.verdict_reason ? ` — ${c.verdict_reason}` : ""}`}
                                >
                                  {c.engine_confidence != null ? `${c.engine_confidence}%` : `${c.score}%`} · {c.asin ?? "?"} · {c.title?.slice(0, 38) ?? ""}
                                </a>
                              );
                              return (
                                <details className="text-[10px]">
                                  <summary className="cursor-pointer text-primary hover:underline">
                                    {total} candidate{total > 1 ? "s" : ""}
                                    {groups.exact.length > 0 && <span className="ml-1 text-emerald-400">· {groups.exact.length} exact</span>}
                                    {groups.likely.length > 0 && <span className="ml-1 text-amber-400">· {groups.likely.length} likely</span>}
                                    {groups.review.length > 0 && <span className="ml-1 text-muted-foreground">· {groups.review.length} review</span>}
                                  </summary>
                                  <div className="mt-1 space-y-1.5">
                                    {groups.exact.length > 0 && (
                                      <div>
                                        <div className="text-emerald-400 font-semibold mb-0.5">Exact ({groups.exact.length})</div>
                                        <div className="space-y-0.5">{groups.exact.map(renderRow)}</div>
                                      </div>
                                    )}
                                    {groups.likely.length > 0 && (
                                      <div>
                                        <div className="text-amber-400 font-semibold mb-0.5">Likely ({groups.likely.length})</div>
                                        <div className="space-y-0.5">{groups.likely.map(renderRow)}</div>
                                      </div>
                                    )}
                                    {groups.review.length > 0 && (
                                      <div>
                                        <div className="text-muted-foreground font-semibold mb-0.5">Review needed ({groups.review.length})</div>
                                        <div className="space-y-0.5">{groups.review.slice(0, 5).map(renderRow)}</div>
                                      </div>
                                    )}
                                    {groups.rejected.length > 0 && (
                                      <div className="opacity-60">
                                        <div className="text-destructive font-semibold mb-0.5">Not match ({groups.rejected.length})</div>
                                        <div className="space-y-0.5">{groups.rejected.slice(0, 3).map(renderRow)}</div>
                                      </div>
                                    )}
                                  </div>
                                </details>
                              );
                            })()}
                          </div>
                        )}
                      </td>
                      <td className="p-2 text-right font-mono">
                        {(() => {
                          // Single source of truth: prefer the live price fetched by the
                          // ROI cell (or any sibling live call) over the saved scan value.
                          // This keeps Amazon Price visually consistent with the ROI it
                          // was calculated from — fixes the "ROI shown / price blank" desync.
                          const live = livePrice[it.id];
                          const saved = it.amz_price;
                          const display = (live != null && live > 0)
                            ? live
                            : (saved != null && saved > 0 ? Number(saved) : null);
                          if (display == null) return <span className="text-muted-foreground">—</span>;
                          return (
                            <span title={live != null && live > 0 ? "Live Amazon price" : "Saved Amazon price from scan"}>
                              ${display.toFixed(2)}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="p-2 text-right font-mono">
                        <StoreScanRoiCell
                          asin={it.matched_asin}
                          cost={it.source_price}
                          fallbackRoi={it.roi}
                          fallbackPrice={it.amz_price}
                          livePriceOverride={livePrice[it.id] ?? null}
                          liveRoiOverride={liveRoi[it.id] ?? null}
                          refreshKey={roiRefreshKey[it.id]}
                          onRoi={(roi) => handleLiveRoi(it.id, roi)}
                          onPrice={(price) => handleLivePrice(it.id, price)}
                        />
                      </td>
                      <td className="p-2">
                        {(() => {
                          const blocked = getStoreScanBlockedState(it.status, it.error);
                          const meta = prettifyStoreScanStatus(it.status, it.error, it.match_method, it.last_refresh_status, it.matched_asin);
                          const reason = prettifyStoreScanReason(it.error, it.status, it.last_refresh_status, it.matched_asin, it.match_method);
                          const band = it.confidence_band;
                          const score = typeof it.confidence_score === "number" ? it.confidence_score : null;
                          const sanity = it.price_sanity;
                          // Final-decision override: when the composite band downgrades the row,
                          // the legacy "Open"/"Matched" status is misleading. Replace it with the
                          // band so the user sees a single source of truth.
                          const finalMeta = band === "review"
                            ? { label: `Review${score != null ? ` · ${score}` : ""}`, className: "border-amber-500/40 text-amber-300" }
                            : band === "rejected"
                            ? { label: `Rejected${score != null ? ` · ${score}` : ""}`, className: "border-destructive/40 text-destructive" }
                            : band === "trusted"
                            ? { label: `Trusted${score != null ? ` · ${score}` : ""}`, className: "border-success text-success" }
                            : meta;
                          const sanityChip = sanity === "too_low"
                            ? { label: "Price too low — verify", className: "border-amber-500/40 text-amber-300" }
                            : sanity === "too_high"
                            ? { label: "Price too high — verify", className: "border-amber-500/40 text-amber-300" }
                            : null;
                          return (
                            <div className="flex flex-col gap-1">
                              <Badge variant="outline" className={`text-xs w-fit ${finalMeta.className}`} title={band ? "Composite trust score (text + price sanity + verification depth)" : undefined}>
                                {finalMeta.label}
                              </Badge>
                              {sanityChip && (
                                <Badge variant="outline" className={`text-[10px] w-fit ${sanityChip.className}`}>
                                  {sanityChip.label}
                                </Badge>
                              )}
                              {reason && (
                                <span className="max-w-[240px] text-[10px] leading-tight text-muted-foreground" title={it.error ?? undefined}>
                                  {reason}
                                </span>
                              )}
                              {blocked.isBlocked && (
                                <span className="text-[10px] text-amber-300/90">
                                  Keep visible for manual review.
                                </span>
                              )}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="p-2">
                        {(() => {
                          const blocked = getStoreScanBlockedState(it.status, it.error);
                          return (
                            <a href={it.source_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                              <ExternalLink className="h-3 w-3" /> {blocked.isBlocked ? "Open manually" : "open"}
                            </a>
                          );
                        })()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredItems.length > PAGE_SIZE && (() => {
                const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
                const safePage = Math.min(currentPage, totalPages);
                const startIdx = (safePage - 1) * PAGE_SIZE + 1;
                const endIdx = Math.min(safePage * PAGE_SIZE, filteredItems.length);
                return (
                  <div className="flex items-center justify-between gap-2 p-2 text-xs text-muted-foreground border-t">
                    <span>
                      Showing {startIdx}–{endIdx} of {filteredItems.length}
                      {minRoiPct > -100 ? ` (filtered, ROI ≥ ${minRoiPct}%)` : ""}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={safePage <= 1}
                        onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      >
                        Previous
                      </Button>
                      <span className="text-xs font-medium">
                        Page {safePage} of {totalPages}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={safePage >= totalPages}
                        onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </Card>
      )}

      {pastRuns.length > 0 && (
        <Card className="p-6 space-y-3">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4" />
            <h3 className="font-semibold text-sm">Recent scans</h3>
          </div>
          <div className="space-y-1">
            {pastRuns.map((r) => {
              const isSelected = activeRun?.id === r.id;
              const lastScanAt = r.started_at ?? r.created_at;
              return (
              <div
                key={r.id}
                className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/50 ${isSelected ? "border-primary bg-primary/5" : ""}`}
              >
                <label className="flex flex-1 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => {
                      if (isSelected) {
                        setActiveRun(null);
                        setItems([]);
                      } else {
                        setActiveRun(r);
                        loadItems(r.id);
                      }
                    }}
                    className="h-4 w-4 cursor-pointer accent-primary"
                    aria-label={`Select scan from ${r.supplier_domain}`}
                  />
                  <div className="flex flex-1 items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">{r.status}</Badge>
                      <span className="font-medium">{r.supplier_domain}</span>
                      <span className="text-xs text-muted-foreground">
                        {r.products_matched}✓ / {r.products_unmatched}? / {r.products_failed}✗ · {r.products_extracted}/{r.products_found} extracted · {r.pages_crawled}p
                      </span>
                      {isSelected && items.length > 0 && (() => {
                        const counts = items.reduce(
                          (acc, it) => {
                            const s = getAdminStockState(it);
                            acc[s] += 1;
                            return acc;
                          },
                          { in_stock: 0, out_of_stock: 0, preorder: 0, backorder: 0, unknown: 0 } as Record<AdminStockState, number>,
                        );
                        return (
                          <span
                            className="text-xs text-muted-foreground"
                            title="Supplier stock status across loaded items in this scan"
                          >
                            ·{" "}
                            <span className="text-emerald-600 dark:text-emerald-400">{counts.in_stock} in stock</span>
                            {" / "}
                            <span className="text-rose-600 dark:text-rose-400">{counts.out_of_stock} OOS</span>
                            {counts.preorder > 0 && (
                              <>
                                {" / "}
                                <span className="text-amber-600 dark:text-amber-400">{counts.preorder} preorder</span>
                              </>
                            )}
                            {counts.unknown > 0 && <> · {counts.unknown} unknown</>}
                          </span>
                        );
                      })()}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      Last scan: {new Date(lastScanAt).toLocaleString()}
                    </span>
                  </div>
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="ml-2 h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDelete(r);
                  }}
                  aria-label="Delete scan"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              );
            })}
          </div>
        </Card>
      )}

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => { if (!o) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete scan?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete ? (
                <>This will permanently delete the {pendingDelete.supplier_domain} scan from{" "}
                {new Date(pendingDelete.created_at).toLocaleString()} and all its results.</>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={async (e) => {
                e.preventDefault();
                if (!pendingDelete) return;
                setDeleting(true);
                try {
                  const runId = pendingDelete.id;
                  const { data: itemsDel, error: itemsErr } = await supabase
                    .from("store_scan_items").delete().eq("run_id", runId).select("id");
                  if (itemsErr) throw itemsErr;
                  const { data: runDel, error: runErr } = await supabase
                    .from("store_scan_runs").delete().eq("id", runId).select("id");
                  if (runErr) throw runErr;
                  // If the run row was already gone (or RLS hid it), still refresh
                  // the UI — the goal is "remove from my list", not strict consistency.
                  const wasAlreadyGone = !runDel || runDel.length === 0;
                  if (wasAlreadyGone) {
                    toast.success("Scan removed from list");
                  } else {
                    toast.success(`Scan deleted (${itemsDel?.length ?? 0} items)`);
                  }
                  if (activeRun?.id === runId) { setActiveRun(null); setItems([]); }
                  // Optimistically prune so stale rows disappear immediately even
                  // if the refresh is delayed.
                  setPastRuns((prev) => prev.filter((r) => r.id !== runId));
                  setPendingDelete(null);
                  await loadPastRuns();
                } catch (err: any) {
                  console.error("[StoreScan] delete failed:", err);
                  toast.error(err?.message ?? "Failed to delete scan");
                  // Still refresh in case the row was deleted before the error fired.
                  await loadPastRuns();
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={!!saveFromRun}
        onOpenChange={(o) => {
          if (!o && !savingFromRun) {
            setSaveFromRun(null);
            setSaveFromRunName("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save scan as category</DialogTitle>
            <DialogDescription>
              {saveFromRun ? (
                <>
                  Link <strong>{saveFromRun.scope_urls?.length ?? 0}</strong> URL
                  {(saveFromRun.scope_urls?.length ?? 0) === 1 ? "" : "s"} from{" "}
                  <strong>{saveFromRun.supplier_domain}</strong> as a named category.
                  <br />
                  <span className="text-xs text-muted-foreground">
                    💡 If a category with the same name already exists for this supplier,
                    these URLs will be <strong>merged</strong> into it (no duplicates created).
                  </span>
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Supplier</Label>
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm font-medium">
                {saveFromRun?.supplier_domain ?? "—"}
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Category name</Label>
              <Input
                placeholder='e.g. "Target — Electronics Clearance"'
                value={saveFromRunName}
                onChange={(e) => setSaveFromRunName(e.target.value)}
                disabled={savingFromRun}
                autoFocus
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs">URLs ({saveFromRun?.scope_urls?.length ?? 0})</Label>
              <div className="max-h-40 overflow-y-auto rounded-md border bg-muted/30 p-2 font-mono text-xs">
                {(saveFromRun?.scope_urls ?? []).map((u, i) => (
                  <div key={i} className="truncate" title={u}>{u}</div>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              disabled={savingFromRun}
              onClick={() => { setSaveFromRun(null); setSaveFromRunName(""); }}
            >
              Cancel
            </Button>
            <Button
              disabled={savingFromRun || !saveFromRun || !saveFromRunName.trim() || !(saveFromRun?.scope_urls?.length)}
              onClick={async () => {
                if (!user) { toast.error("Sign in first"); return; }
                if (!saveFromRun) return;
                const name = saveFromRunName.trim();
                if (!name) { toast.error("Enter a category name"); return; }
                const urls = Array.isArray(saveFromRun.scope_urls) ? saveFromRun.scope_urls : [];
                if (urls.length === 0) { toast.error("This scan has no URLs to save"); return; }
                setSavingFromRun(true);
                try {
                  // Smart merge: look up existing category by (supplier + name)
                  // and append URLs into it instead of creating a duplicate.
                  const { data: matches } = await supabase
                    .from("scan_categories")
                    .select("id, name, supplier_domain, urls")
                    .eq("supplier_domain", saveFromRun.supplier_domain)
                    .ilike("name", name)
                    .limit(1);
                  const existing = matches && matches.length > 0
                    ? (matches[0] as CuratedCategory)
                    : null;

                  if (existing) {
                    const merged = Array.from(new Set([...(existing.urls ?? []), ...urls]));
                    const added = merged.length - (existing.urls?.length ?? 0);
                    const { error: updErr } = await supabase
                      .from("scan_categories")
                      .update({ urls: merged, is_active: true })
                      .eq("id", existing.id);
                    if (updErr) throw updErr;
                    toast.success(
                      added > 0
                        ? `Merged into "${existing.name}" (+${added} new URL${added === 1 ? "" : "s"})`
                        : `"${existing.name}" already has these URLs`,
                    );
                    await loadCuratedCategories();
                    setSelectedCategoryId(existing.id);
                  } else {
                    const { data, error } = await supabase
                      .from("scan_categories")
                      .insert({
                        name,
                        supplier_domain: saveFromRun.supplier_domain,
                        urls,
                        created_by: user.id,
                        is_active: true,
                      })
                      .select("id, name, supplier_domain, urls")
                      .single();
                    if (error) throw error;
                    toast.success(`Saved category "${name}"`);
                    await loadCuratedCategories();
                    if (data?.id) setSelectedCategoryId(data.id);
                  }
                  setSaveFromRun(null);
                  setSaveFromRunName("");
                } catch (e: any) {
                  console.error("[StoreScan] save category from run failed:", e);
                  toast.error(e?.message ?? "Failed to save category");
                } finally {
                  setSavingFromRun(false);
                }
              }}
            >
              {savingFromRun ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              {/* Hint that the dialog will merge if a matching category exists */}
              Save / Merge category
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default StoreScanTab;
