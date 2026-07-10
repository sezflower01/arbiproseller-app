import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import {
  ExternalLink, Loader2, Search, Store, Sparkles, FolderTree, RefreshCw,
  CheckCircle2, AlertTriangle, XCircle, HelpCircle, Wand2, ChevronDown, ChevronUp, Check,
  ShieldCheck, ShieldX, ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import FreshnessBadge from "@/components/FreshnessBadge";
import { MatchConfidenceBadge, ReasonChips, type MatchEvidence } from "@/components/scan/MatchConfidenceBadge";
import { StoreScanRoiCell } from "./supplier-discovery/StoreScanRoiCell";
import { enqueueRoi } from "./supplier-discovery/roiQueue";
import type { AmazonPresence } from "./supplier-discovery/useLiveRoi";
import { CategoryDetector, type DetectedCategory } from "@/components/scan-categories/CategoryDetector";
import SeedPdpCard from "./user-store-scan/SeedPdpCard";
import { normalizeSupplierImageUrl } from "./supplier-discovery/lib/normalizeImage";
import { useSubscription } from "@/hooks/use-subscription";

interface SupplierBucket { domain: string; count: number }
interface ScanCategory {
  id: string;
  name: string;
  supplier_domain: string;
  urls: string[];
  last_scanned_at?: string | null;
  last_successful_scan_at?: string | null;
}
type AIVerdict =
  | "exact_match"
  | "likely_match"
  | "same_base_product_different_pack"
  | "not_match";
type EligibilityStatus = 'pending' | 'checking' | 'approved' | 'restricted' | 'approval_required' | 'error';
const ELIGIBILITY_BATCH_SIZE = 5;
interface BrowseItem {
  id: string;
  source_url: string;
  source_title: string | null;
  source_price: number | null;
  source_currency: string | null;
  source_image_url: string | null;
  source_availability?: string | null;
  source_availability_status?: "in_stock" | "out_of_stock" | "preorder" | "backorder" | "unknown" | null;
  matched_asin: string | null;
  amz_title: string | null;
  amz_price: number | null;
  amz_image_url: string | null;
  match_score: number | null;
  match_method: string | null;
  match_confidence: string | null;
  roi: number | null;
  margin_pct: number | null;
  status: string | null;
  created_at: string;
  roi_source?: "user_fees" | "admin_stored";
  ai_verdict?: AIVerdict;
  ai_confidence?: number;
  ai_reason?: string;
  ai_evidence?: Record<string, unknown>;
  ai_verified_at?: string;
  no_match_reason?: string | null;
  amz_candidates?: Array<{
    asin: string | null;
    title: string | null;
    price: number | null;
    image: string | null;
    link?: string | null;
    score: number;
    confidence: string;
    verdict?: AIVerdict | null;
    engine_confidence?: number | null;
    decision_signal?: string | null;
    verdict_source?: "engine" | "ai" | "hybrid" | null;
    verdict_reason?: string | null;
  }> | null;
}

// ── Supplier stock normalization ──
// Phase 2: prefer the normalized `source_availability_status` column persisted
// by the extractor + scan writer. Fall back to parsing raw `source_availability`
// text only for legacy rows where the new column hasn't been populated yet.
type StockState = "in_stock" | "out_of_stock" | "preorder" | "backorder" | "unknown";
const VALID_STOCK_STATES = new Set<StockState>([
  "in_stock", "out_of_stock", "preorder", "backorder", "unknown",
]);
const normalizeStockFromRaw = (raw?: string | null): StockState => {
  if (!raw) return "unknown";
  const s = String(raw).toLowerCase().replace("https://schema.org/", "").replace("http://schema.org/", "");
  if (/instock|in_stock|in stock|available|add to cart|add to bag|limitedavailability|limited stock|only \d+ left/.test(s)) return "in_stock";
  if (/outofstock|out_of_stock|out of stock|sold ?out|unavailable|currently unavailable|no longer available|discontinued|soldout/.test(s)) return "out_of_stock";
  if (/preorder|pre-order/.test(s)) return "preorder";
  if (/backorder|back-order/.test(s)) return "backorder";
  return "unknown";
};
// Source of truth: normalized DB column. If missing or "unknown" AND we still
// have raw text, fall back to text parsing so admin-curated legacy rows keep
// showing badges until they're rescanned.
const getStockState = (item: { source_availability_status?: string | null; source_availability?: string | null }): StockState => {
  const norm = item.source_availability_status as StockState | null | undefined;
  if (norm && VALID_STOCK_STATES.has(norm) && norm !== "unknown") return norm;
  const fromRaw = normalizeStockFromRaw(item.source_availability);
  if (fromRaw !== "unknown") return fromRaw;
  return (norm && VALID_STOCK_STATES.has(norm)) ? norm : "unknown";
};
const stockBadgeProps = (state: StockState): { label: string; className: string; title: string } => {
  switch (state) {
    case "in_stock":
      return { label: "In stock", className: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400 bg-emerald-500/5", title: "Supplier page shows this item as in stock" };
    case "out_of_stock":
      return { label: "Out of stock", className: "border-rose-500/40 text-rose-700 dark:text-rose-400 bg-rose-500/5", title: "Supplier page shows this item as out of stock / sold out" };
    case "preorder":
      return { label: "Preorder", className: "border-amber-500/40 text-amber-700 dark:text-amber-400 bg-amber-500/5", title: "Supplier page shows this item as preorder" };
    case "backorder":
      return { label: "Backorder", className: "border-amber-500/40 text-amber-700 dark:text-amber-400 bg-amber-500/5", title: "Supplier page shows this item as backorder" };
    default:
      return { label: "Stock unknown", className: "border-muted-foreground/30 text-muted-foreground bg-muted/30", title: "We could not determine stock status from the supplier page" };
  }
};

const asFiniteNumber = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const normalizedConfidence = (value: unknown): number | null => {
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/%/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
};

const PAGE_SIZE = 60;
// Auto-verify policy: silently AI-verify every unverified candidate whose
// effective ROI clears this threshold. Backend cap per request is 20 items;
// we batch through them sequentially in the background. Users never have to
// click "Verify" — they only see the resulting "AI Verified" badge.
const AUTO_VERIFY_ROI_THRESHOLD = 30;
const AUTO_VERIFY_BATCH_SIZE = 20;
const AUTO_VERIFY_HARD_CAP = 200;

// Single source of truth for "ROI filter is off / show everything".
// minRoi <= 0 means: do not filter by ROI at all (the slider's "Off" button
// sets it to 0). This eliminates the prior dual-logic bug where the UI set -1
// but the filter only disabled at <= -100.
const isRoiFilterOff = (minRoi: number) => minRoi <= 0;

// Isolated slider row — keeps drag smooth, but still pushes filter updates
// during drag with a tiny debounce so the product grid visibly reacts.
const MinRoiSliderRow = memo(function MinRoiSliderRow({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState<number>(value);
  const commitTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  useEffect(() => {
    return () => {
      if (commitTimerRef.current != null) {
        window.clearTimeout(commitTimerRef.current);
      }
    };
  }, []);

  const scheduleCommit = (next: number) => {
    if (commitTimerRef.current != null) {
      window.clearTimeout(commitTimerRef.current);
    }
    commitTimerRef.current = window.setTimeout(() => {
      onCommit(next);
      commitTimerRef.current = null;
    }, 80);
  };

  const flushCommit = (next: number) => {
    if (commitTimerRef.current != null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    onCommit(next);
  };

  return (
    <div className="mb-4 p-3 rounded-md border border-border bg-muted/30">
      <Label className="text-xs font-semibold">
        Min ROI: {local <= 0 ? "Off (all)" : `${local}%`}
      </Label>
      <div className="mt-2 flex items-center gap-3">
        <Slider
          value={[local <= 0 ? 0 : local]}
          min={0}
          max={200}
          step={1}
          onValueChange={(v) => {
            const next = Math.max(0, v[0] ?? 0);
            setLocal(next);
            scheduleCommit(next);
          }}
          onValueCommit={(v) => flushCommit(Math.max(0, v[0] ?? 0))}
          className="flex-1"
        />
        {local > 0 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-9 px-2 text-[10px] shrink-0"
            onClick={() => {
              setLocal(0);
              flushCommit(0);
            }}
            title="Show all (no ROI filter)"
          >
            Off
          </Button>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground mt-1">
        Drag all the way left for "Off" (show all). AI auto-verifies every match with ROI ≥ {AUTO_VERIFY_ROI_THRESHOLD}%.
      </p>
    </div>
  );
});

// Persisted scan snapshot — survives navigating away and back to this page
// without triggering a fresh fetch. Cleared only by an explicit refresh action.
const SNAPSHOT_KEY = "storeScan.snapshot.v1";
interface ScanSnapshot {
  supplierDomain: string;
  categoryId: string;
  search: string;
  minRoi: number;
  items: BrowseItem[];
  total: number;
  offset: number;
  liveRoiMap: Record<string, number | null>;
  livePriceMap: Record<string, number | null>;
  amazonPresenceMap: Record<string, AmazonPresence | null>;
  aiOverlay: Record<string, { verdict: AIVerdict; confidence: number; reason: string; evidence?: Record<string, unknown> }>;
  autoVerifyDone: boolean;
  showOthers: boolean;
  autoExpandedOthers: boolean;
  savedAt: number;
}
const loadSnapshot = (): Partial<ScanSnapshot> | null => {
  try {
    const raw = sessionStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<ScanSnapshot>;
  } catch { return null; }
};

const UserStoreScan = () => {
  const { isAdmin } = useSubscription();
  const snap = useMemo(() => loadSnapshot(), []);
  const [suppliers, setSuppliers] = useState<SupplierBucket[]>([]);
  const [categories, setCategories] = useState<ScanCategory[]>([]);
  const [supplierDomain, setSupplierDomain] = useState<string>(snap?.supplierDomain ?? "");
  const [categoryId, setCategoryId] = useState<string>(snap?.categoryId ?? "");
  const [search, setSearch] = useState(snap?.search ?? "");
  const [minRoi, setMinRoi] = useState<number>(snap?.minRoi ?? 30);
  const [items, setItems] = useState<BrowseItem[]>(snap?.items ?? []);
  const [total, setTotal] = useState(snap?.total ?? 0);
  const [offset, setOffset] = useState(snap?.offset ?? 0);
  const [loading, setLoading] = useState(false);
  const [loadingCats, setLoadingCats] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ pct: number; label: string }>({ pct: 0, label: "" });
  const [liveRoiMap, setLiveRoiMap] = useState<Record<string, number | null>>(snap?.liveRoiMap ?? {});
  const [livePriceMap, setLivePriceMap] = useState<Record<string, number | null>>(snap?.livePriceMap ?? {});
  const [amazonPresenceMap, setAmazonPresenceMap] = useState<Record<string, AmazonPresence | null>>(snap?.amazonPresenceMap ?? {});
  const [hideAmazonDominated, setHideAmazonDominated] = useState<boolean>(() => {
    try { return localStorage.getItem("storeScan.hideAmazonDominated") !== "false"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("storeScan.hideAmazonDominated", String(hideAmazonDominated)); } catch { /* noop */ }
  }, [hideAmazonDominated]);
  // In-stock filter (default ON): hide supplier listings that are clearly
  // out of stock. "Stock unknown" rows are kept visible because many
  // suppliers don't expose availability cleanly on category pages.
  const [inStockOnly, setInStockOnly] = useState<boolean>(() => {
    try { return localStorage.getItem("storeScan.inStockOnly") !== "false"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("storeScan.inStockOnly", String(inStockOnly)); } catch { /* noop */ }
  }, [inStockOnly]);
  // Matches-only mode (default ON): hide the Not Match section completely so
  // the default sourcing flow surfaces only actionable candidates. Users can
  // opt in to see rejected items via the toggle below.
  const [matchesOnly, setMatchesOnly] = useState<boolean>(() => {
    try { return localStorage.getItem("storeScan.matchesOnly") !== "false"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("storeScan.matchesOnly", String(matchesOnly)); } catch { /* noop */ }
  }, [matchesOnly]);
  // Per-item AI verdict overlay (updated after on-demand verify or auto-verify)
  const [aiOverlay, setAiOverlay] = useState<Record<string, {
    verdict: AIVerdict; confidence: number; reason: string;
    evidence?: Record<string, unknown>;
  }>>(snap?.aiOverlay ?? {});
  const [verifyingIds, setVerifyingIds] = useState<Set<string>>(new Set());
  const [autoVerifyDone, setAutoVerifyDone] = useState(snap?.autoVerifyDone ?? false);
  // Per-item guard: tracks IDs we've already auto-attempted so streaming live ROI
  // updates don't re-fire verification for the same row, but newly-eligible rows
  // (whose live ROI arrives later) still get picked up.
  const autoAttemptedRef = useRef<Set<string>>(new Set());
  const [showOthers, setShowOthers] = useState(snap?.showOthers ?? false);
  const [autoExpandedOthers, setAutoExpandedOthers] = useState(snap?.autoExpandedOthers ?? false);
  // Eligibility state — per-ASIN approval status (mirrors Product Finder behavior)
  const [eligibilityMap, setEligibilityMap] = useState<Record<string, EligibilityStatus>>({});
  const [eligibilityProgress, setEligibilityProgress] = useState<{ checked: number; total: number } | null>(null);
  const eligibilityAbortRef = useRef<AbortController | null>(null);
  const eligibilityScannedRef = useRef<Set<string>>(new Set());
  const staleSnapshotRefreshRef = useRef<string | null>(null);
  // Tracks whether items have already been loaded for the current category
  // (true if we restored a non-empty snapshot). Used to skip the auto-fetch.
  const [hasFetchedOnce, setHasFetchedOnce] = useState<boolean>(() => (snap?.items?.length ?? 0) > 0);
  // Admin-only: bypass all filters/AI gating and dump every raw row returned for the
  // selected supplier + category. Useful for QA/debugging the raw scan output.
  const [adminRawMode, setAdminRawMode] = useState(false);
  // Minimum match confidence (0–100). Filters visibility only — never overrides verdict.
  // Unverified rows (no confidence yet) are always shown so users can verify them.
  const [minConfidence, setMinConfidence] = useState<number>(() => {
    try {
      const raw = localStorage.getItem("storeScan.minConfidence");
      const n = raw == null ? 70 : Number(raw);
      return Number.isFinite(n) ? Math.min(100, Math.max(70, n)) : 70;
    } catch { return 70; }
  });
  useEffect(() => {
    try { localStorage.setItem("storeScan.minConfidence", String(minConfidence)); } catch { /* noop */ }
  }, [minConfidence]);

  // Persist a snapshot of the current scan state to sessionStorage on every
  // meaningful change. Lets the user navigate away and come back without
  // losing items, AI verdicts, or live ROI (no auto-refresh on remount).
  useEffect(() => {
    try {
      const payload: ScanSnapshot = {
        supplierDomain, categoryId, search, minRoi,
        items, total, offset,
        liveRoiMap, livePriceMap, amazonPresenceMap, aiOverlay,
        autoVerifyDone, showOthers, autoExpandedOthers,
        savedAt: Date.now(),
      };
      sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(payload));
    } catch { /* quota or serialization issues — ignore */ }
  }, [supplierDomain, categoryId, search, minRoi, items, total, offset,
      liveRoiMap, livePriceMap, amazonPresenceMap, aiOverlay,
      autoVerifyDone, showOthers, autoExpandedOthers]);

  const loadCategories = useCallback(async (preserveSelection = false) => {
    setLoadingCats(true);
    const { data, error } = await supabase.functions.invoke("user-browse-admin-data", {
      body: { mode: "scan_categories" },
    });
    setLoadingCats(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    const cats: ScanCategory[] = data?.categories ?? [];
    const sups: SupplierBucket[] = data?.suppliers ?? [];
    setCategories(cats);
    setSuppliers(sups);
    if (!preserveSelection && sups.length > 0) setSupplierDomain(sups[0].domain);
  }, []);

  // Preserve the snapshot's supplier selection on first load so navigating away
  // and back doesn't reset the dropdown to the first supplier.
  useEffect(() => { loadCategories(!!snap?.supplierDomain); }, [loadCategories, snap?.supplierDomain]);

  const visibleCategories = useMemo(
    () => categories.filter((c) => c.supplier_domain === supplierDomain),
    [categories, supplierDomain],
  );

  // When supplier changes, reset category to first one — but only if the
  // current categoryId isn't valid under the new supplier. This preserves the
  // restored snapshot's category on initial load.
  useEffect(() => {
    if (visibleCategories.length === 0) return;
    if (categoryId && visibleCategories.some((c) => c.id === categoryId)) return;
    setCategoryId(visibleCategories[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierDomain, visibleCategories]);

  const RAW_PAGE_SIZE = 5000;
  const SHOW_EVERYTHING_PAGE_SIZE = 5000;
  const fetchItems = useCallback(async (resetOffset = true, append = false) => {
    if (!categoryId) {
      setItems([]); setTotal(0); setLiveRoiMap({}); setAiOverlay({}); setAutoVerifyDone(false);
      return;
    }
    setLoading(true);
    const isRaw = adminRawMode && isAdmin;
    // When the user has both filters fully open ("show everything") we fetch a
    // very large window so the visible count actually matches the total scanned.
    const wantsAll = isRoiFilterOff(minRoi) && (minConfidence <= 0);
    const effectiveLimit = isRaw
      ? RAW_PAGE_SIZE
      : wantsAll
        ? SHOW_EVERYTHING_PAGE_SIZE
        : PAGE_SIZE;
    const newOffset = resetOffset ? 0 : (append ? items.length : offset);
    const { data, error } = await supabase.functions.invoke("user-browse-admin-data", {
      body: {
        mode: "store_scan",
        category_id: categoryId,
        search: search || undefined,
        limit: effectiveLimit,
        offset: newOffset,
      },
    });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    const incoming = data?.items ?? [];
    setItems(append ? [...items, ...incoming] : incoming);
    setTotal(data?.total ?? 0);
    if (!append) {
      setLiveRoiMap({});
      setLivePriceMap({});
      setAmazonPresenceMap({});
      setAiOverlay({});
      setAutoVerifyDone(false);
      autoAttemptedRef.current = new Set();
      selfHealAttemptedRef.current = new Map();
      setShowOthers(false);
      // Reset eligibility scan when items refresh
      if (eligibilityAbortRef.current) eligibilityAbortRef.current.abort();
      eligibilityScannedRef.current = new Set();
      setEligibilityMap({});
      setEligibilityProgress(null);
    }
    setHasFetchedOnce(true);
    if (resetOffset) setOffset(0);
  }, [categoryId, search, offset, adminRawMode, isAdmin, items, minRoi, minConfidence]);

  useEffect(() => {
    if (!categoryId || !snap?.savedAt) return;
    const selected = categories.find((c) => c.id === categoryId);
    const freshness = selected?.last_successful_scan_at ?? selected?.last_scanned_at;
    if (!freshness) return;

    const freshnessTs = Date.parse(freshness);
    if (!Number.isFinite(freshnessTs) || freshnessTs <= snap.savedAt) return;

    const refreshKey = `${categoryId}:${freshness}`;
    if (staleSnapshotRefreshRef.current === refreshKey) return;
    staleSnapshotRefreshRef.current = refreshKey;

    try { sessionStorage.removeItem(SNAPSHOT_KEY); } catch { /* noop */ }
    setHasFetchedOnce(false);
    void fetchItems(true);
  }, [categories, categoryId, fetchItems, snap?.savedAt]);

  // Auto-fetch when category changes. The snapshot-skip only applies on the
  // very first render (so navigating back doesn't re-fetch); any subsequent
  // categoryId change — e.g. switching suppliers — must always trigger a fresh
  // fetch, otherwise the UI stays stuck on the previous supplier's items.
  const initialCategoryRef = useRef<string | null>(snap?.categoryId ?? null);
  useEffect(() => {
    if (!categoryId) return;
    if (
      initialCategoryRef.current &&
      categoryId === initialCategoryRef.current &&
      hasFetchedOnce &&
      items.length > 0
    ) {
      // First render with restored snapshot — keep the cached items.
      initialCategoryRef.current = null;
      return;
    }
    initialCategoryRef.current = null;
    fetchItems(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId]);

  // Re-fetch with the wider window when admin toggles raw mode so they see
  // every record across all linked runs (not just the first 60).
  useEffect(() => {
    if (!isAdmin || !categoryId) return;
    fetchItems(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminRawMode]);

  // Re-fetch with a much larger window when the user opens both filters fully
  // ("show everything" mode) so the visible count matches the scanned total.
  useEffect(() => {
    if (!categoryId) return;
    const wantsAll = isRoiFilterOff(minRoi) && (minConfidence <= 0);
    if (!wantsAll) return;
    fetchItems(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minRoi, minConfidence, categoryId]);

  const onApply = () => fetchItems(true);

  const [fxMap, setFxMap] = useState<Record<string, number>>({ USD: 1 });
  useEffect(() => {
    const currencies = Array.from(new Set(
      items.map((i) => (i.source_currency ?? "USD").toUpperCase()).filter((c) => c && c !== "USD")
    ));
    const missing = currencies.filter((c) => !(c in fxMap));
    if (missing.length === 0) return;
    (async () => {
      const { data } = await supabase
        .from("fx_rates")
        .select("quote, rate")
        .eq("base", "USD")
        .in("quote", missing);
      const next = { ...fxMap };
      for (const r of data ?? []) {
        const rate = Number(r.rate);
        if (rate > 0) next[r.quote as string] = rate;
      }
      setFxMap(next);
    })();
  }, [items, fxMap]);

  const handleLiveRoi = useCallback((id: string, roi: number | null) => {
    setLiveRoiMap((prev) => (prev[id] === roi ? prev : { ...prev, [id]: roi }));
  }, []);

  const handleLivePrice = useCallback((id: string, price: number | null) => {
    setLivePriceMap((prev) => (prev[id] === price ? prev : { ...prev, [id]: price }));
  }, []);

  const handleAmazonPresence = useCallback((id: string, presence: AmazonPresence | null) => {
    setAmazonPresenceMap((prev) => {
      const cur = prev[id];
      if (cur === presence) return prev;
      if (cur && presence && cur.isAmazonDominant === presence.isAmazonDominant
          && cur.isAmazonBuyBoxWinner === presence.isAmazonBuyBoxWinner
          && cur.amazonOfferCount === presence.amazonOfferCount
          && cur.totalOfferCount === presence.totalOfferCount) return prev;
      return { ...prev, [id]: presence };
    });
  }, []);

  // SELF-HEAL (Fix #3): when an item has a matched_asin but no usable Amazon
  // price (cached price is null/0 and no live price has been fetched yet),
  // trigger a one-shot live ROI/price fetch. This recovers GameStop-style
  // matches where the catalog returned an ASIN but no price, instead of
  // leaving the row stuck at "—" / hidden by the price gate forever.
  // Each row tracks a small self-heal state machine so transient SP-API misses
  // can retry automatically instead of getting stuck at Amazon— forever.
  const selfHealAttemptedRef = useRef<Map<string, "pending" | "failed" | "succeeded">>(new Map());
  useEffect(() => {
    const candidates = items.filter((it) => {
      if (!it.matched_asin) return false;
      const asin = it.matched_asin.trim().toUpperCase();
      if (asin.length !== 10) return false;

      const cachedPrice = asFiniteNumber(it.amz_price);
      const livePrice = livePriceMap[it.id];
      if ((cachedPrice != null && cachedPrice > 0) || (livePrice != null && livePrice > 0)) return false;

      const cost = asFiniteNumber(it.source_price);
      if (cost == null || cost <= 0) return false;

      const state = selfHealAttemptedRef.current.get(it.id);
      if (!state) return true;
      if (state === "pending") return false;
      return state === "failed";
    }).slice(0, 8); // small batch — roiQueue throttles SP-API calls

    if (candidates.length === 0) return;

    for (const it of candidates) {
      selfHealAttemptedRef.current.set(it.id, "pending");
      const asin = it.matched_asin!.trim().toUpperCase();
      const cost = asFiniteNumber(it.source_price)!;
      void (async () => {
        try {
          const data = await enqueueRoi(asin, cost, "US");
          const price = data?.price != null ? Number(data.price) : null;
          const roi = data?.calculation?.roi != null ? Number(data.calculation.roi) : null;
          if (price != null && Number.isFinite(price) && price > 0) {
            selfHealAttemptedRef.current.set(it.id, "succeeded");
            handleLivePrice(it.id, price);
            if (roi != null && Number.isFinite(roi)) handleLiveRoi(it.id, roi);
            handleAmazonPresence(it.id, (data?.amazonPresence ?? null) as AmazonPresence | null);
          } else {
            selfHealAttemptedRef.current.set(it.id, "failed");
            handleLivePrice(it.id, null);
          }
        } catch (e) {
          selfHealAttemptedRef.current.set(it.id, "failed");
          console.warn("[UserStoreScan self-heal] enqueueRoi failed", { asin, error: e });
        }
      })();
    }
  }, [items, livePriceMap, handleLivePrice, handleLiveRoi, handleAmazonPresence]);


  // Effective verdict per item (overlay wins over server-attached).
  //
  // STALE-VERDICT GUARD: a row must NEVER be classified as "not_match" if the
  // pipeline has since produced strong identity-match signals (locked ASIN,
  // server-side high/needs_price confidence, live Amazon price, or live ROI).
  // Earlier verifier passes could legitimately reject a candidate that later
  // got resurrected by a stronger match round; without this guard the stale
  // "not_match" verdict would override all that newer evidence and the row
  // would be shown to the user as "Not Match · Confidence 95%" while clearly
  // being a real, priced, ROI-positive opportunity. We downgrade to
  // "likely_match" so it lands in Review (not Not Match) and the user can act.
  const verdictOf = useCallback((it: BrowseItem): AIVerdict | null => {
    const o = aiOverlay[it.id];
    const raw = o ? o.verdict : (it.ai_verdict ?? null);
    if (raw !== "not_match") return raw;

    const conf = (it.match_confidence ?? "").toLowerCase();
    const livePrice = livePriceMap[it.id];
    const liveRoi = liveRoiMap[it.id];
    const hasLivePrice = typeof livePrice === "number" && Number.isFinite(livePrice) && livePrice > 0;
    const hasLiveRoi = typeof liveRoi === "number" && Number.isFinite(liveRoi);
    const hasStrongIdentity = !!it.matched_asin && (conf === "high" || conf === "needs_price");

    if (hasStrongIdentity || hasLivePrice || hasLiveRoi) {
      return "likely_match";
    }
    return raw;
  }, [aiOverlay, livePriceMap, liveRoiMap]);

  const reasonOf = useCallback((it: BrowseItem): string => {
    return aiOverlay[it.id]?.reason ?? it.ai_reason ?? "";
  }, [aiOverlay]);

  // Returns the *displayed* confidence — must mirror MatchConfidenceBadge so
  // the slider filter agrees with the badge the user sees. Engine-verified
  // exact matches are boosted to 95–99 because the verdict was proven by a
  // hard identifier; otherwise we use the live overlay → raw ai_confidence →
  // capped value as a last resort.
  const confidenceOf = useCallback((it: BrowseItem): number | null => {
    const overlayConfidence = normalizedConfidence(aiOverlay[it.id]?.confidence);
    const evidence = (aiOverlay[it.id]?.evidence ?? it.ai_evidence) as Record<string, unknown> | undefined;
    const raw = normalizedConfidence(it.ai_confidence);
    const capped = normalizedConfidence(evidence?._confidence_cap_applied);
    const base = overlayConfidence ?? raw ?? capped;

    const verdict = aiOverlay[it.id]?.verdict ?? it.ai_verdict ?? null;
    if (verdict === "exact_match" && evidence) {
      const identifierConfirmed = !!evidence._identifier_confirmed;
      const modelMpnConfirmed = !!evidence._model_mpn_confirmed;
      const aiFallbackInvoked = !!evidence._ai_fallback_invoked;
      const decisionPath = String(evidence._engine_decision_path ?? "");
      const engineDecided =
        decisionPath === "identifier_match" ||
        decisionPath === "mpn_dominance" ||
        decisionPath === "hard_conflict" ||
        decisionPath === "score_floor" ||
        (identifierConfirmed && !aiFallbackInvoked);
      const engineSource = !aiFallbackInvoked && engineDecided;
      if (engineSource) {
        if (identifierConfirmed) return 99;
        if (modelMpnConfirmed) return 97;
        if (base != null) return Math.max(base, 95);
        return 95;
      }
    }
    return base;
  }, [aiOverlay]);

  // Returns the AI evidence object (overlay first, else server-attached)
  const evidenceOf = useCallback((it: BrowseItem): Record<string, unknown> | null => {
    const o = aiOverlay[it.id];
    if (o?.evidence) return o.evidence;
    return (it.ai_evidence as Record<string, unknown> | undefined) ?? null;
  }, [aiOverlay]);

  // Pack-conversion adjustment: if AI says same_base_product_different_pack,
  // multiply unit cost by amazon_pack_count / supplier_pack_count so the
  // ROI cell sees the real cost to procure 1 Amazon-pack worth of units.
  const packMultiplierOf = useCallback((it: BrowseItem): number => {
    const ev = evidenceOf(it);
    if (!ev) return 1;
    const verdict = verdictOf(it);
    if (verdict !== "same_base_product_different_pack" && verdict !== "exact_match") return 1;
    const amzN = Number((ev as { amazon_pack_count?: unknown }).amazon_pack_count);
    const supN = Number((ev as { supplier_pack_count?: unknown }).supplier_pack_count);
    if (!Number.isFinite(amzN) || !Number.isFinite(supN) || amzN <= 0 || supN <= 0) return 1;
    if (amzN === supN) return 1;
    // Only apply for the pack-conversion verdict (don't silently rescale exact_match)
    if (verdict === "same_base_product_different_pack") return amzN / supN;
    return 1;
  }, [evidenceOf, verdictOf]);

  // "Show everything" mode — when both sliders are fully open the user expects
  // to see EVERY listing, regardless of strict-match / Amazon-dominated / stock filters.
  const showEverything = isRoiFilterOff(minRoi) && (minConfidence <= 0);

  // Filter out rows hidden by non-ROI controls first, then apply ROI separately.
  // This lets the UI tell the user whether the slider is the reason nothing is shown.
  //
  // GLOBAL PIPELINE INTEGRITY (Fix #2): the Amazon-price guard lives HERE — at
  // the root dataset — so every downstream section (Verified / Unverified /
  // Review / Rejected) honors the same truth: a match without a usable price is
  // not a tradable item and must not leak through. The only escape hatch is the
  // explicit "show everything" mode (both sliders fully open).
  const matchedItemsBeforeRoi = useMemo(() => {
    const filtered = items.filter((it) => {
      if (!it.matched_asin) return false;
      // In "show everything" mode bypass strict status / confidence / dominance / stock gates
      if (!showEverything) {
        if ((it.status ?? "matched") !== "matched") return false;
        const conf = (it.match_confidence ?? "").toLowerCase();
        // Allow "high" (verified identity match) AND "needs_price" (server-downgraded
        // because Amazon price wasn't available at scan time). Rows with any other
        // confidence are weak identity matches and stay filtered out.
        if (conf !== "high" && conf !== "needs_price") return false;
        if (hideAmazonDominated) {
          const ap = amazonPresenceMap[it.id];
          if (ap?.isAmazonDominant) return false;
        }
        if (inStockOnly && getStockState(it) === "out_of_stock") {
          return false;
        }
      }
      return true;
    });

    // In "show everything" mode, skip the per-ASIN dedup so the user sees every
    // raw scan row (multiple supplier products can map to the same Amazon ASIN).
    if (showEverything) return filtered;

    const seen = new Set<string>();
    return filtered.filter((it) => {
      const key = (it.matched_asin ?? "").trim().toUpperCase();
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [items, amazonPresenceMap, hideAmazonDominated, inStockOnly, showEverything]);

  // Helper: does this matched row currently have a usable Amazon price?
  // Identity match (ASIN found) ≠ trade readiness (price available). Used to
  // route price-less matches into dedicated sections instead of dropping them.
  const hasUsablePrice = useCallback((it: BrowseItem): boolean => {
    const p = livePriceMap[it.id] ?? asFiniteNumber(it.amz_price);
    return p != null && p > 0;
  }, [livePriceMap]);

  const priceStateOf = useCallback((it: BrowseItem): "pending" | "unavailable" | "resolved" => {
    if (hasUsablePrice(it)) return "resolved";
    const state = selfHealAttemptedRef.current.get(it.id);
    return state === "failed" ? "unavailable" : "pending";
  }, [hasUsablePrice]);

  const needsPriceItems = useMemo(() => {
    return matchedItemsBeforeRoi.filter((it) => priceStateOf(it) === "pending");
  }, [matchedItemsBeforeRoi, priceStateOf]);

  const unavailablePriceItems = useMemo(() => {
    return matchedItemsBeforeRoi.filter((it) => priceStateOf(it) === "unavailable");
  }, [matchedItemsBeforeRoi, priceStateOf]);

  const noMatchItems = useMemo(() => {
    return items.filter((it) => {
      if (it.matched_asin) return false;
      // STRICT: only show rows that were *actually verified* as having no
      // valid Amazon match. Rows still in "queued"/"extracted"/"error" are
      // not "Missing opportunity" — they're "not processed yet" or "blocked"
      // and must not be labeled as missed.
      const status = (it.status ?? "").toLowerCase();
      if (status !== "unmatched") return false;
      const method = (it.match_method ?? "").toLowerCase();
      // Only count rows where the matcher actually ran and rejected all candidates.
      return method === "no_valid_match" || method === "no_verified_match";
    });
  }, [items]);

  // ROI logic: prefer live ROI (freshly fetched from SP-API), fall back to the
  // saved scan ROI from the DB. Only applied to rows that have a usable price —
  // matched-without-price rows are surfaced separately (needsPriceItems).
  const matchedItems = useMemo(() => {
    const priced = matchedItemsBeforeRoi.filter(hasUsablePrice);
    return priced.filter((it) => {
      if (isRoiFilterOff(minRoi)) return true;
      const live = asFiniteNumber(liveRoiMap[it.id]);
      const savedRoi = asFiniteNumber(it.roi);
      const effectiveRoi = live ?? savedRoi;
      if (effectiveRoi == null) return false;
      return effectiveRoi >= minRoi;
    });
  }, [matchedItemsBeforeRoi, liveRoiMap, minRoi, hasUsablePrice]);

  const visibleMatchedItems = useMemo(() => {
    let hiddenByConfidence = 0;
    const visible = matchedItems.filter((it) => {
      const verdict = verdictOf(it);
      if (verdict == null) return true;
      const confidence = confidenceOf(it);
      if (confidence == null) return true;
      const keep = confidence >= minConfidence;
      if (!keep) hiddenByConfidence += 1;
      return keep;
    });

    return { visible, hiddenByConfidence };
  }, [matchedItems, verdictOf, confidenceOf, minConfidence]);

  // Section split based on AI verdict.
  // The Minimum Match Confidence slider filters *visibility* inside each section
  // (it never overrides the verdict). Unverified rows have no confidence yet
  // and are always kept so the user can verify or auto-verify them.
  const sections = useMemo(() => {
    const verified: BrowseItem[] = [];
    const packConv: BrowseItem[] = [];
    const unverified: BrowseItem[] = [];
    const review: BrowseItem[] = [];
    const rejected: BrowseItem[] = [];
    for (const it of visibleMatchedItems.visible) {
      const v = verdictOf(it);
      if (v == null) {
        unverified.push(it);
        continue;
      }
      if (v === "exact_match") verified.push(it);
      else if (v === "same_base_product_different_pack") packConv.push(it);
      else if (v === "likely_match") review.push(it);
      else if (v === "not_match") rejected.push(it);
    }
    return { verified, packConv, unverified, review, rejected, hiddenByConfidence: visibleMatchedItems.hiddenByConfidence };
  }, [visibleMatchedItems, verdictOf]);

  // ---------- Eligibility check (Amazon SP-API restrictions) ----------
  // Mirrors KeepaProductFinder behavior: progressively scans matched ASINs in
  // small batches and labels each card as Approved / Restricted / Needs Approval.
  const checkEligibilityProgressive = useCallback(async (asins: string[]) => {
    if (asins.length === 0) return;

    if (eligibilityAbortRef.current) eligibilityAbortRef.current.abort();
    const controller = new AbortController();
    eligibilityAbortRef.current = controller;

    setEligibilityMap((prev) => {
      const next = { ...prev };
      for (const a of asins) if (!next[a]) next[a] = 'pending';
      return next;
    });

    const total = asins.length;
    setEligibilityProgress({ checked: 0, total });
    let checked = 0;

    for (let i = 0; i < asins.length; i += ELIGIBILITY_BATCH_SIZE) {
      if (controller.signal.aborted) return;
      const batch = asins.slice(i, i + ELIGIBILITY_BATCH_SIZE);

      setEligibilityMap((prev) => {
        const next = { ...prev };
        for (const a of batch) next[a] = 'checking';
        return next;
      });

      try {
        const { data, error } = await supabase.functions.invoke('check-product-eligibility', {
          body: { marketplace: 'US', asins: batch, force_rescan: false },
        });
        if (controller.signal.aborted) return;

        if (error) {
          setEligibilityMap((prev) => {
            const next = { ...prev };
            for (const a of batch) next[a] = 'error';
            return next;
          });
        } else {
          const results: { asin: string; status: string }[] = data?.results ?? [];
          setEligibilityMap((prev) => {
            const next = { ...prev };
            for (const r of results) {
              next[r.asin] = r.status === 'approved' ? 'approved'
                : r.status === 'approval_required' ? 'approval_required'
                : 'restricted';
            }
            for (const a of batch) {
              if (!next[a] || next[a] === 'checking') next[a] = 'error';
            }
            return next;
          });
        }
      } catch {
        if (controller.signal.aborted) return;
        setEligibilityMap((prev) => {
          const next = { ...prev };
          for (const a of batch) next[a] = 'error';
          return next;
        });
      }

      checked += batch.length;
      setEligibilityProgress({ checked: Math.min(checked, total), total });
    }

    setEligibilityProgress(null);
  }, []);

  // Auto-trigger eligibility scan once we have matched ASINs visible.
  // Tracks queued ASINs in a ref so re-renders don't restart the scan.
  useEffect(() => {
    const asins = Array.from(new Set(
      matchedItemsBeforeRoi
        .map((it) => (it.matched_asin ?? '').trim().toUpperCase())
        .filter((a) => a.length === 10)
    ));
    const fresh = asins.filter((a) => !eligibilityScannedRef.current.has(a));
    if (fresh.length === 0) return;
    for (const a of fresh) eligibilityScannedRef.current.add(a);
    checkEligibilityProgressive(fresh);
  }, [matchedItemsBeforeRoi, checkEligibilityProgressive]);

  // Per-ASIN status badge (rendered on each matched card)
  const renderEligibilityBadge = (asin: string | null | undefined) => {
    if (!asin) return null;
    const status = eligibilityMap[asin.trim().toUpperCase()];
    if (!status) return null;
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="text-[10px] px-1.5 text-muted-foreground">Queued</Badge>;
      case 'checking':
        return (
          <Badge variant="outline" className="text-[10px] px-1.5 animate-pulse">
            <Loader2 className="h-3 w-3 mr-0.5 animate-spin" /> Checking
          </Badge>
        );
      case 'approved':
        return (
          <Badge variant="default" className="text-[10px] px-1.5 bg-emerald-600 hover:bg-emerald-700">
            <ShieldCheck className="h-3 w-3 mr-0.5" /> Approved
          </Badge>
        );
      case 'restricted':
        return (
          <Badge variant="destructive" className="text-[10px] px-1.5">
            <ShieldX className="h-3 w-3 mr-0.5" /> Restricted
          </Badge>
        );
      case 'approval_required':
        return (
          <Badge variant="secondary" className="text-[10px] px-1.5 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
            <ShieldAlert className="h-3 w-3 mr-0.5" /> Needs Approval
          </Badge>
        );
      case 'error':
        return <Badge variant="secondary" className="text-[10px] px-1.5 text-muted-foreground">Eligibility ?</Badge>;
      default:
        return null;
    }
  };

  // Verify a batch of items via edge function
  const runVerify = useCallback(async (toVerify: BrowseItem[], opts: { force?: boolean; silent?: boolean } = {}) => {
    if (toVerify.length === 0) return;
    const ids = new Set(toVerify.map((it) => it.id));
    setVerifyingIds((prev) => new Set([...prev, ...ids]));
    try {
      const payload = toVerify.map((it) => ({
        source_url: it.source_url,
        asin: it.matched_asin!,
        source_title: it.source_title,
        source_image_url: it.source_image_url,
        source_price: it.source_price,
        source_currency: it.source_currency,
        amz_title: it.amz_title,
        amz_image_url: it.amz_image_url,
        amz_price: livePriceMap[it.id] ?? it.amz_price,
      }));
      const { data, error } = await supabase.functions.invoke("verify-store-scan-match", {
        body: { items: payload, force: !!opts.force },
      });
      if (error) {
        if (!opts.silent) toast.error(`Verify failed: ${error.message}`);
        return;
      }
      const verifications = (data?.verifications ?? data?.partial ?? {}) as Record<string, {
        verdict: AIVerdict; confidence: number; reason: string;
        evidence?: Record<string, unknown>;
      }>;
      const next: typeof aiOverlay = {};
      for (const it of toVerify) {
        const key = `${it.source_url}::${it.matched_asin}`;
        const v = verifications[key];
        if (v) next[it.id] = {
          verdict: v.verdict,
          confidence: v.confidence,
          reason: v.reason,
          evidence: v.evidence,
        };
      }
      setAiOverlay((prev) => ({ ...prev, ...next }));
      if (data?.code === "rate_limited" && !opts.silent) {
        toast.error("AI rate limit reached — please wait and try again.");
      } else if (data?.code === "payment_required" && !opts.silent) {
        toast.error("AI credits exhausted — add credits in workspace settings.");
      } else if (!opts.silent) {
        const okCount = Object.keys(next).length;
        if (okCount > 0) toast.success(`Verified ${okCount} item${okCount === 1 ? "" : "s"}.`);
      }
    } catch (e) {
      if (!opts.silent) toast.error(e instanceof Error ? e.message : "Verify failed");
    } finally {
      setVerifyingIds((prev) => {
        const n = new Set(prev);
        for (const id of ids) n.delete(id);
        return n;
      });
    }
  }, [livePriceMap]);

  // Auto-verify policy:
  //   • Silently verify every unverified candidate whose effective ROI clears
  //     AUTO_VERIFY_ROI_THRESHOLD (live ROI preferred, saved ROI fallback).
  //   • Independent of the user's "Min ROI" filter slider — that slider only
  //     controls visibility, not whether AI verification runs.
  //   • Batched (20 per request) and capped per render to avoid blowing through
  //     credits on huge scans. Users never trigger this manually; they only
  //     see the resulting "AI Verified" badge.
  useEffect(() => {
    if (matchedItems.length === 0) return;

    const effectiveRoiOf = (it: typeof matchedItems[number]): number | null => {
      const live = asFiniteNumber(liveRoiMap[it.id]);
      const saved = asFiniteNumber(it.roi);
      return live ?? saved;
    };

    // Per-item gating: only consider rows we haven't already auto-attempted.
    // This lets newly-eligible rows (live ROI arriving late) get verified
    // instead of being permanently locked out by a single global flag.
    const candidates = matchedItems
      .filter((it) => verdictOf(it) === null)
      .filter((it) => !autoAttemptedRef.current.has(it.id))
      .filter((it) => !verifyingIds.has(it.id))
      .filter((it) => {
        const r = effectiveRoiOf(it);
        return r != null && r >= AUTO_VERIFY_ROI_THRESHOLD;
      })
      .sort((a, b) => (effectiveRoiOf(b) ?? 0) - (effectiveRoiOf(a) ?? 0))
      .slice(0, AUTO_VERIFY_HARD_CAP);

    if (candidates.length === 0) {
      // Mark legacy flag once ≥80% rows have settled live ROI (back-compat for
      // snapshot persistence); per-item ref is the real authority going forward.
      if (!autoVerifyDone) {
        const settled = matchedItems.filter((it) => liveRoiMap[it.id] != null);
        if (settled.length >= Math.max(1, Math.floor(matchedItems.length * 0.8))) {
          setAutoVerifyDone(true);
        }
      }
      return;
    }

    // Reserve these IDs immediately so the next render doesn't re-queue them.
    for (const it of candidates) autoAttemptedRef.current.add(it.id);

    // Fire batches sequentially so each respects the backend's 20-item cap.
    (async () => {
      for (let i = 0; i < candidates.length; i += AUTO_VERIFY_BATCH_SIZE) {
        const batch = candidates.slice(i, i + AUTO_VERIFY_BATCH_SIZE);
        await runVerify(batch, { silent: true });
      }
    })();
  }, [matchedItems, liveRoiMap, autoVerifyDone, verdictOf, runVerify, verifyingIds]);

  // Once the verifier has finished labeling rows, auto-expand the
  // "Review needed / Rejected" section so users can still see (and override)
  // the AI's softer decisions instead of feeling like rows disappeared.
  // Skipped entirely in matchesOnly mode — that mode hides Not Match by design.
  useEffect(() => {
    if (matchesOnly) return;
    if (!autoExpandedOthers && autoVerifyDone) {
      const reviewOrReject = matchedItems.filter((it) => {
        const v = verdictOf(it);
        return v === "likely_match" || v === "not_match";
      }).length;
      if (reviewOrReject > 0) {
        setShowOthers(true);
        setAutoExpandedOthers(true);
      }
    }
  }, [matchedItems, verdictOf, autoVerifyDone, autoExpandedOthers, matchesOnly]);

  // Safety net: if every visible result is in Review/Rejected (main sections empty),
  // force-expand the "Others" disclosure so rows are never trapped behind a toggle.
  // This handles cases where the user lowers the confidence slider or all verifier
  // results land outside Exact/Likely.
  const mainVisibleCount =
    sections.verified.length + sections.packConv.length + sections.unverified.length;
  const forceShowRejected = matchesOnly
    && mainVisibleCount === 0
    && sections.review.length === 0
    && sections.rejected.length > 0;
  const visibleRejectedCount = forceShowRejected ? sections.rejected.length : (matchesOnly ? 0 : sections.rejected.length);
  const otherVisibleCount = sections.review.length + visibleRejectedCount;
  // Summary counts for the progress card — scoped to the cards that are actually
  // visible in the current UI state (respecting ROI/confidence filters and the
  // collapsed review/rejected section) so the totals match what the user sees.
  const eligibilitySummary = useMemo(() => {
    const visibleCards = [
      ...sections.verified,
      ...sections.packConv,
      ...sections.unverified,
      ...(showOthers ? sections.review : []),
      ...(showOthers ? sections.rejected.slice(0, visibleRejectedCount) : []),
    ];

    const visibleAsins = new Set(
      visibleCards
        .map((it) => (it.matched_asin ?? '').trim().toUpperCase())
        .filter((a) => a.length === 10)
    );
    const values: string[] = [];
    for (const asin of visibleAsins) {
      const v = eligibilityMap[asin];
      if (v) values.push(v);
    }
    return {
      approved: values.filter((v) => v === 'approved').length,
      restricted: values.filter((v) => v === 'restricted').length,
      approvalRequired: values.filter((v) => v === 'approval_required').length,
      checking: values.filter((v) => v === 'checking' || v === 'pending').length,
      errors: values.filter((v) => v === 'error').length,
      total: values.length,
    };
  }, [eligibilityMap, sections, showOthers, visibleRejectedCount]);
  useEffect(() => {
    if (!showOthers && mainVisibleCount === 0 && otherVisibleCount > 0) {
      setShowOthers(true);
    }
  }, [showOthers, mainVisibleCount, otherVisibleCount]);


  const formatPrice = (price: number | null, currency: string | null) =>
    price == null ? "—" : `${currency ?? "USD"} ${price.toFixed(2)}`;

  const selectedCategory = categories.find((c) => c.id === categoryId);

  const triggerScan = useCallback(async () => {
    if (!categoryId) return;
    const cat = selectedCategory;
    if (!cat || !cat.supplier_domain || !(cat.urls?.length)) {
      toast.error("This category has no URLs configured.");
      return;
    }
    setScanning(true);
    setScanProgress({ pct: 5, label: "Starting scan…" });
    const toastId = toast.loading(`Scanning ${cat.name ?? "category"}…`);
    try {
      // Call the REAL result-producing pipeline (store-scan-run): crawls the
      // category URLs (Firecrawl), extracts product pages, matches against
      // Amazon, and writes rows the grid reads from.
      const { data: startData, error: startError } = await supabase.functions.invoke("store-scan-run", {
        body: {
          supplier_domain: cat.supplier_domain,
          category_urls: cat.urls,
          category_id: cat.id,
          max_products: 1000,
        },
      });
      if (startError) throw startError;
      const runId = (startData as { run_id?: string })?.run_id;
      if (!runId) throw new Error(startData?.error ?? "Scan did not start");

      toast.loading("Crawling supplier pages…", { id: toastId });
      setScanProgress({ pct: 15, label: "Crawling supplier pages…" });

      // Poll the run until it reaches a terminal status.
      const POLL_INTERVAL_MS = 4000;
      const MAX_POLL_MS = 6 * 60 * 1000; // 6 minutes — generous for slow suppliers
      const startedAt = Date.now();
      let runRow: {
        status: string | null;
        error_message: string | null;
        products_found: number | null;
        products_matched: number | null;
        products_extracted: number | null;
        failure_reasons: unknown;
      } | null = null;

      while (Date.now() - startedAt < MAX_POLL_MS) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const { data: row } = await supabase
          .from("store_scan_runs")
          .select("status, error_message, products_found, products_matched, products_extracted, failure_reasons")
          .eq("id", runId)
          .maybeSingle();
        runRow = (row as typeof runRow) ?? null;
        const status = runRow?.status ?? "";
        if (status === "done" || status === "completed" || status === "error" || status === "failed") {
          setScanProgress({ pct: 100, label: "Finalizing…" });
          break;
        }
        const found = runRow?.products_found ?? 0;
        const extracted = runRow?.products_extracted ?? 0;
        const matched = runRow?.products_matched ?? 0;
        // Phase-based progress estimation:
        // 15% start → 40% crawling (found>0) → 70% extracting → 90% matching
        let pct = 15;
        let label = "Crawling supplier pages…";
        if (found > 0) {
          pct = 40;
          label = `Crawling… ${found} pages found`;
        }
        if (extracted > 0) {
          const extractRatio = found > 0 ? Math.min(extracted / found, 1) : 0;
          pct = 40 + Math.round(extractRatio * 30); // 40-70
          label = `Extracting products… ${extracted}/${found}`;
        }
        if (matched > 0) {
          const matchRatio = extracted > 0 ? Math.min(matched / extracted, 1) : 0;
          pct = 70 + Math.round(matchRatio * 20); // 70-90
          label = `Matching on Amazon… ${matched}/${extracted}`;
        }
        // Time-based fallback so the bar always inches forward
        const elapsedPct = Math.min(((Date.now() - startedAt) / MAX_POLL_MS) * 90, 90);
        setScanProgress({ pct: Math.max(pct, elapsedPct), label });
        toast.loading(
          `Scanning… ${found} pages found, ${matched} matched`,
          { id: toastId },
        );
      }

      if (!runRow) {
        toast.error("Scan timed out — please try again.", { id: toastId });
        return;
      }

      const status = runRow.status ?? "";
      const isFailure = status === "error" || status === "failed";
      const failureMessage = runRow.error_message ?? "";
      const reasonsJson = (() => {
        try { return JSON.stringify(runRow.failure_reasons ?? {}); }
        catch { return ""; }
      })();
      const haystack = `${failureMessage} ${reasonsJson}`;
      const looksLikeQuota = /quota|exhaust|monthly|limit reached|payment|insufficient|\b401\b|\b402\b|\b429\b/i.test(haystack);
      const looksLikeBlocked = /\b403\b|blocked|forbidden|captcha/i.test(haystack);

      if (isFailure) {
        if (looksLikeQuota) {
          toast.error(
            "Scraper quota or rate limit reached. Please retry in a few minutes or contact support to top up scraper credits.",
            { id: toastId, duration: 12000 },
          );
        } else if (looksLikeBlocked) {
          toast.error(
            "Supplier site blocked the scraper. We'll need to update the bypass strategy.",
            { id: toastId, duration: 10000 },
          );
        } else if (failureMessage) {
          toast.error(`Scan failed: ${failureMessage.slice(0, 220)}`, { id: toastId, duration: 10000 });
        } else {
          toast.error("Scan failed — no details returned by the scraper.", { id: toastId });
        }
      } else {
        const found = runRow.products_found ?? 0;
        const extracted = runRow.products_extracted ?? 0;
        const matched = runRow.products_matched ?? 0;
        if (found === 0 && extracted === 0) {
          // 0 results AND no extraction = silent provider failure
          // (e.g. Firecrawl quota exhausted, supplier blocked the crawler, or category page returned no products)
          toast.warning(
            "Scan completed but 0 products were extracted from the category page. The scraper may be blocked or out of credits — check Firecrawl status.",
            { id: toastId, duration: 12000 },
          );
        } else if (matched === 0) {
          toast.success(`Scan complete: ${extracted || found} products crawled, none matched on Amazon yet.`, { id: toastId });
        } else {
          toast.success(`Scan complete: ${matched} matches across ${extracted || found} products.`, { id: toastId });
        }
      }

      await loadCategories(true);
      await fetchItems(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/another scan is already running/i.test(msg)) {
        toast.info("A scan is already running for this category — please wait a moment.", { id: toastId });
      } else {
        toast.error(`Scan failed: ${msg.slice(0, 220)}`, { id: toastId, duration: 10000 });
      }
    } finally {
      setScanning(false);
      setScanProgress({ pct: 0, label: "" });
    }
  }, [categoryId, selectedCategory, loadCategories, fetchItems]);

  // ---------- Card renderer ----------
  const renderCard = (it: BrowseItem) => {
    const cur = (it.source_currency ?? "USD").toUpperCase();
    const fx = fxMap[cur] ?? 1;
    const baseCostUsd = it.source_price != null && fx > 0 ? it.source_price / fx : null;
    const verdict = verdictOf(it);
    const reason = reasonOf(it);
    const conf = confidenceOf(it);
    const ev = evidenceOf(it);
    const packMult = packMultiplierOf(it);
    const adjustedCostUsd = baseCostUsd != null ? baseCostUsd * packMult : null;
    const isPackConv = verdict === "same_base_product_different_pack" && packMult !== 1;
    const amazonPackN = ev ? Number((ev as { amazon_pack_count?: unknown }).amazon_pack_count) : NaN;
    const supplierPackN = ev ? Number((ev as { supplier_pack_count?: unknown }).supplier_pack_count) : NaN;
    const isVerifying = verifyingIds.has(it.id);
    const displayRoi = liveRoiMap[it.id] ?? asFiniteNumber(it.roi);
    const rawAmazonPrice = livePriceMap[it.id] ?? asFiniteNumber(it.amz_price);
    const displayAmazonPrice = rawAmazonPrice != null && rawAmazonPrice > 0 ? rawAmazonPrice : null;
    const priceState = priceStateOf(it);

    // (Verdict label/colors are encoded inside <MatchConfidenceBadge />.)


    return (
      <Card key={it.id} className="overflow-hidden flex flex-col">
        <div className="aspect-square bg-muted flex items-center justify-center relative">
          {(it.amz_image_url || it.source_image_url) ? (
            <img
              src={it.amz_image_url ?? normalizeSupplierImageUrl(it.source_image_url) ?? ""}
              alt={it.amz_title ?? it.source_title ?? ""}
              className="w-full h-full object-contain p-3"
              loading="lazy"
            />
          ) : <Store className="h-10 w-10 text-muted-foreground" />}
          <div className="absolute top-2 right-2">
            <MatchConfidenceBadge
              verdict={verdict}
              confidence={conf}
              reason={reason}
              evidence={ev as MatchEvidence | null}
              isAdmin={isAdmin}
              awaitingPrice={!verdict && !!it.matched_asin && priceState === "pending"}
              priceUnavailable={!verdict && !!it.matched_asin && priceState === "unavailable"}
            />
          </div>
        </div>
        <div className="p-3 flex-1 flex flex-col">
          <h3 className="text-sm font-medium line-clamp-2 mb-1">
            {it.amz_title ?? it.source_title ?? "Untitled"}
          </h3>
          {!it.matched_asin && (
            <div className="mb-2">
              <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-400 bg-amber-500/5">
                No valid Amazon match found
              </Badge>
            </div>
          )}
          {it.matched_asin && (
            <div className="text-xs text-muted-foreground font-mono mb-2 flex items-center gap-2 flex-wrap">
              <span>ASIN: {it.matched_asin}</span>
              {(() => {
                const stock = getStockState(it);
                const sb = stockBadgeProps(stock);
                return (
                  <Badge variant="outline" className={`text-[10px] ${sb.className}`} title={sb.title}>
                    {sb.label}
                  </Badge>
                );
              })()}
              {renderEligibilityBadge(it.matched_asin)}
            </div>
          )}
          {isPackConv && Number.isFinite(amazonPackN) && Number.isFinite(supplierPackN) && (
            <div className="mb-2">
              <Badge
                variant="outline"
                className="text-[10px] border-blue-500/40 text-blue-700 dark:text-blue-400 bg-blue-500/5"
                title={`ROI uses adjusted cost = supplier price × ${amazonPackN}/${supplierPackN}`}
              >
                Amazon {amazonPackN}-pack / Supplier {supplierPackN}-pack
              </Badge>
            </div>
          )}
          {verdict && ev && (
            <div className="mb-2">
              <ReasonChips verdict={verdict} evidence={ev as MatchEvidence} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1 mb-2">
            <span className="text-[11px] font-semibold inline-flex items-center gap-1 px-2 py-0.5 rounded border bg-muted/40">
              ROI{" "}
              <StoreScanRoiCell
                asin={it.matched_asin}
                cost={adjustedCostUsd}
                marketplace="US"
                fallbackRoi={isPackConv ? null : asFiniteNumber(it.roi)}
                fallbackPrice={asFiniteNumber(it.amz_price)}
                liveRoiOverride={asFiniteNumber(liveRoiMap[it.id])}
                livePriceOverride={asFiniteNumber(livePriceMap[it.id])}
                onRoi={(roi) => handleLiveRoi(it.id, roi)}
                onPrice={(p) => handleLivePrice(it.id, p)}
                onAmazonPresence={(ap) => handleAmazonPresence(it.id, ap)}
              />
            </span>
            <Badge variant="secondary" className="text-[10px]" title="Live Amazon Buy Box price + your real SP-API fees">
              live
            </Badge>
            {liveRoiMap[it.id] == null && displayRoi != null && !isPackConv && (
              <Badge variant="outline" className="text-[10px]">
                cached
              </Badge>
            )}
            {it.match_confidence && (
              <Badge variant="secondary" className="text-[10px]">
                {it.match_confidence}
              </Badge>
            )}
          </div>
          <div className="text-xs space-y-0.5 mt-auto">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Supplier</span>
              <span className="font-medium">{formatPrice(it.source_price, it.source_currency)}</span>
            </div>
            {isPackConv && adjustedCostUsd != null && (
              <div className="flex justify-between text-blue-700 dark:text-blue-400">
                <span>Adjusted cost ({amazonPackN}×)</span>
                <span className="font-medium">USD {adjustedCostUsd.toFixed(2)}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Amazon</span>
              <span className="font-medium">
                {displayAmazonPrice != null
                  ? `USD ${displayAmazonPrice.toFixed(2)}`
                  : "—"}
              </span>
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <Button asChild size="sm" variant="outline" className="flex-1">
              <a href={it.source_url} target="_blank" rel="noreferrer">
                Source <ExternalLink className="h-3 w-3 ml-1" />
              </a>
            </Button>
            {it.matched_asin && (
              <Button asChild size="sm" className="flex-1">
                <a href={`https://www.amazon.com/dp/${it.matched_asin}`} target="_blank" rel="noreferrer">
                  Amazon <ExternalLink className="h-3 w-3 ml-1" />
                </a>
              </Button>
            )}
          </div>
          {(() => {
            // Multi-candidate explorer: surface all engine-classified Amazon
            // candidates so users don't miss a better listing than the top pick.
            // User-facing rules (simplified vs admin):
            //   • Show only Exact + Likely + Review-needed groups
            //   • Hide "Not Match" entirely
            //   • Hide engine internals (decision_signal, verdict_source)
            //   • Collapsed by default; expand reveals grouped alternatives
            const candidates = it.amz_candidates ?? [];
            // Skip the top result (already shown as the card itself) so the
            // expander only surfaces *additional* options.
            const others = candidates.filter(
              (c) => (c.asin ?? "").toUpperCase() !== (it.matched_asin ?? "").toUpperCase(),
            );
            if (others.length === 0) return null;
            const exact = others.filter(
              (c) => c.verdict === "exact_match" || c.verdict === "same_base_product_different_pack",
            );
            const likely = others.filter((c) => c.verdict === "likely_match");
            const review = others.filter((c) => !c.verdict);
            const visibleCount = exact.length + likely.length + review.length;
            if (visibleCount === 0) return null;

            const renderRow = (
              c: NonNullable<BrowseItem["amz_candidates"]>[number],
              idx: number,
              tone: "exact" | "likely" | "review",
            ) => {
              const href = c.asin
                ? `https://www.amazon.com/dp/${c.asin}`
                : c.link ?? "#";
              const conf = c.engine_confidence ?? c.score;
              const toneClass =
                tone === "exact"
                  ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400 bg-emerald-500/5"
                  : tone === "likely"
                  ? "border-amber-500/40 text-amber-700 dark:text-amber-400 bg-amber-500/5"
                  : "border-muted-foreground/30 text-muted-foreground bg-muted/30";
              return (
                <a
                  key={`${c.asin ?? "na"}-${idx}`}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 rounded-md border border-border/60 bg-background/50 px-2 py-1.5 hover:bg-muted/60 transition-colors"
                  title={c.title ?? undefined}
                >
                  {c.image ? (
                    <img src={c.image} alt="" className="h-8 w-8 rounded object-contain bg-muted" loading="lazy" />
                  ) : (
                    <div className="h-8 w-8 rounded bg-muted" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium truncate">{c.title ?? c.asin ?? "Untitled"}</div>
                    <div className="text-[10px] text-muted-foreground flex items-center gap-2">
                      <span className="font-mono">{c.asin ?? "—"}</span>
                      {c.price != null && <span>USD {Number(c.price).toFixed(2)}</span>}
                    </div>
                  </div>
                  <Badge variant="outline" className={`text-[10px] shrink-0 ${toneClass}`}>
                    {conf != null ? `${Math.round(Number(conf))}%` : "—"}
                  </Badge>
                </a>
              );
            };

            return (
              <details className="mt-3 group">
                <summary className="cursor-pointer list-none flex items-center justify-between text-xs text-muted-foreground hover:text-foreground transition-colors">
                  <span className="inline-flex items-center gap-1.5">
                    <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                    See {visibleCount} other match{visibleCount === 1 ? "" : "es"}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[10px]">
                    {exact.length > 0 && <span className="text-emerald-500">{exact.length} exact</span>}
                    {likely.length > 0 && <span className="text-amber-500">· {likely.length} likely</span>}
                    {review.length > 0 && <span>· {review.length} review</span>}
                  </span>
                </summary>
                <div className="mt-2 space-y-2">
                  {exact.length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-1">
                        Exact matches
                      </div>
                      <div className="space-y-1">{exact.map((c, i) => renderRow(c, i, "exact"))}</div>
                    </div>
                  )}
                  {likely.length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400 mb-1">
                        Likely matches
                      </div>
                      <div className="space-y-1">{likely.map((c, i) => renderRow(c, i, "likely"))}</div>
                    </div>
                  )}
                  {review.length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                        Review needed
                      </div>
                      <div className="space-y-1">{review.slice(0, 5).map((c, i) => renderRow(c, i, "review"))}</div>
                    </div>
                  )}
                </div>
              </details>
            );
          })()}
          {(() => {
            // Hide AI verification entirely when the smart engine has already
            // confirmed an exact match via deterministic identifiers and there
            // are no hard conflicts. The engine is the visible authority.
            const evRec = (ev ?? {}) as Record<string, unknown>;
            const identifierConfirmed = evRec._identifier_confirmed === true;
            const aiFallbackInvoked = evRec._ai_fallback_invoked === true;
            const decisionPath = typeof evRec._engine_decision_path === "string"
              ? (evRec._engine_decision_path as string)
              : "";
            const conflicts = Array.isArray(evRec._hard_conflicts)
              ? (evRec._hard_conflicts as unknown[])
              : [];
            const engineConfirmedExact =
              verdict === "exact_match" &&
              !aiFallbackInvoked &&
              conflicts.length === 0 &&
              (identifierConfirmed
                || decisionPath === "mpn_dominance"
                || decisionPath === "identifier_match"
                || decisionPath === "upc_match"
                || decisionPath === "ean_match");

            if (engineConfirmedExact) return null;

            return (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2 h-7 text-xs"
                disabled={isVerifying}
                onClick={() => runVerify([it], { force: !!verdict })}
              >
                {isVerifying ? (
                  <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Verifying…</>
                ) : verdict ? (
                  <><RefreshCw className="h-3 w-3 mr-1" /> AI second opinion</>
                ) : (
                  <><Wand2 className="h-3 w-3 mr-1" /> Verify with AI</>
                )}
              </Button>
            );
          })()}
        </div>
      </Card>
    );
  };

  const otherCount = sections.review.length + visibleRejectedCount;

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Helmet>
        <title>Store Scan — ArbiProSeller</title>
        <meta name="description" content="Browse pre-scanned profitable supplier products curated by our team." />
      </Helmet>
      <Navbar />
      <main className="flex-grow pt-24 pb-16">
        <div className="container mx-auto px-4 max-w-7xl">
          <div className="mb-8">
            <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-primary mb-2">
              <Sparkles className="h-4 w-4" />
              <span>Curated library — AI-verified matches</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-bold mb-2">Store Scan</h1>
            <p className="text-muted-foreground max-w-2xl">
              Pick a supplier and a category. Top-ROI candidates are verified by AI automatically; click <strong>Verify with AI</strong> on any other row to confirm a match.
            </p>
          </div>

          {/* Search supplier title — pinned to top of page */}
          <Card className="p-4 mb-4">
            <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-end">
              <div className="flex-1">
                <Label className="flex items-center gap-1.5 text-xs mb-1.5">
                  <Search className="h-3.5 w-3.5" /> Search supplier title
                </Label>
                <Input
                  placeholder="Type a product title to filter (supplier titles only)…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && onApply()}
                />
              </div>
              <Button onClick={onApply} disabled={!categoryId} className="sm:w-32">
                <Search className="h-4 w-4 mr-1" /> Search
              </Button>
              {search && (
                <Button
                  variant="outline"
                  onClick={() => { setSearch(""); setTimeout(onApply, 0); }}
                  className="sm:w-24"
                >
                  Clear
                </Button>
              )}
            </div>
            {!categoryId && (
              <p className="text-xs text-muted-foreground mt-2">
                Pick a category below first, then search.
              </p>
            )}
          </Card>

          {/* Auto-detect category from a supplier product URL — admin only */}
          {isAdmin && (
          <Card className="p-4 mb-4">
            <CategoryDetector
              label="Admin: paste a supplier product URL to detect its category."
              onDetected={(d: DetectedCategory) => {
                // Try to switch the picker to the matching curated category
                const supMatch = suppliers.find((s) => s.domain.toLowerCase() === d.supplier_domain.toLowerCase());
                if (supMatch) setSupplierDomain(supMatch.domain);
                // Match against full breadcrumb path first (preferred), then fall back to leaf name.
                const fullPath = (d.path && d.path.trim().length > 0) ? d.path.trim() : d.name;
                const leafLower = d.name.toLowerCase();
                const pathLower = fullPath.toLowerCase();
                const catMatch = categories.find((c) => {
                  if (c.supplier_domain.toLowerCase() !== d.supplier_domain.toLowerCase()) return false;
                  const nameLower = c.name.toLowerCase();
                  return nameLower === pathLower || nameLower === leafLower || nameLower.endsWith(`> ${leafLower}`);
                });
                if (catMatch) {
                  setCategoryId(catMatch.id);
                  toast.success(`Switched to "${catMatch.name}"`);
                } else {
                  toast.info(
                    `Detected "${fullPath}" on ${d.supplier_domain} — not in the curated library yet. Ask an admin to add it.`,
                  );
                }
              }}
            />
          </Card>
          )}

          {/* Admin: PDP-seeded fallback — inject a missing product directly */}
          {isAdmin && (
            <SeedPdpCard
              currentCategoryId={categoryId || null}
              onSeeded={() => {
                // Re-fetch the items so the newly seeded product appears.
                onApply();
              }}
            />
          )}

          {/* Filter card */}
          <Card className="p-5 mb-6">
            {loadingCats ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading categories…
              </div>
            ) : suppliers.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground">
                <FolderTree className="h-8 w-8 mx-auto mb-2" />
                No categories available yet. Check back soon.
              </div>
            ) : (
              <>
              {/* Min ROI — full width on its own row */}
              <MinRoiSliderRow
                value={minRoi}
                onCommit={setMinRoi}
              />

              <div className="grid md:grid-cols-12 gap-4">
                <div className="md:col-span-3">
                  <Label className="flex items-center gap-1.5 text-xs"><Store className="h-3.5 w-3.5" /> Supplier</Label>
                  <div
                    role="listbox"
                    aria-label="Supplier"
                    aria-disabled={suppliers.length === 0}
                    tabIndex={suppliers.length === 0 ? -1 : 0}
                    className={`mt-1.5 border border-input rounded-md bg-background max-h-56 overflow-y-auto divide-y divide-border/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${suppliers.length === 0 ? "opacity-60 cursor-not-allowed" : ""}`}
                  >
                    {suppliers.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-muted-foreground">No suppliers</div>
                    ) : (
                      suppliers.map((s) => {
                        const checked = supplierDomain === s.domain;
                        return (
                          <button
                            key={s.domain}
                            type="button"
                            role="option"
                            aria-selected={checked}
                            onClick={() => setSupplierDomain(s.domain)}
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
                            <span className="flex-1 truncate">{s.domain}</span>
                            <span className="text-xs text-muted-foreground shrink-0">({s.count})</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
                <div className="md:col-span-3">
                  <Label className="flex items-center gap-1.5 text-xs"><FolderTree className="h-3.5 w-3.5" /> Category</Label>
                  <div
                    role="listbox"
                    aria-label="Category"
                    aria-disabled={visibleCategories.length === 0}
                    tabIndex={visibleCategories.length === 0 ? -1 : 0}
                    className={`mt-1.5 border border-input rounded-md bg-background max-h-56 overflow-y-auto divide-y divide-border/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${visibleCategories.length === 0 ? "opacity-60 cursor-not-allowed" : ""}`}
                  >
                    {visibleCategories.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-muted-foreground">No categories</div>
                    ) : (
                      visibleCategories.map((c) => {
                        const checked = categoryId === c.id;
                        return (
                          <button
                            key={c.id}
                            type="button"
                            role="option"
                            aria-selected={checked}
                            onClick={() => setCategoryId(checked ? "" : c.id)}
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
                          </button>
                        );
                      })
                    )}
                  </div>
                  {selectedCategory && (
                    <div className="mt-1.5">
                      <FreshnessBadge lastScannedAt={selectedCategory.last_successful_scan_at ?? selectedCategory.last_scanned_at} />
                    </div>
                  )}
                </div>
                <div className="md:col-span-6 flex items-end">
                  {scanning ? (
                    <div className="w-full space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground truncate pr-2">
                          {scanProgress.label || "Scanning…"}
                        </span>
                        <span className="font-medium tabular-nums text-foreground">
                          {Math.round(scanProgress.pct)}%
                        </span>
                      </div>
                      <Progress value={scanProgress.pct} className="h-2" />
                    </div>
                  ) : (
                    <Button
                      className="w-full"
                      variant="outline"
                      onClick={triggerScan}
                      disabled={!categoryId}
                      title="Run a fresh scan of this category"
                    >
                      <RefreshCw className="h-4 w-4 mr-1" /> Rescan category
                    </Button>
                  )}
                </div>
                {isAdmin && (
                  <div className="md:col-span-12 flex flex-col sm:flex-row items-stretch sm:items-center gap-3 pt-2">
                    <Button
                      size="lg"
                      onClick={() => setAdminRawMode((v) => !v)}
                      disabled={!categoryId}
                      title="Admin: bypass all filters/AI and show every raw row in this supplier + category"
                      className="h-12 px-6 text-base font-bold bg-green-600 hover:bg-green-700 text-white border-2 border-green-700 shadow-lg shadow-green-600/30 ring-2 ring-green-500/40 ring-offset-2 ring-offset-background w-full sm:w-auto"
                    >
                      {adminRawMode ? "🛑 HIDE RAW (ADMIN)" : "🛠️ SHOW RAW (ADMIN) — BYPASS FILTERS"}
                    </Button>
                    {adminRawMode && (
                      <span className="text-xs font-medium text-green-700 dark:text-green-400">
                        Showing every row for the selected supplier + category — no filters, no AI gating.
                      </span>
                    )}
                  </div>
                )}
                <div className="md:col-span-12 flex items-center gap-4 pt-1 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="hide-amazon-dominated"
                      checked={hideAmazonDominated}
                      onCheckedChange={setHideAmazonDominated}
                    />
                    <Label htmlFor="hide-amazon-dominated" className="text-xs cursor-pointer">
                      Hide Amazon-dominated listings
                      <span className="text-muted-foreground ml-1">
                        (Amazon owns the Buy Box and there's effectively no 3P competition)
                      </span>
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="in-stock-only"
                      checked={inStockOnly}
                      onCheckedChange={setInStockOnly}
                    />
                    <Label htmlFor="in-stock-only" className="text-xs cursor-pointer">
                      In stock only
                      <span className="text-muted-foreground ml-1">
                        (hide supplier listings marked out of stock; unknown stock stays visible)
                      </span>
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="matches-only"
                      checked={matchesOnly}
                      onCheckedChange={setMatchesOnly}
                    />
                    <Label htmlFor="matches-only" className="text-xs cursor-pointer">
                      Matches only
                      <span className="text-muted-foreground ml-1">
                        (hides Not Match results — turn off to audit rejected candidates)
                      </span>
                    </Label>
                  </div>
                </div>
              </div>
              </>
            )}
          </Card>

          {/* Minimum Verdict Confidence — always visible (even when results are empty) */}
          {categoryId && !adminRawMode && (
            <Card className="p-4 mb-4">
              <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <Label
                    className="text-xs font-semibold uppercase tracking-wider"
                    title="Filters by the verifier's confidence in its final verdict. Higher = stricter (only show rows the verifier is very sure about). 0% = show every verified row."
                  >
                    Minimum Verdict Confidence
                  </Label>
                  <Badge variant="secondary" className="text-[11px] font-bold">
                    ≥ {minConfidence}%
                  </Badge>
                </div>
                <div className="flex items-center gap-1">
                  {[
                    { label: "Balanced", value: 70 },
                    { label: "Strong", value: 80 },
                    { label: "Strict", value: 90 },
                  ].map((p) => (
                    <Button
                      key={p.label}
                      size="sm"
                      variant={minConfidence === p.value ? "default" : "outline"}
                      className="h-7 px-2.5 text-[11px]"
                      onClick={() => setMinConfidence(p.value)}
                    >
                      {p.label} <span className="opacity-60 ml-1">≥{p.value}%</span>
                    </Button>
                  ))}
                </div>
              </div>
              <Slider
                value={[Math.max(70, minConfidence)]}
                min={70}
                max={100}
                step={1}
                onValueChange={(v) => setMinConfidence(Math.max(70, v[0] ?? 70))}
              />
              <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-1">
                <span>← 70% (minimum)</span>
                <span>100% (only fully confident) →</span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-2">
                Hides rows whose verdict confidence is below this threshold. Verdicts are never changed. Unverified rows are always shown.
              </p>
            </Card>
          )}

          {/* Results */}
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !categoryId ? (
            <Card className="p-10 text-center text-muted-foreground">
              {suppliers.length === 0
                ? "No data available yet."
                : "Select a supplier and category to see matches."}
            </Card>
          ) : adminRawMode ? (
            <Card className="p-4">
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <h2 className="text-sm font-bold uppercase tracking-wider">
                  Raw Rows <span className="text-muted-foreground">({items.length}{total > items.length ? ` of ${total}` : ""})</span>
                </h2>
                <div className="flex items-center gap-2 flex-wrap">
                  {(() => {
                    const runCount = new Set(items.map((it: any) => it.run_id).filter(Boolean)).size;
                    return runCount > 1 ? (
                      <Badge variant="outline" className="text-[10px]">
                        Aggregated from {runCount} scan runs
                      </Badge>
                    ) : null;
                  })()}
                  <Badge variant="outline" className="text-[10px]">Admin · No filters · No AI</Badge>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Shows every matched row from <strong>all scan runs</strong> linked to this category.
                The admin "extracted" count includes unmatched rows too — this view only lists rows that produced an Amazon match.
              </p>
              {items.length === 0 ? (
                <div className="text-sm text-muted-foreground py-8 text-center">
                  No raw rows returned for this supplier + category.
                </div>
              ) : (
                <>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {items.map(renderCard)}
                  </div>
                  {items.length < total && (
                    <div className="flex justify-center mt-4">
                      <Button
                        variant="outline"
                        size="lg"
                        onClick={() => fetchItems(false, true)}
                        disabled={loading}
                        className="font-bold"
                      >
                        {loading
                          ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…</>
                          : `Load more (${items.length} / ${total})`}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </Card>
          ) : items.length === 0 ? (
            <Card className="p-10 text-center text-muted-foreground">
              No products have been loaded for <strong className="text-foreground mx-1">{selectedCategory?.name}</strong> yet.
            </Card>
          ) : matchedItemsBeforeRoi.length === 0 ? (
            <Card className="p-10 text-center text-muted-foreground">
              No visible matched products for <strong className="text-foreground mx-1">{selectedCategory?.name}</strong> with the current non-ROI filters.
              Try turning off <strong className="text-foreground mx-1">Hide Amazon-dominated</strong> or <strong className="text-foreground mx-1">In stock only</strong>, or run a fresh scan.
            </Card>
          ) : matchedItems.length === 0 && needsPriceItems.length === 0 ? (
            <Card className="p-10 text-center text-muted-foreground">
              The ROI slider is hiding the current matches in <strong className="text-foreground mx-1">{selectedCategory?.name}</strong>.
              Lower <strong className="text-foreground mx-1">Min ROI</strong> below <strong className="text-foreground mx-1">{Math.max(0, minRoi)}%</strong> or click <strong className="text-foreground mx-1">Off</strong> to show them again.
            </Card>
          ) : (
            <>

              {/* Eligibility scan progress (Amazon SP-API restrictions) */}
              {eligibilityProgress && (
                <Card className="p-3 mb-4 border-primary/20 bg-primary/5">
                  <div className="flex items-center gap-3 mb-2 flex-wrap">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    <p className="text-sm font-medium">
                      Checking eligibility: {eligibilityProgress.checked} / {eligibilityProgress.total}
                    </p>
                    <Badge variant="default" className="text-[10px] bg-emerald-600">{eligibilitySummary.approved} approved</Badge>
                    <Badge variant="destructive" className="text-[10px]">{eligibilitySummary.restricted} restricted</Badge>
                    <Badge variant="secondary" className="text-[10px] bg-amber-600 text-white hover:bg-amber-700">{eligibilitySummary.approvalRequired} need approval</Badge>
                  </div>
                  <Progress value={(eligibilityProgress.checked / Math.max(1, eligibilityProgress.total)) * 100} className="h-1.5" />
                </Card>
              )}

              {/* Eligibility summary (after scan completes) */}
              {!eligibilityProgress && eligibilitySummary.total > 0 && (
                <Card className="p-3 mb-4 border-primary/20 bg-primary/5">
                  <div className="flex items-center gap-3 text-sm flex-wrap">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    <span className="font-medium">Eligibility:</span>
                    <Badge variant="default" className="text-[10px] bg-emerald-600">{eligibilitySummary.approved} Approved</Badge>
                    <Badge variant="destructive" className="text-[10px]">{eligibilitySummary.restricted} Restricted</Badge>
                    <Badge variant="secondary" className="text-[10px] bg-amber-600 text-white hover:bg-amber-700">{eligibilitySummary.approvalRequired} Need Approval</Badge>
                    {eligibilitySummary.errors > 0 && (
                      <Badge variant="secondary" className="text-[10px]">{eligibilitySummary.errors} Errors</Badge>
                    )}
                  </div>
                </Card>
              )}

              <div className="text-sm text-muted-foreground mb-3">
                Showing {sections.verified.length + sections.packConv.length + sections.review.length + visibleRejectedCount + sections.unverified.length}
                {" of "}{matchedItems.length} match{matchedItems.length === 1 ? "" : "es"} in {selectedCategory?.name}
                {needsPriceItems.length > 0 && (
                  <span> · {needsPriceItems.length} awaiting price</span>
                )}
                {unavailablePriceItems.length > 0 && (
                  <span> · {unavailablePriceItems.length} price unavailable</span>
                )}
                {matchesOnly && sections.rejected.length > 0 && (
                  <span> · {sections.rejected.length} Not Match hidden</span>
                )}
                {!isRoiFilterOff(minRoi) && <span> · ≥ {minRoi}% ROI</span>}
                {sections.hiddenByConfidence > 0 && (
                  <span> · {sections.hiddenByConfidence} hidden below {minConfidence}% confidence</span>
                )}
              </div>

              {needsPriceItems.length > 0 && (
                <section className="mb-8">
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <Loader2 className="h-4 w-4 text-amber-600 animate-spin" />
                    <h2 className="text-sm font-bold uppercase tracking-wider">
                      Match Found — Retrieving Price <span className="text-muted-foreground">({needsPriceItems.length})</span>
                    </h2>
                    <Badge variant="outline" className="text-[10px] ml-2 border-amber-500/40 text-amber-700 dark:text-amber-400 bg-amber-500/5">
                      Amazon ASIN matched · Price fetch in progress
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">
                    These products were matched to an Amazon listing and the app is still trying to get a live Buy Box price.
                  </p>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {needsPriceItems.map(renderCard)}
                  </div>
                </section>
              )}

              {unavailablePriceItems.length > 0 && (
                <section className="mb-8">
                  <div className="flex items-center gap-2 mb-3 flex-wrap">
                    <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-bold uppercase tracking-wider">
                      Match Found — Live Price Unavailable <span className="text-muted-foreground">({unavailablePriceItems.length})</span>
                    </h2>
                    <Badge variant="outline" className="text-[10px] ml-2">
                      Amazon ASIN matched · no live Buy Box price returned
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mb-3">
                    These products were matched to Amazon, but the live pricing lookup returned no usable price right now.
                  </p>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {unavailablePriceItems.map(renderCard)}
                  </div>
                </section>
              )}

              {/* Section 1: Verified Exact Matches */}
              {sections.verified.length > 0 && (
                <section className="mb-8">
                  <div className="flex items-center gap-2 mb-3">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <h2 className="text-sm font-bold uppercase tracking-wider">
                      Verified Exact Matches <span className="text-muted-foreground">({sections.verified.length})</span>
                    </h2>
                  </div>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {sections.verified.map(renderCard)}
                  </div>
                </section>
              )}

              {/* Section 1b: Pack-Conversion Matches */}
              {sections.packConv.length > 0 && (
                <section className="mb-8">
                  <div className="flex items-center gap-2 mb-3">
                    <CheckCircle2 className="h-4 w-4 text-blue-600" />
                    <h2 className="text-sm font-bold uppercase tracking-wider">
                      Pack-Conversion Matches <span className="text-muted-foreground">({sections.packConv.length})</span>
                    </h2>
                    <Badge variant="outline" className="text-[10px] ml-2 border-blue-500/40 text-blue-700 dark:text-blue-400">
                      ROI uses adjusted cost (supplier price × Amazon pack)
                    </Badge>
                  </div>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {sections.packConv.map(renderCard)}
                  </div>
                </section>
              )}

              {sections.unverified.length > 0 && (
                <section className="mb-8">
                  <div className="flex items-center gap-2 mb-3">
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-bold uppercase tracking-wider">
                      Unverified Candidates <span className="text-muted-foreground">({sections.unverified.length})</span>
                    </h2>
                    <Badge variant="outline" className="text-[10px] ml-2">
                      Click "Verify with AI" to confirm
                    </Badge>
                  </div>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {sections.unverified.map(renderCard)}
                  </div>
                </section>
              )}

              {noMatchItems.length > 0 && mainVisibleCount === 0 && sections.review.length === 0 && (
                <section className="mb-8">
                  <div className="flex items-center gap-2 mb-3">
                    <XCircle className="h-4 w-4 text-amber-600" />
                    <h2 className="text-sm font-bold uppercase tracking-wider">
                      No Valid Match <span className="text-muted-foreground">({noMatchItems.length})</span>
                    </h2>
                  </div>
                  <p className="text-sm text-muted-foreground mb-3">
                    All retrieved Amazon candidates were rejected or no verified match was found.
                  </p>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {noMatchItems.map(renderCard)}
                  </div>
                </section>
              )}

              {/* Section 3 (collapsed): Review-needed and Rejected */}
              {otherCount > 0 && (
                <section className="mt-6">
                  <button
                    type="button"
                    onClick={() => setShowOthers((v) => !v)}
                    className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 mb-3"
                  >
                    {showOthers ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    {showOthers ? "Hide" : "Show"} {sections.review.length} review-needed
                    {(forceShowRejected || !matchesOnly) && (
                      <> and {sections.rejected.length} rejected</>
                    )}
                    {" "}candidate{otherCount === 1 ? "" : "s"}
                  </button>
                  {showOthers && (
                    <>
                      {sections.review.length > 0 && (
                        <div className="mb-6">
                          <div className="flex items-center gap-2 mb-3">
                            <AlertTriangle className="h-4 w-4 text-amber-600" />
                            <h3 className="text-sm font-bold uppercase tracking-wider">
                              Review Needed <span className="text-muted-foreground">({sections.review.length})</span>
                            </h3>
                          </div>
                          <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                            {sections.review.map(renderCard)}
                          </div>
                        </div>
                      )}
                      {(forceShowRejected || !matchesOnly) && sections.rejected.length > 0 && (
                        <div className="mb-6">
                          <div className="flex items-center gap-2 mb-3">
                            <XCircle className="h-4 w-4 text-red-600" />
                            <h3 className="text-sm font-bold uppercase tracking-wider">
                              Not Match <span className="text-muted-foreground">({sections.rejected.length})</span>
                            </h3>
                          </div>
                          <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                            {sections.rejected.map(renderCard)}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
};

export default UserStoreScan;
