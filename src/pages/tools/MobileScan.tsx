import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { computeFinalDecision } from "@/lib/finalDecision";
import {
  ArrowLeft,
  Camera,
  CameraOff,
  Loader2,
  ScanLine,
  History as HistoryIcon,
  AlertTriangle,
  Package,
  RotateCw,
  Trash2,
  X,
  ShieldCheck,
  ShieldX,
  ShieldAlert,
  Plus,
  RefreshCw,
  ChevronRight,
  Calculator,
} from "lucide-react";
import { generateSKU } from "@/utils/skuGenerator";
import { toast } from "sonner";

type EligibilityStatus = 'checking' | 'approved' | 'restricted' | 'approval_required' | 'error';

interface ScanRow {
  id: string;
  barcode: string;
  barcode_format: string | null;
  asin: string | null;
  title: string | null;
  image_url: string | null;
  brand: string | null;
  price: number | null;
  currency: string | null;
  marketplace: string | null;
  created_at: string;
  total_cost?: number | null;
  units?: number | null;
  sale_price_override?: number | null;
}

const formatPrice = (price: number | null, currency: string | null) => {
  if (price == null) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(price);
  } catch {
    return `$${price.toFixed(2)}`;
  }
};

const formatTime = (iso: string) => {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
};

const hasCorruptStabilityRange = (s: { min_price: number | null; avg_price: number | null; max_price: number | null }) => {
  const { min_price, avg_price, max_price } = s;
  if (min_price == null || avg_price == null || max_price == null) return false;
  if (![min_price, avg_price, max_price].every((v) => Number.isFinite(v) && v > 0)) return false;
  if (min_price > max_price) return true;
  return min_price > avg_price * 25 || max_price > avg_price * 25;
};

// ============ Decision Signal Engine — smart defaults ============
type DecisionSignal = {
  level: 'safe' | 'opportunity' | 'risky' | 'avoid' | 'unknown';
  label: string;
  emoji: string;
  reasons: string[];
};

const computeDecisionSignal = (
  stab: { verdict?: string; swing_pct?: number | null; intel?: any } | null,
  profitCtx?: { profit: number | null; roi: number | null; hasCost: boolean } | null,
): DecisionSignal => {
  if (!stab || typeof stab !== 'object' || !stab.intel) {
    return { level: 'unknown', label: 'Gathering data…', emoji: '⏳', reasons: [] };
  }
  const intel = stab.intel;
  const reasons: string[] = [];
  let avoidHits = 0;
  let riskyHits = 0;
  let safeHits = 0;

  // Price stability
  if (stab.verdict === 'stable') { safeHits++; reasons.push('Stable 90d price'); }
  else if (stab.verdict === 'volatile') { riskyHits++; reasons.push('Volatile price swings'); }

  // Amazon presence (Amazon on listing = death)
  const amzPresence = intel.amazon_presence_pct;
  if (amzPresence != null) {
    if (amzPresence >= 70) { avoidHits++; reasons.push(`Amazon sells ${amzPresence.toFixed(0)}% of time`); }
    else if (amzPresence >= 30) { riskyHits++; reasons.push(`Amazon sells ${amzPresence.toFixed(0)}% of time`); }
    else if (amzPresence < 5) { safeHits++; reasons.push('Amazon rarely sells'); }
  }

  // Seller competition
  const totalSellers = (intel.sellers_fba ?? 0) + (intel.sellers_fbm ?? 0);
  if (intel.sellers_fba != null) {
    if (totalSellers >= 15) { riskyHits++; reasons.push(`${totalSellers} active sellers`); }
    else if (totalSellers <= 3) { safeHits++; reasons.push(`Low competition (${totalSellers} sellers)`); }
  }

  // BSR / sales velocity
  const bsr = intel.bsr_current;
  if (bsr != null) {
    if (bsr <= 10000) { safeHits++; reasons.push(`Top BSR #${bsr.toLocaleString()}`); }
    else if (bsr > 500000) { riskyHits++; reasons.push(`Slow seller (BSR #${bsr.toLocaleString()})`); }
  }

  // Decide base signal
  let level: DecisionSignal['level'];
  let label: string, emoji: string;
  if (avoidHits >= 1) { level = 'avoid'; label = 'Avoid'; emoji = '❌'; }
  else if (riskyHits >= 2) { level = 'risky'; label = 'Risky'; emoji = '⚠️'; }
  else if (safeHits >= 3 && riskyHits === 0) { level = 'opportunity'; label = 'Opportunity'; emoji = '🔥'; }
  else if (safeHits >= 2 && riskyHits <= 1) { level = 'safe'; label = 'Safe Buy'; emoji = '✅'; }
  else if (riskyHits >= 1) { level = 'risky'; label = 'Risky'; emoji = '⚠️'; }
  else { level = 'unknown'; label = 'Mixed signals'; emoji = '🤔'; }

  // ───── Profit floor override (applied AFTER cost is entered) ─────
  // Real-world correctness: thin margins are fragile regardless of BSR/stability.
  if (profitCtx?.hasCost && profitCtx.profit != null) {
    const p = profitCtx.profit;
    const r = profitCtx.roi ?? 0;
    if (p < 1) {
      level = 'avoid'; label = 'Avoid'; emoji = '❌';
      reasons.unshift(`Profit too low ($${p.toFixed(2)})`);
    } else if (p < 2) {
      level = 'risky'; label = 'Risky'; emoji = '⚠️';
      reasons.unshift(`Low profit ($${p.toFixed(2)})`);
    } else if (p < 3 || r < 25) {
      // Cannot be Safe Buy / Opportunity below profit & ROI floors
      if (level === 'safe' || level === 'opportunity') {
        level = 'risky'; label = 'Risky'; emoji = '⚠️';
      }
      reasons.unshift(`Thin margin ($${p.toFixed(2)} · ${r.toFixed(0)}% ROI)`);
    }
  }

  return { level, label, emoji, reasons: reasons.slice(0, 4) };
};

export default function MobileScan() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const lastScanRef = useRef<{ code: string; ts: number } | null>(null);
  const refreshedCorruptStabilityRef = useRef<Set<string>>(new Set());

  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [history, setHistory] = useState<ScanRow[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [selected, setSelected] = useState<ScanRow | null>(null);
  const [eligibilityMap, setEligibilityMap] = useState<Record<string, EligibilityStatus>>({});
  const [manualInput, setManualInput] = useState("");

  // Fees per ASIN: { referralFee, fbaFee, variableClosingFee }
  const [feesMap, setFeesMap] = useState<Record<string, { referralFee: number; fbaFee: number; variableClosingFee: number } | 'loading' | 'error'>>({});
  // Cost, units & manual sale price inputs per scan id (so each scan keeps its own values)
  const [costInputs, setCostInputs] = useState<Record<string, { totalCost: string; units: string; salePrice: string }>>({});

  const fetchFees = useCallback(async (asin: string) => {
    if (!asin || feesMap[asin]) return;
    setFeesMap(prev => ({ ...prev, [asin]: 'loading' }));
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const { data, error } = await supabase.functions.invoke('personalhour-product-data', {
        body: { asin: asin.toUpperCase() },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) throw error;
      const fees = data?.fees;
      if (fees) {
        setFeesMap(prev => ({
          ...prev,
          [asin]: {
            referralFee: Number(fees.referralFee) || 0,
            fbaFee: Number(fees.fbaFee) || 0,
            variableClosingFee: Number(fees.variableClosingFee) || 0,
          },
        }));
      } else {
        setFeesMap(prev => ({ ...prev, [asin]: 'error' }));
      }
    } catch (e) {
      console.warn('[mobile-scan] fees fetch failed', e);
      setFeesMap(prev => ({ ...prev, [asin]: 'error' }));
    }
  }, [feesMap]);

  // Track price-fetch state per scan id: 'loading' | 'error' | 'done'
  const [priceFetchState, setPriceFetchState] = useState<Record<string, 'loading' | 'error' | 'done'>>({});

  const fetchPriceForScan = useCallback(async (row: ScanRow) => {
    if (!row.asin) return;
    if (row.price != null && row.price > 0) return;
    if (priceFetchState[row.id] === 'loading' || priceFetchState[row.id] === 'done') return;
    setPriceFetchState(prev => ({ ...prev, [row.id]: 'loading' }));
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      // Use the SAME endpoint as Create Listing (personalhour-product-data)
      const { data, error } = await supabase.functions.invoke(
        'personalhour-product-data',
        {
          body: { asin: row.asin.toUpperCase() },
          headers: { Authorization: `Bearer ${session.access_token}` },
        },
      );
      if (error) throw error;
      const fetchedPrice = data?.price != null ? Number(data.price) : null;
      const fetchedCurrency = data?.currency || "USD";
      if (fetchedPrice != null && isFinite(fetchedPrice) && fetchedPrice > 0) {
        // Update local state
        setHistory(prev => prev.map(r => r.id === row.id ? { ...r, price: fetchedPrice, currency: fetchedCurrency } : r));
        setSelected(prev => prev && prev.id === row.id ? { ...prev, price: fetchedPrice, currency: fetchedCurrency } : prev);
        // Persist back to DB (best-effort)
        supabase.from("mobile_scan_history")
          .update({ price: fetchedPrice, currency: fetchedCurrency })
          .eq("id", row.id)
          .then(({ error: upErr }) => { if (upErr) console.warn("[mobile-scan] persist price failed", upErr); });
        setPriceFetchState(prev => ({ ...prev, [row.id]: 'done' }));
      } else {
        setPriceFetchState(prev => ({ ...prev, [row.id]: 'error' }));
      }
    } catch (e) {
      console.warn("[mobile-scan] price refetch failed", e);
      setPriceFetchState(prev => ({ ...prev, [row.id]: 'error' }));
    }
  }, [priceFetchState]);

  // ---- 90-day price stability (Keepa) ----
  type ProductIntel = {
    bsr_current: number | null;
    bsr_avg_90: number | null;
    sellers_fba: number | null;
    sellers_fbm: number | null;
    amazon_buybox_pct: number | null;
    third_party_buybox_pct: number | null;
    amazon_presence_pct: number | null;
    fba_fee_estimate: number | null;
    brand: string | null;
    title: string | null;
    variation_count: number | null;
    category_tree: string | null;
    product_age_days: number | null;
    est_monthly_sales: number | null;
  };
  type StabilityData = {
    verdict: 'stable' | 'moderate' | 'volatile' | 'unknown';
    current_price: number | null;
    min_price: number | null;
    avg_price: number | null;
    max_price: number | null;
    swing_pct: number | null;
    drops_90: number | null;
    days_covered: number;
    series_used: string | null;
    reason?: string | null;
    intel?: ProductIntel | null;
  };
  type StabilityState = StabilityData | 'loading' | { status: 'error'; message: string };
  const [stabilityMap, setStabilityMap] = useState<Record<string, StabilityState>>({});
  const [stabilityExpanded, setStabilityExpanded] = useState<Record<string, boolean>>({});

  const fetchStabilityForScan = useCallback(async (asin: string | null, marketplace = 'US', force = false) => {
    if (!asin) return;
    const key = `${asin}|${marketplace}`;
    if (!force) {
      const existing = stabilityMap[key];
      if (existing === 'loading' || (existing && !(typeof existing === 'object' && 'status' in existing))) return;
    }
    setStabilityMap(prev => ({ ...prev, [key]: 'loading' }));
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const { data, error } = await supabase.functions.invoke('mobile-scan-price-stability', {
        body: { asin, marketplace, force },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) {
        const response = (error as any).context;
        if (response && typeof response.clone === 'function') {
          const body = await response.clone().json().catch(() => null);
          throw new Error(body?.error || error.message);
        }
        throw error;
      }
      if (!data || data.error) throw new Error(data?.error || 'Stability fetch failed');
      setStabilityMap(prev => ({ ...prev, [key]: data as StabilityData }));
    } catch (e) {
      console.warn('[mobile-scan] stability fetch failed', e);
      const message = e instanceof Error ? e.message : 'Stability fetch failed';
      setStabilityMap(prev => ({ ...prev, [key]: { status: 'error', message } }));
    }
  }, [stabilityMap]);

  useEffect(() => {
    if (!selected?.asin) return;
    const key = `${selected.asin}|US`;
    const stab = stabilityMap[key];
    if (stab && typeof stab === 'object' && !('status' in stab) && hasCorruptStabilityRange(stab) && !refreshedCorruptStabilityRef.current.has(key)) {
      refreshedCorruptStabilityRef.current.add(key);
      fetchStabilityForScan(selected.asin, 'US', true);
    }
  }, [selected?.asin, stabilityMap, fetchStabilityForScan]);

  // Hydrate costInputs for the selected scan from row values (carried over via cost memory).
  useEffect(() => {
    if (!selected?.id) return;
    setCostInputs(prev => {
      if (prev[selected.id]) return prev;
      return {
        ...prev,
        [selected.id]: {
          totalCost: selected.total_cost != null ? String(selected.total_cost) : '',
          units: selected.units != null ? String(selected.units) : '1',
          salePrice: selected.sale_price_override != null ? String(selected.sale_price_override) : '',
        },
      };
    });
  }, [selected?.id, selected?.total_cost, selected?.units, selected?.sale_price_override]);

  // Persist cost edits (debounced) per-row + cost memory keyed by user+barcode/ASIN.
  useEffect(() => {
    if (!selected?.id || !user?.id) return;
    const inp = costInputs[selected.id];
    if (!inp) return;
    const t = setTimeout(async () => {
      const totalCostNum = inp.totalCost === '' ? null : parseFloat(inp.totalCost);
      const unitsNum = inp.units === '' ? null : Math.max(1, parseInt(inp.units) || 1);
      const saleNum = inp.salePrice === '' ? null : parseFloat(inp.salePrice);
      const safeCost = totalCostNum != null && isFinite(totalCostNum) ? totalCostNum : null;
      const safeSale = saleNum != null && isFinite(saleNum) ? saleNum : null;

      supabase
        .from("mobile_scan_history")
        .update({ total_cost: safeCost, units: unitsNum, sale_price_override: safeSale })
        .eq("id", selected.id)
        .then(({ error }) => { if (error) console.warn("[mobile-scan] persist cost failed", error); });

      const barcode = selected.barcode || null;
      const asin = selected.asin || null;
      if (!barcode && !asin) return;
      try {
        const lookup = supabase
          .from("mobile_scan_cost_memory")
          .select("id")
          .eq("user_id", user.id)
          .limit(1);
        const { data: existing } = await (barcode
          ? lookup.eq("barcode", barcode)
          : lookup.is("barcode", null).eq("asin", asin)
        ).maybeSingle();
        const payload = { user_id: user.id, barcode, asin, total_cost: safeCost, units: unitsNum, sale_price_override: safeSale };
        if (existing?.id) await supabase.from("mobile_scan_cost_memory").update(payload).eq("id", existing.id);
        else await supabase.from("mobile_scan_cost_memory").insert(payload);
      } catch (e) {
        console.warn("[mobile-scan] cost memory persist failed", e);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [selected?.id, selected?.barcode, selected?.asin, user?.id, costInputs]);

  const updateCostInput = (id: string, patch: Partial<{ totalCost: string; units: string; salePrice: string }>) => {
    setCostInputs(prev => ({
      ...prev,
      [id]: { totalCost: '', units: '1', salePrice: '', ...prev[id], ...patch },
    }));
  };

  const getEffectivePrice = (row: ScanRow): number | null => {
    if (row.price != null && row.price > 0) return row.price;
    const inp = costInputs[row.id];
    const manual = parseFloat(inp?.salePrice || '');
    return isFinite(manual) && manual > 0 ? manual : null;
  };

  const computeProfitRoi = (row: ScanRow) => {
    if (!row.asin) return null;
    const fees = feesMap[row.asin];
    const inp = costInputs[row.id] || { totalCost: '', units: '1', salePrice: '' };
    const totalCostNum = parseFloat(inp.totalCost);
    const unitsNum = Math.max(1, parseInt(inp.units) || 1);
    const priceNum = getEffectivePrice(row);
    const totalFees = fees && typeof fees === 'object'
      ? fees.referralFee + fees.fbaFee + fees.variableClosingFee
      : 0;
    const feesReady = typeof fees === 'object';
    const afterFees = priceNum != null ? priceNum - totalFees : null;
    // Max cost for 30% ROI target: cost = afterFees / 1.30
    const maxCost30 = afterFees != null && afterFees > 0 ? afterFees / 1.30 : null;
    const breakeven = afterFees;
    if (!isFinite(totalCostNum) || totalCostNum <= 0 || priceNum == null) {
      return {
        cog: 0, totalFees, profit: 0, roi: 0, feesReady,
        afterFees, breakeven, maxCost30, hasCost: false,
      };
    }
    const cog = totalCostNum / unitsNum;
    const profit = priceNum - totalFees - cog;
    const roi = cog > 0 ? (profit / cog) * 100 : 0;
    return { cog, totalFees, profit, roi, feesReady, afterFees, breakeven, maxCost30, hasCost: true };
  };

  /* ───────── create-listing form per scan ───────── */
  type CreateForm = { sku: string; quantity: string; fulfillment: 'FBA' | 'FBM' };
  const [createForms, setCreateForms] = useState<Record<string, CreateForm>>({});
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [createdIds, setCreatedIds] = useState<Set<string>>(new Set());

  const getCreateForm = (id: string): CreateForm => {
    return createForms[id] || { sku: '', quantity: '1', fulfillment: 'FBA' };
  };
  const updateCreateForm = (id: string, patch: Partial<CreateForm>) => {
    setCreateForms(prev => ({
      ...prev,
      [id]: { sku: '', quantity: '1', fulfillment: 'FBA', ...prev[id], ...patch },
    }));
  };

  const ensureSku = (id: string) => {
    if (!createForms[id]?.sku) {
      updateCreateForm(id, { sku: generateSKU() });
    }
  };

  const createListingFromScan = async (row: ScanRow) => {
    if (!user || !row.asin) return;
    const form = getCreateForm(row.id);
    const inp = costInputs[row.id] || { totalCost: '', units: '1' };
    const totalCostNum = parseFloat(inp.totalCost);
    const unitsNum = Math.max(1, parseInt(inp.units) || 1);
    const qtyNum = Math.max(1, parseInt(form.quantity) || 1);
    const priceNum = getEffectivePrice(row);

    if (!form.sku) {
      toast.error("SKU is required");
      return;
    }
    if (!isFinite(totalCostNum) || totalCostNum <= 0) {
      toast.error("Enter a valid Total Cost first");
      return;
    }
    if (priceNum == null || priceNum <= 0) {
      toast.error("No selling price available");
      return;
    }

    setCreatingId(row.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const cogNum = totalCostNum / unitsNum;
      const today = new Date().toISOString().split('T')[0];

      // FNSKU lookup
      const { data: fnskuData } = await supabase
        .from("fnsku_map")
        .select("fnsku")
        .eq("asin", row.asin.toUpperCase())
        .maybeSingle();

      // 1) Save to created_listings
      const { error: invErr } = await supabase
        .from("created_listings")
        .insert([{
          user_id: user.id,
          asin: row.asin.toUpperCase(),
          sku: form.sku,
          fnsku: fnskuData?.fnsku || null,
          title: row.title,
          image_url: row.image_url,
          price: priceNum,
          cost: totalCostNum,
          amount: cogNum,
          units: unitsNum,
          supplier_links: [] as any,
          date_created: today,
        }]);
      if (invErr) throw invErr;

      // 2) Create on Amazon (US)
      const { MARKETPLACE_CONFIGS } = await import("@/lib/marketplaceCurrency");
      const mpConfig = (MARKETPLACE_CONFIGS as any)?.US;
      const { data: listingData, error: listingError } = await supabase.functions.invoke(
        'create-amazon-listing',
        {
          body: {
            asin: row.asin.toUpperCase(),
            sku: form.sku,
            price: priceNum,
            quantity: qtyNum,
            condition: 'new_new',
            fulfillmentChannel: form.fulfillment,
            cost: totalCostNum,
            marketplaceId: mpConfig?.marketplaceId,
            marketplaceCode: 'US',
          },
          headers: { Authorization: `Bearer ${session.access_token}` },
        }
      );
      if (listingError) throw listingError;

      const issues = (listingData as any)?.issues;
      if (Array.isArray(issues) && issues.some((i: any) => i?.severity === 'ERROR')) {
        toast.warning(`Saved to DB. Amazon returned ${issues.length} issue(s).`);
      } else {
        toast.success(`Listing created on Amazon (${form.fulfillment}) for ${row.asin}`);
      }
      setCreatedIds(prev => new Set(prev).add(row.id));
    } catch (e: any) {
      console.error("[mobile-scan] create listing failed", e);
      toast.error(e?.message || "Failed to create listing");
    } finally {
      setCreatingId(null);
    }
  };

  /* ───────── eligibility lookup ───────── */
  const checkEligibility = useCallback(async (asins: string[]) => {
    const unique = Array.from(new Set(asins.filter(Boolean)));
    if (unique.length === 0) return;
    setEligibilityMap(prev => {
      const next = { ...prev };
      unique.forEach(a => { if (!next[a] || next[a] === 'error') next[a] = 'checking'; });
      return next;
    });
    try {
      const { data, error } = await supabase.functions.invoke('check-product-eligibility', {
        body: { marketplace: 'US', asins: unique, force_rescan: false },
      });
      if (error) {
        setEligibilityMap(prev => {
          const next = { ...prev };
          unique.forEach(a => { next[a] = 'error'; });
          return next;
        });
        return;
      }
      const results: { asin: string; status: string }[] = data?.results || [];
      setEligibilityMap(prev => {
        const next = { ...prev };
        for (const r of results) {
          next[r.asin] = r.status === 'approved' ? 'approved'
            : r.status === 'approval_required' ? 'approval_required'
            : r.status === 'restricted' ? 'restricted'
            : 'error';
        }
        for (const a of unique) {
          if (!next[a] || next[a] === 'checking') next[a] = 'error';
        }
        return next;
      });
    } catch {
      setEligibilityMap(prev => {
        const next = { ...prev };
        unique.forEach(a => { next[a] = 'error'; });
        return next;
      });
    }
  }, []);

  const renderEligibilityBadge = (asin: string | null | undefined, size: 'sm' | 'md' = 'sm') => {
    if (!asin) return null;
    const status = eligibilityMap[asin];
    if (!status) return null;
    const base = size === 'sm'
      ? "inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md border"
      : "inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-md border";
    const icon = size === 'sm' ? "h-3 w-3" : "h-3.5 w-3.5";
    switch (status) {
      case 'checking':
        return (
          <span className={`${base} bg-white/5 border-white/15 text-white/70 animate-pulse`}>
            <Loader2 className={`${icon} animate-spin`} /> Checking
          </span>
        );
      case 'approved':
        return (
          <span className={`${base} bg-emerald-500/15 border-emerald-400/40 text-emerald-300`}>
            <ShieldCheck className={icon} /> Approved
          </span>
        );
      case 'restricted':
        return (
          <span className={`${base} bg-red-500/15 border-red-400/40 text-red-300`}>
            <ShieldX className={icon} /> Restricted
          </span>
        );
      case 'approval_required':
        return (
          <span className={`${base} bg-amber-500/15 border-amber-400/40 text-amber-300`}>
            <ShieldAlert className={icon} /> Needs Approval
          </span>
        );
      case 'error':
        return (
          <span className={`${base} bg-white/5 border-white/15 text-white/50`}>
            Eligibility N/A
          </span>
        );
      default:
        return null;
    }
  };

  /* ───────── auth gate ───────── */
  useEffect(() => {
    if (!authLoading && !user) navigate("/login", { replace: true });
  }, [authLoading, user, navigate]);

  /* ───────── load history ───────── */
  const loadHistory = useCallback(async () => {
    if (!user) return;
    setLoadingHistory(true);
    try {
      const { data, error } = await supabase
        .from("mobile_scan_history")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      const rows = (data || []) as ScanRow[];
      setHistory(rows);
      const asins = rows.map(r => r.asin).filter(Boolean) as string[];
      if (asins.length) checkEligibility(asins);
    } catch (e: any) {
      console.error("[mobile-scan] load history", e);
    } finally {
      setLoadingHistory(false);
    }
  }, [user]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  /* ───────── resolve UPC → product ───────── */
  const resolveAndSave = useCallback(
    async (input: string, format: string | null, asinHint?: string | null) => {
      if (!user) return;
      setResolving(true);
      let asin: string | null = asinHint ? asinHint.toUpperCase() : null;
      let title: string | null = null;
      let image_url: string | null = null;
      let brand: string | null = null;
      let price: number | null = null;
      let currency: string | null = null;
      let raw: any = null;

      try {
        // Step 1: lookup catalog. For ASIN inputs, query by ASIN; for barcodes, by barcode.
        const query = asin || input;
        const { data: catalog, error: catErr } = await supabase.functions.invoke(
          "sourcer-search-catalog",
          { body: { query, marketplace: "US" } },
        );
        if (catErr) throw catErr;
        raw = catalog;
        const item = catalog?.items?.[0];
        if (item) {
          asin = (item.asin || asin) ?? null;
          title = item.title;
          image_url = item.imageUrl;
          brand = item.brand;
        }

        // Step 2: ASIN → price (best-effort, don't block save) — same endpoint as Create Listing
        if (asin) {
          try {
            const { data: { session } } = await supabase.auth.getSession();
            const { data: prod } = await supabase.functions.invoke(
              'personalhour-product-data',
              {
                body: { asin: asin.toUpperCase() },
                headers: session ? { Authorization: `Bearer ${session.access_token}` } : undefined,
              },
            );
            if (prod?.price != null) {
              price = Number(prod.price);
              currency = prod.currency || "USD";
            }
          } catch (priceErr) {
            console.warn("[mobile-scan] price fetch failed", priceErr);
          }
        }
      } catch (e: any) {
        console.error("[mobile-scan] resolve failed", e);
        toast.error(`Lookup failed: ${e.message ?? "unknown"}`);
      }

      // Save to history regardless
      try {
        // Carry over previously-entered cost/units/sale-price-override for the same
        // barcode (or ASIN if barcode missing). Re-scanning the same product should
        // not wipe the cost the user already typed in.
        let priorCost: number | null = null;
        let priorUnits: number | null = null;
        let priorSaleOverride: number | null = null;
        try {
          // 1) Preferred: persistent cost memory keyed by user+barcode (or ASIN).
          let memQ = supabase
            .from("mobile_scan_cost_memory")
            .select("total_cost, units, sale_price_override")
            .eq("user_id", user.id)
            .limit(1);
          if (input) memQ = memQ.eq("barcode", input);
          else if (asin) memQ = memQ.is("barcode", null).eq("asin", asin);
          const { data: mem } = await memQ.maybeSingle();
          if (mem) {
            priorCost = (mem as any).total_cost ?? null;
            priorUnits = (mem as any).units ?? null;
            priorSaleOverride = (mem as any).sale_price_override ?? null;
          } else {
            // 2) Fallback: copy from the most recent prior scan row.
            let q = supabase
              .from("mobile_scan_history")
              .select("total_cost, units, sale_price_override")
              .eq("user_id", user.id)
              .order("created_at", { ascending: false })
              .limit(1);
            if (input) q = q.eq("barcode", input);
            else if (asin) q = q.eq("asin", asin);
            const { data: prior } = await q.maybeSingle();
            if (prior) {
              priorCost = (prior as any).total_cost ?? null;
              priorUnits = (prior as any).units ?? null;
              priorSaleOverride = (prior as any).sale_price_override ?? null;
            }
          }
        } catch (priorErr) {
          console.warn("[mobile-scan] prior cost lookup failed", priorErr);
        }

        const { data: inserted, error: insErr } = await supabase
          .from("mobile_scan_history")
          .insert({
            user_id: user.id,
            barcode: input,
            barcode_format: format,
            asin,
            title,
            image_url,
            brand,
            price,
            currency,
            marketplace: "US",
            raw,
            total_cost: priorCost,
            units: priorUnits,
            sale_price_override: priorSaleOverride,
          })
          .select("*")
          .single();
        if (insErr) throw insErr;
        setHistory((prev) => [inserted as ScanRow, ...prev].slice(0, 50));
        setSelected(inserted as ScanRow);
        ensureSku((inserted as ScanRow).id);
        if (asin) {
          toast.success(`Found ${asin}`);
          checkEligibility([asin]);
          fetchFees(asin);
        } else {
          toast.warning("Saved scan — no Amazon match found");
        }
      } catch (e: any) {
        console.error("[mobile-scan] save failed", e);
        toast.error("Could not save scan");
      } finally {
        setResolving(false);
      }
    },
    [user, checkEligibility, fetchFees],
  );

  /* ───────── scanner control ───────── */
  const stopScanner = useCallback(() => {
    try {
      controlsRef.current?.stop();
    } catch {}
    controlsRef.current = null;
    setScanning(false);
  }, []);

  const startScanner = useCallback(async () => {
    setCameraError(null);
    if (!videoRef.current) return;
    try {
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.CODE_128,
        BarcodeFormat.CODE_39,
      ]);
      hints.set(DecodeHintType.TRY_HARDER, true);
      const reader = new BrowserMultiFormatReader(hints);

      // Prefer rear camera
      const constraints: MediaStreamConstraints = {
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      };

      setScanning(true);
      const controls = await reader.decodeFromConstraints(
        constraints,
        videoRef.current,
        (result, _err, ctrl) => {
          if (!result) return;
          const code = result.getText();
          const now = Date.now();
          // Debounce identical scans within 3s
          if (
            lastScanRef.current &&
            lastScanRef.current.code === code &&
            now - lastScanRef.current.ts < 3000
          ) {
            return;
          }
          lastScanRef.current = { code, ts: now };
          // Haptic feedback
          try {
            (navigator as any).vibrate?.(80);
          } catch {}
          ctrl.stop();
          controlsRef.current = null;
          setScanning(false);
          resolveAndSave(code, result.getBarcodeFormat()?.toString() ?? null);
        },
      );
      controlsRef.current = controls;
    } catch (e: any) {
      console.error("[mobile-scan] camera error", e);
      setCameraError(e.message || "Camera unavailable");
      setScanning(false);
    }
  }, [resolveAndSave]);

  useEffect(() => () => stopScanner(), [stopScanner]);

  const deleteScan = async (id: string) => {
    try {
      await supabase.from("mobile_scan_history").delete().eq("id", id);
      setHistory((prev) => prev.filter((r) => r.id !== id));
      if (selected?.id === id) setSelected(null);
    } catch (e) {
      toast.error("Delete failed");
    }
  };

  /* ───────── render ───────── */
  return (
    <div className="min-h-screen bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)] text-white">
      <Helmet>
        <title>Scan UPC | ArbiProSeller Mobile</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
      </Helmet>

      {/* Header */}
      <header className="sticky top-0 z-20 backdrop-blur-md bg-black/40 border-b border-white/10">
        <div className="flex items-center gap-2 px-4 py-3">
          <button
            onClick={() => navigate("/tools/dashboard")}
            className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-white/5 border border-white/10"
            aria-label="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex-1">
            <h1 className="text-base font-semibold leading-none">Barcode Scanner</h1>
            <p className="text-[11px] text-white/50 mt-0.5">UPC / EAN → Amazon product</p>
          </div>
          <button
            onClick={loadHistory}
            className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-white/5 border border-white/10"
            aria-label="Refresh history"
          >
            <RotateCw className="h-4 w-4" />
          </button>
        </div>
      </header>

      <main className="px-4 pt-4 pb-24 max-w-md mx-auto">
        {/* Scanner viewport */}
        <div className="relative rounded-2xl overflow-hidden border border-emerald-400/30 bg-black aspect-[4/3] shadow-lg shadow-emerald-500/10">
          <video
            ref={videoRef}
            className="w-full h-full object-cover"
            playsInline
            muted
          />
          {/* Overlay frame */}
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
            <div className="relative w-[80%] h-[35%]">
              <div className="absolute inset-0 border-2 border-emerald-400/80 rounded-xl" />
              {scanning && (
                <div className="absolute inset-x-0 top-0 h-0.5 bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.8)] animate-[scan_2s_ease-in-out_infinite]" />
              )}
            </div>
          </div>
          {!scanning && !resolving && (
            <div className="absolute inset-0 flex items-center justify-center text-white/60 text-sm">
              <div className="text-center">
                <ScanLine className="h-8 w-8 mx-auto mb-2 opacity-60" />
                Tap "Start scanning"
              </div>
            </div>
          )}
          {resolving && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
              <div className="text-center">
                <Loader2 className="h-8 w-8 mx-auto mb-2 animate-spin text-emerald-400" />
                <div className="text-sm text-white/80">Looking up product…</div>
              </div>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="mt-3 flex gap-2">
          {scanning ? (
            <Button onClick={stopScanner} variant="destructive" className="flex-1">
              <CameraOff className="h-4 w-4 mr-2" /> Stop
            </Button>
          ) : (
            <Button
              onClick={startScanner}
              disabled={resolving}
              className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white"
            >
              <Camera className="h-4 w-4 mr-2" />
              Start scanning
            </Button>
          )}
        </div>

        {/* Manual UPC / ASIN entry */}
        <div className="mt-3 rounded-xl bg-white/[0.04] border border-white/10 p-3">
          <div className="text-[11px] uppercase tracking-wide text-white/50 font-semibold mb-2">
            Or enter UPC / ASIN manually
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const raw = manualInput.trim();
              if (!raw || resolving) return;
              const cleaned = raw.replace(/\s+/g, "").toUpperCase();
              const isAsin = /^B0[A-Z0-9]{8}$/.test(cleaned);
              const isBarcode = /^\d{8,14}$/.test(cleaned);
              if (!isAsin && !isBarcode) {
                toast.error("Enter a valid UPC/EAN (8–14 digits) or ASIN (B0XXXXXXXX)");
                return;
              }
              if (scanning) stopScanner();
              setManualInput("");
              if (isAsin) {
                resolveAndSave(cleaned, "ASIN", cleaned);
              } else {
                resolveAndSave(cleaned, "MANUAL", null);
              }
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              placeholder="e.g. 817810027017 or B01M4QMQ4B"
              className="flex-1 h-10 px-3 rounded-lg bg-black/40 border border-white/15 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-emerald-400/60"
              disabled={resolving}
            />
            <Button
              type="submit"
              disabled={resolving || !manualInput.trim()}
              className="bg-emerald-500 hover:bg-emerald-600 text-white"
            >
              {resolving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Look up"}
            </Button>
          </form>
        </div>

        {cameraError && (
          <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold mb-1">Camera blocked</div>
              {cameraError}. Allow camera access in browser settings, then try again.
            </div>
          </div>
        )}

        {/* Last scan inline card */}
        {selected && (
          <section className="mt-5">
            <div className="text-[11px] uppercase tracking-wide text-white/50 font-semibold mb-2">Last scan</div>
            <button
              onClick={() => navigate(`/m/scan/${selected.id}`)}
              className="w-full flex items-center gap-3 p-3 rounded-2xl bg-white/[0.04] border border-emerald-400/30 hover:border-emerald-400/60 active:scale-[0.99] transition text-left"
            >
              <div className="h-14 w-14 min-w-14 rounded-lg overflow-hidden bg-white/10 flex items-center justify-center">
                {selected.image_url ? (
                  <img src={selected.image_url} alt={selected.title || selected.barcode} className="h-full w-full object-cover" />
                ) : (
                  <Package className="h-6 w-6 text-white/40" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-white truncate">
                  {selected.title || "(no Amazon match)"}
                </div>
                <div className="text-[10px] text-white/50 mt-0.5 flex items-center gap-1.5">
                  <span className="font-mono">{selected.barcode}</span>
                  {selected.asin && <><span>·</span><span className="font-mono text-emerald-300/80">{selected.asin}</span></>}
                </div>
                <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                  {renderEligibilityBadge(selected.asin)}
                  <span className="text-[10px] text-white/40">{formatTime(selected.created_at)}</span>
                </div>
              </div>
              <div className="text-right flex items-center gap-1">
                <div>
                  <div className="text-sm font-semibold text-emerald-300">{formatPrice(selected.price, selected.currency)}</div>
                  <div className="text-[9px] text-emerald-300/70 mt-0.5 whitespace-nowrap">Open detail →</div>
                </div>
                <ChevronRight className="h-4 w-4 text-white/40" />
              </div>
            </button>

            {/* Inline Profit & ROI calculator (mirrors the detail page) */}
            {selected.asin && (() => {
              const inp = costInputs[selected.id] || { totalCost: '', units: '1', salePrice: '' };
              const r = computeProfitRoi(selected);
              const fees = feesMap[selected.asin];
              const feesLoading = fees === 'loading';
              const feesError = fees === 'error';
              const stabKey = `${selected.asin}|US`;
              const stabRaw = stabilityMap[stabKey];
              const stab = stabRaw && typeof stabRaw === 'object' && !('status' in stabRaw) ? stabRaw : null;
              const decision = computeDecisionSignal(stab as any, r ? { profit: r.profit, roi: r.roi, hasCost: !!r.hasCost } : null);
              // Unified Final Decision (mirrors extension analyzer)
              const eligStatus = selected.asin ? eligibilityMap[selected.asin] : null;
              const overrideActiveInline = inp.salePrice !== '' && parseFloat(inp.salePrice) > 0;
              const bbPriceInline = selected.price != null && selected.price > 0 ? Number(selected.price) : null;
              const intelFba = stab?.intel?.sellers_fba;
              const intelFbm = stab?.intel?.sellers_fbm;
              const offerCountsInline =
                (intelFba != null && intelFba > 0) || (intelFbm != null && intelFbm > 0)
                  ? { fba: intelFba ?? 0, fbm: intelFbm ?? 0 }
                  : null;
              const fd = computeFinalDecision({
                profit: r?.hasCost ? r.profit : null,
                roi: r?.hasCost ? r.roi : null,
                hasCost: !!r?.hasCost,
                eligibility: eligStatus || null,
                intel: stab?.intel || null,
                offerCounts: offerCountsInline,
                swingPct: stab?.swing_pct ?? null,
                rangeLabel: '3M',
                buyBoxPrice: bbPriceInline,
                simOverride: overrideActiveInline
                  ? { active: true, profit: r?.profit ?? null, roi: r?.roi ?? null, salePrice: parseFloat(inp.salePrice) }
                  : null,
              });
              const fdLevelStyle: Record<typeof fd.final.level, string> = {
                good: 'border-emerald-400/60 bg-gradient-to-br from-emerald-500/20 to-emerald-500/5 text-emerald-50',
                caution: 'border-amber-400/60 bg-gradient-to-br from-amber-500/20 to-amber-500/5 text-amber-50',
                bad: 'border-rose-500/70 bg-gradient-to-br from-rose-500/25 to-rose-500/5 text-rose-50',
                unknown: 'border-white/20 bg-white/5 text-white/80',
              };
              const pillStyle = (lvl: 'good' | 'caution' | 'bad' | 'unknown') =>
                lvl === 'good' ? 'border-emerald-400/50 text-emerald-200 bg-emerald-500/10'
                : lvl === 'caution' ? 'border-amber-400/50 text-amber-200 bg-amber-500/10'
                : lvl === 'bad' ? 'border-rose-400/50 text-rose-200 bg-rose-500/10'
                : 'border-white/15 text-white/60 bg-white/5';
              void decision; // legacy verdict suppressed in favor of unified Final Decision
              const priceFromAmazon = selected.price != null && selected.price > 0;
              const overrideActive = inp.salePrice !== '' && parseFloat(inp.salePrice) > 0;
              const sourceLabel = overrideActive ? '(What-if)' : priceFromAmazon ? '(Amazon)' : '(Manual)';
              const ccy = selected.currency || 'USD';
              return (
                <div className="mt-3 rounded-2xl bg-white/[0.03] border border-white/10 p-4">
                  <div className="text-[11px] uppercase tracking-wide text-white/50 font-semibold mb-2">Profit & ROI</div>

                  <label className="block">
                    <span className="text-[10px] text-white/50">Cost per unit ($)</span>
                    <input type="number" inputMode="decimal" step="0.01" min="0" placeholder="0.00"
                      value={inp.totalCost}
                      onChange={(e) => updateCostInput(selected.id, { totalCost: e.target.value, units: '1' })}
                      className="mt-1 w-full h-10 px-3 rounded-lg bg-white/5 border border-white/15 text-base text-white placeholder:text-white/30 focus:outline-none focus:border-emerald-400/60" />
                  </label>

                  {feesLoading && <div className="mt-2 text-[10px] text-white/50 flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Fetching Amazon fees…</div>}
                  {feesError && <div className="mt-2 text-[10px] text-amber-300">Could not load Amazon fees — calculation excludes fees.</div>}

                  {(r != null) && (
                    <div className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="text-[10px] text-emerald-200/80 font-semibold uppercase tracking-wide">Sale Price {sourceLabel}</div>
                          <div className="mt-1 flex items-center gap-2">
                            <span className="text-emerald-300 font-bold">$</span>
                            <input
                              type="number" inputMode="decimal" step="0.01" min="0"
                              placeholder={priceFromAmazon ? String(selected.price?.toFixed(2)) : '0.00'}
                              value={inp.salePrice}
                              onChange={(e) => updateCostInput(selected.id, { salePrice: e.target.value })}
                              className="w-24 h-8 px-2 rounded-md bg-white/10 border border-emerald-400/40 text-base font-bold text-emerald-200 placeholder:text-emerald-200/40 focus:outline-none focus:border-emerald-300"
                            />
                            {overrideActive && (
                              <button type="button" onClick={() => updateCostInput(selected.id, { salePrice: '' })}
                                className="text-[10px] text-emerald-200/80 hover:text-emerald-100 underline">Reset</button>
                            )}
                          </div>
                          {r.feesReady && r.afterFees != null && (
                            <div className="text-[10px] text-emerald-200/80 mt-1">
                              After fees: <span className="font-semibold text-emerald-200">${r.afterFees.toFixed(2)}</span>
                              {r.maxCost30 != null && <span className="text-white/50"> · Max cost @30% ROI: <span className="text-white/80 font-medium">${r.maxCost30.toFixed(2)}</span></span>}
                            </div>
                          )}
                        </div>
                        <span className="text-[9px] border border-emerald-400/40 text-emerald-200 rounded px-1.5 py-0.5 shrink-0">{overrideActive ? 'What-if' : priceFromAmazon ? 'Live from Amazon' : 'Manually entered'}</span>
                      </div>
                    </div>
                  )}

                  {/* ───── Unified Final Decision (mirrors extension analyzer) ───── */}
                  <div className={`mt-3 rounded-xl border ${fdLevelStyle[fd.final.level]} px-3 py-3`}>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <div className="text-[9px] uppercase tracking-wider opacity-70 font-semibold">Final Decision</div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <span className="text-xl leading-none">{fd.final.emoji}</span>
                          <span className="text-base font-bold uppercase tracking-wide">{fd.final.action}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[9px] uppercase tracking-wider opacity-70 font-semibold">Confidence</div>
                        <div className="mt-1 text-base font-bold">{fd.confidence}</div>
                      </div>
                    </div>
                    <p className="mt-2 text-[11px] leading-relaxed opacity-95">{fd.explanation}</p>
                    <div className="mt-3 grid grid-cols-2 gap-1.5">
                      {[
                        { k: 'Profitability', p: fd.profit },
                        { k: 'Market Trend', p: fd.trend },
                        { k: 'Competition', p: fd.competition },
                        { k: 'Eligibility', p: fd.eligibility },
                        { k: 'Sales Velocity', p: fd.salesVelocity },
                      ].map(({ k, p }) => (
                        <div key={k} className={`flex items-center justify-between rounded-md border px-2 py-1 text-[10px] ${pillStyle(p.level)}`}>
                          <span className="opacity-80">{k}</span>
                          <span className="font-semibold">{p.text}</span>
                        </div>
                      ))}
                    </div>
                  </div>




                  {r && r.hasCost ? (
                    <>
                      <div className="mt-3 grid grid-cols-3 gap-2">
                        <div className="rounded-lg bg-white/5 border border-white/10 p-2"><div className="text-[10px] text-white/50">Unit Cost</div><div className="text-sm font-semibold text-white">${r.cog.toFixed(2)}</div></div>
                        <div className="rounded-lg bg-white/5 border border-white/10 p-2"><div className="text-[10px] text-white/50">Fees</div><div className="text-sm font-semibold text-white">{r.feesReady ? `$${r.totalFees.toFixed(2)}` : '—'}</div></div>
                        <div className={`rounded-lg border p-2 ${r.profit >= 0 ? 'bg-emerald-500/10 border-emerald-400/30' : 'bg-red-500/10 border-red-400/30'}`}><div className="text-[10px] text-white/50">Profit</div><div className={`text-sm font-semibold ${r.profit >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>${r.profit.toFixed(2)}</div></div>
                        <div className={`col-span-3 rounded-lg border p-2 flex items-center justify-between ${r.roi >= 0 ? 'bg-emerald-500/10 border-emerald-400/30' : 'bg-red-500/10 border-red-400/30'}`}>
                          <span className="text-[11px] text-white/60">ROI</span>
                          <span className={`text-base font-bold ${r.roi >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{r.roi.toFixed(2)}%</span>
                        </div>
                        {r.feesReady && r.breakeven != null && (
                          <div className="col-span-3 grid grid-cols-2 gap-2">
                            <div className="rounded-lg bg-white/5 border border-white/10 p-2 flex items-center justify-between"><span className="text-[10px] text-white/50">Breakeven cost</span><span className="text-xs font-semibold text-white">${r.breakeven.toFixed(2)}</span></div>
                            {r.maxCost30 != null && <div className="rounded-lg bg-white/5 border border-white/10 p-2 flex items-center justify-between"><span className="text-[10px] text-white/50">Max @30% ROI</span><span className="text-xs font-semibold text-white">${r.maxCost30.toFixed(2)}</span></div>}
                          </div>
                        )}
                      </div>
                      {r.feesReady && r.profit < 3 && r.profit >= 0 && (
                        <div className="mt-2 rounded-lg border border-amber-400/40 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-100">⚠️ Low margin — a small price drop can wipe out profit.</div>
                      )}
                    </>
                  ) : (
                    <div className="mt-2 text-[10px] text-white/40">
                      {r?.feesReady && r.maxCost30 != null
                        ? <>Enter cost to see profit. Aim below <span className="text-white/70 font-semibold">${r.maxCost30.toFixed(2)}</span> for 30%+ ROI.</>
                        : 'Enter cost per unit to see profit and ROI.'}
                    </div>
                  )}
                </div>
              );
            })()}
          </section>
        )}

        {/* History link */}
        <section className="mt-5">
          <button
            onClick={() => navigate("/m/history")}
            className="w-full flex items-center justify-center gap-2 h-11 rounded-xl bg-white/[0.04] border border-white/10 hover:border-white/30 text-sm text-white/80 font-medium transition"
          >
            <HistoryIcon className="h-4 w-4" />
            View Scan History
          </button>
        </section>
      </main>

      <style>{`
        @keyframes scan {
          0% { top: 0; }
          50% { top: 100%; }
          100% { top: 0; }
        }
      `}</style>
    </div>
  );
}
