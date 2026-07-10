import { useEffect, useState, useCallback, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft,
  Loader2,
  AlertTriangle,
  Package,
  Trash2,
  ShieldCheck,
  ShieldX,
  ShieldAlert,
  Plus,
  RefreshCw,
  ScanLine,
} from "lucide-react";
import { generateSKU } from "@/utils/skuGenerator";
import { toast } from "sonner";
import MobileScanMarketIntel from "@/components/scan/MobileScanMarketIntel";

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
  monthly_sold?: number | null;
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

type StabilityState = StabilityData | 'loading' | { status: 'error'; message: string } | null;

type Fees = { referralFee: number; fbaFee: number; variableClosingFee: number };
type FeesState = Fees | 'loading' | 'error' | null;

type DecisionSignal = {
  level: 'safe' | 'opportunity' | 'risky' | 'avoid' | 'unknown';
  label: string;
  emoji: string;
  reasons: string[];
};

const formatPrice = (price: number | null, currency: string | null) => {
  if (price == null) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(price);
  } catch {
    return `$${price.toFixed(2)}`;
  }
};

const formatTime = (iso: string) => {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  } catch { return iso; }
};

const computeDecisionSignal = (
  stab: StabilityData | null,
  profitCtx?: { profit: number | null; roi: number | null; hasCost: boolean } | null,
): DecisionSignal => {
  if (!stab || !stab.intel) {
    return { level: 'unknown', label: 'Gathering data…', emoji: '⏳', reasons: [] };
  }
  const intel = stab.intel;
  const reasons: string[] = [];
  let avoidHits = 0, riskyHits = 0, safeHits = 0;

  if (stab.verdict === 'stable') { safeHits++; reasons.push('Stable 90d price'); }
  else if (stab.verdict === 'volatile') { riskyHits++; reasons.push('Volatile price swings'); }

  const amzPresence = intel.amazon_presence_pct;
  if (amzPresence != null) {
    if (amzPresence >= 70) { avoidHits++; reasons.push(`Amazon sells ${amzPresence.toFixed(0)}% of time`); }
    else if (amzPresence >= 30) { riskyHits++; reasons.push(`Amazon sells ${amzPresence.toFixed(0)}% of time`); }
    else if (amzPresence < 5) { safeHits++; reasons.push('Amazon rarely sells'); }
  }

  const totalSellers = (intel.sellers_fba ?? 0) + (intel.sellers_fbm ?? 0);
  if (intel.sellers_fba != null) {
    if (totalSellers >= 15) { riskyHits++; reasons.push(`${totalSellers} active sellers`); }
    else if (totalSellers <= 3) { safeHits++; reasons.push(`Low competition (${totalSellers} sellers)`); }
  }

  const bsr = intel.bsr_current;
  if (bsr != null) {
    if (bsr <= 10000) { safeHits++; reasons.push(`Top BSR #${bsr.toLocaleString()}`); }
    else if (bsr > 500000) { riskyHits++; reasons.push(`Slow seller (BSR #${bsr.toLocaleString()})`); }
  }

  let level: DecisionSignal['level'];
  let label: string, emoji: string;
  if (avoidHits >= 1) { level = 'avoid'; label = 'Avoid'; emoji = '❌'; }
  else if (riskyHits >= 2) { level = 'risky'; label = 'Risky'; emoji = '⚠️'; }
  else if (safeHits >= 3 && riskyHits === 0) { level = 'opportunity'; label = 'Opportunity'; emoji = '🔥'; }
  else if (safeHits >= 2 && riskyHits <= 1) { level = 'safe'; label = 'Safe Buy'; emoji = '✅'; }
  else if (riskyHits >= 1) { level = 'risky'; label = 'Risky'; emoji = '⚠️'; }
  else { level = 'unknown'; label = 'Mixed signals'; emoji = '🤔'; }

  if (profitCtx?.hasCost && profitCtx.profit != null) {
    const p = profitCtx.profit;
    const r = profitCtx.roi ?? 0;
    if (p < 1) { level = 'avoid'; label = 'Avoid'; emoji = '❌'; reasons.unshift(`Profit too low ($${p.toFixed(2)})`); }
    else if (p < 2) { level = 'risky'; label = 'Risky'; emoji = '⚠️'; reasons.unshift(`Low profit ($${p.toFixed(2)})`); }
    else if (p < 3 || r < 25) {
      if (level === 'safe' || level === 'opportunity') { level = 'risky'; label = 'Risky'; emoji = '⚠️'; }
      reasons.unshift(`Thin margin ($${p.toFixed(2)} · ${r.toFixed(0)}% ROI)`);
    }
  }
  return { level, label, emoji, reasons: reasons.slice(0, 4) };
};

export default function MobileScanDetail() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { user, loading: authLoading } = useAuth();

  const [scan, setScan] = useState<ScanRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const [eligibility, setEligibility] = useState<EligibilityStatus | null>(null);
  const [fees, setFees] = useState<FeesState>(null);
  const [stability, setStability] = useState<StabilityState>(null);
  const [historyMonthlySales, setHistoryMonthlySales] = useState<number | null>(null);
  const [stabilityExpanded, setStabilityExpanded] = useState(false);
  const [priceFetchState, setPriceFetchState] = useState<'idle' | 'loading' | 'error' | 'done'>('idle');

  const [costInput, setCostInput] = useState({ totalCost: '', units: '1', salePrice: '' });
  const [createForm, setCreateForm] = useState<{ sku: string; quantity: string; fulfillment: 'FBA' | 'FBM' }>({
    sku: '', quantity: '1', fulfillment: 'FBA',
  });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) navigate("/login", { replace: true });
  }, [authLoading, user, navigate]);

  useEffect(() => {
    if (!user || !id) return;
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from("mobile_scan_history")
          .select("*")
          .eq("id", id)
          .eq("user_id", user.id)
          .maybeSingle();
        if (!alive) return;
        if (error) throw error;
        if (!data) { setNotFound(true); return; }
        setScan(data as ScanRow);
        // Hydrate previously-saved cost inputs
        const d: any = data;
        setCostInput({
          totalCost: d.total_cost != null ? String(d.total_cost) : '',
          units: d.units != null ? String(d.units) : '1',
          salePrice: d.sale_price_override != null ? String(d.sale_price_override) : '',
        });
        if (!createForm.sku) setCreateForm(p => ({ ...p, sku: generateSKU() }));
      } catch (e: any) {
        console.error("[mobile-scan-detail] load failed", e);
        toast.error("Could not load scan");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [user, id]);

  // Persist cost inputs (debounced) so they're saved forever per scan AND in a
  // user-level cost memory keyed by barcode/ASIN so re-scans always restore them.
  useEffect(() => {
    if (!scan?.id || loading) return;
    const t = setTimeout(async () => {
      const totalCostNum = costInput.totalCost === '' ? null : parseFloat(costInput.totalCost);
      const unitsNum = costInput.units === '' ? null : Math.max(1, parseInt(costInput.units) || 1);
      const saleNum = costInput.salePrice === '' ? null : parseFloat(costInput.salePrice);
      const safeCost = totalCostNum != null && isFinite(totalCostNum) ? totalCostNum : null;
      const safeSale = saleNum != null && isFinite(saleNum) ? saleNum : null;

      // 1) Per-scan row
      supabase
        .from("mobile_scan_history")
        .update({ total_cost: safeCost, units: unitsNum, sale_price_override: safeSale })
        .eq("id", scan.id)
        .then(({ error }) => {
          if (error) console.error("[mobile-scan-detail] persist cost failed", error);
        });

      // 2) Persistent per-user cost memory (so re-scans always restore the cost)
      if (!user?.id) return;
      const barcode = scan.barcode || null;
      const asin = scan.asin || null;
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

        const payload = {
          user_id: user.id,
          barcode,
          asin,
          total_cost: safeCost,
          units: unitsNum,
          sale_price_override: safeSale,
        };
        if (existing?.id) {
          await supabase.from("mobile_scan_cost_memory").update(payload).eq("id", existing.id);
        } else {
          await supabase.from("mobile_scan_cost_memory").insert(payload);
        }
      } catch (memErr) {
        console.warn("[mobile-scan-detail] cost memory persist failed", memErr);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [costInput.totalCost, costInput.units, costInput.salePrice, scan?.id, scan?.barcode, scan?.asin, user?.id, loading]);


  useEffect(() => {
    if (!scan?.asin) return;
    const asin = scan.asin.toUpperCase();
    setHistoryMonthlySales(null);

    (async () => {
      setEligibility('checking');
      try {
        const { data, error } = await supabase.functions.invoke('check-product-eligibility', {
          body: { marketplace: 'US', asins: [asin], force_rescan: false },
        });
        if (error) { setEligibility('error'); return; }
        const r = data?.results?.[0];
        if (!r) { setEligibility('error'); return; }
        setEligibility(
          r.status === 'approved' ? 'approved'
          : r.status === 'approval_required' ? 'approval_required'
          : r.status === 'restricted' ? 'restricted'
          : 'error'
        );
      } catch { setEligibility('error'); }
    })();

    (async () => {
      setFees('loading');
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Not authenticated");
        const { data, error } = await supabase.functions.invoke('personalhour-product-data', {
          body: { asin },
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (error) throw error;
        const f = data?.fees;
        if (f) {
          setFees({
            referralFee: Number(f.referralFee) || 0,
            fbaFee: Number(f.fbaFee) || 0,
            variableClosingFee: Number(f.variableClosingFee) || 0,
          });
        } else {
          setFees('error');
        }
      } catch { setFees('error'); }
    })();

    fetchStability(asin, false);

    if (scan.price == null || scan.price <= 0) {
      refetchPrice();
    }
  }, [scan?.asin]);

  const fetchStability = useCallback(async (asin: string, force: boolean) => {
    setStability('loading');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const { data, error } = await supabase.functions.invoke('mobile-scan-price-stability', {
        body: { asin, marketplace: 'US', force },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) throw error;
      if (!data || data.error) throw new Error(data?.error || 'Stability fetch failed');
      setStability(data as StabilityData);
    } catch (e: any) {
      setStability({ status: 'error', message: e?.message || 'Stability fetch failed' });
    }
  }, []);

  const refetchPrice = useCallback(async () => {
    if (!scan?.asin) return;
    setPriceFetchState('loading');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const { data, error } = await supabase.functions.invoke('personalhour-product-data', {
        body: { asin: scan.asin.toUpperCase() },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (error) throw error;
      const p = data?.price != null ? Number(data.price) : null;
      const c = data?.currency || "USD";
      if (p != null && isFinite(p) && p > 0) {
        setScan(prev => prev ? { ...prev, price: p, currency: c } : prev);
        supabase.from("mobile_scan_history").update({ price: p, currency: c }).eq("id", scan.id).then();
        setPriceFetchState('done');
      } else {
        setPriceFetchState('error');
      }
    } catch {
      setPriceFetchState('error');
    }
  }, [scan?.asin, scan?.id]);

  const getEffectivePrice = (): number | null => {
    // Manual override always wins so the user can recompute ROI at any what-if price.
    const m = parseFloat(costInput.salePrice || '');
    if (isFinite(m) && m > 0) return m;
    if (scan?.price != null && scan.price > 0) return scan.price;
    return null;
  };

  const result = useMemo(() => {
    if (!scan?.asin) return null;
    const totalCostNum = parseFloat(costInput.totalCost);
    const unitsNum = Math.max(1, parseInt(costInput.units) || 1);
    const priceNum = getEffectivePrice();
    const totalFees = fees && typeof fees === 'object' ? fees.referralFee + fees.fbaFee + fees.variableClosingFee : 0;
    const feesReady = typeof fees === 'object' && fees !== null;
    const afterFees = priceNum != null ? priceNum - totalFees : null;
    const maxCost30 = afterFees != null && afterFees > 0 ? afterFees / 1.30 : null;
    const breakeven = afterFees;
    if (!isFinite(totalCostNum) || totalCostNum <= 0 || priceNum == null) {
      return { cog: 0, totalFees, profit: 0, roi: 0, feesReady, afterFees, breakeven, maxCost30, hasCost: false };
    }
    const cog = totalCostNum / unitsNum;
    const profit = priceNum - totalFees - cog;
    const roi = cog > 0 ? (profit / cog) * 100 : 0;
    return { cog, totalFees, profit, roi, feesReady, afterFees, breakeven, maxCost30, hasCost: true };
  }, [scan, costInput, fees]);

  const stab = stability && typeof stability === 'object' && !('status' in stability) ? stability as StabilityData : null;
  const decision = computeDecisionSignal(stab, result ? { profit: result.profit, roi: result.roi, hasCost: !!result.hasCost } : null);

  const decisionStyle: Record<DecisionSignal['level'], string> = {
    safe: 'border-emerald-400/60 text-emerald-100 bg-emerald-500/15',
    opportunity: 'border-orange-400/60 text-orange-100 bg-orange-500/15',
    risky: 'border-amber-400/60 text-amber-100 bg-amber-500/15',
    avoid: 'border-rose-500/70 text-rose-100 bg-rose-500/20',
    unknown: 'border-white/20 text-white/70 bg-white/5',
  };

  const renderEligibilityBadge = () => {
    if (!scan?.asin || !eligibility) return null;
    const base = "inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-md border";
    const icon = "h-3.5 w-3.5";
    switch (eligibility) {
      case 'checking': return <span className={`${base} bg-white/5 border-white/15 text-white/70 animate-pulse`}><Loader2 className={`${icon} animate-spin`} /> Checking</span>;
      case 'approved': return <span className={`${base} bg-emerald-500/15 border-emerald-400/40 text-emerald-300`}><ShieldCheck className={icon} /> Approved</span>;
      case 'restricted': return <span className={`${base} bg-red-500/15 border-red-400/40 text-red-300`}><ShieldX className={icon} /> Restricted</span>;
      case 'approval_required': return <span className={`${base} bg-amber-500/15 border-amber-400/40 text-amber-300`}><ShieldAlert className={icon} /> Needs Approval</span>;
      case 'error': return <span className={`${base} bg-white/5 border-white/15 text-white/50`}>Eligibility N/A</span>;
    }
  };

  const createListing = async () => {
    if (!user || !scan?.asin) return;
    const totalCostNum = parseFloat(costInput.totalCost);
    const unitsNum = Math.max(1, parseInt(costInput.units) || 1);
    const qtyNum = Math.max(1, parseInt(createForm.quantity) || 1);
    const priceNum = getEffectivePrice();
    if (!createForm.sku) { toast.error("SKU is required"); return; }
    if (!isFinite(totalCostNum) || totalCostNum <= 0) { toast.error("Enter a valid Cost first"); return; }
    if (priceNum == null || priceNum <= 0) { toast.error("No selling price available"); return; }

    setCreating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const cogNum = totalCostNum / unitsNum;
      const today = new Date().toISOString().split('T')[0];
      const { data: fnskuData } = await supabase.from("fnsku_map").select("fnsku").eq("asin", scan.asin.toUpperCase()).maybeSingle();
      const { error: invErr } = await supabase.from("created_listings").insert([{
        user_id: user.id,
        asin: scan.asin.toUpperCase(),
        sku: createForm.sku,
        fnsku: fnskuData?.fnsku || null,
        title: scan.title,
        image_url: scan.image_url,
        price: priceNum,
        cost: totalCostNum,
        amount: cogNum,
        units: unitsNum,
        supplier_links: [] as any,
        date_created: today,
      }]);
      if (invErr) throw invErr;
      const { MARKETPLACE_CONFIGS } = await import("@/lib/marketplaceCurrency");
      const mpConfig = (MARKETPLACE_CONFIGS as any)?.US;
      const { data: listingData, error: listingError } = await supabase.functions.invoke('create-amazon-listing', {
        body: {
          asin: scan.asin.toUpperCase(),
          sku: createForm.sku,
          price: priceNum,
          quantity: qtyNum,
          condition: 'new_new',
          fulfillmentChannel: createForm.fulfillment,
          cost: totalCostNum,
          marketplaceId: mpConfig?.marketplaceId,
          marketplaceCode: 'US',
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (listingError) throw listingError;
      const issues = (listingData as any)?.issues;
      if (Array.isArray(issues) && issues.some((i: any) => i?.severity === 'ERROR')) {
        toast.warning(`Saved to DB. Amazon returned ${issues.length} issue(s).`);
      } else {
        toast.success(`Listing created on Amazon (${createForm.fulfillment}) for ${scan.asin}`);
      }
      setCreated(true);
    } catch (e: any) {
      console.error("[mobile-scan-detail] create failed", e);
      toast.error(e?.message || "Failed to create listing");
    } finally {
      setCreating(false);
    }
  };

  const deleteScan = async () => {
    if (!scan) return;
    try {
      await supabase.from("mobile_scan_history").delete().eq("id", scan.id);
      toast.success("Scan deleted");
      navigate("/m/history");
    } catch { toast.error("Delete failed"); }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[hsl(230,40%,8%)] text-white p-4">
        <Skeleton className="h-12 w-full mb-3 bg-white/5" />
        <Skeleton className="h-40 w-full mb-3 bg-white/5" />
        <Skeleton className="h-64 w-full bg-white/5" />
      </div>
    );
  }
  if (notFound || !scan) {
    return (
      <div className="min-h-screen bg-[hsl(230,40%,8%)] text-white p-4">
        <button onClick={() => navigate("/m/scan")} className="inline-flex items-center gap-2 text-sm text-white/70 mb-4">
          <ArrowLeft className="h-4 w-4" /> Back to scanner
        </button>
        <div className="text-center py-12 text-white/50">
          <Package className="h-10 w-10 mx-auto mb-2 opacity-50" />
          Scan not found.
        </div>
      </div>
    );
  }

  const noAmazonPrice = scan.price == null || scan.price <= 0;
  const isFetchingPrice = noAmazonPrice && priceFetchState === 'loading';
  const fetchFailed = noAmazonPrice && priceFetchState === 'error';
  const effPrice = getEffectivePrice();
  const priceFromAmazon = scan.price != null && scan.price > 0;
  const currency = scan.currency || 'USD';
  const intel = stab?.intel || null;
  const isError = stability && typeof stability === 'object' && 'status' in stability;

  let stabBadgeText = 'Checking 90-day price…';
  let stabBadgeColor = 'border-white/20 text-white/60 bg-white/5';
  if (stability === 'loading' || !stability) { stabBadgeText = 'Checking 90-day price…'; }
  else if (isError) { stabBadgeText = `90-day price: ${(stability as any).message}`; stabBadgeColor = 'border-amber-400/40 text-amber-200 bg-amber-500/10'; }
  else if (stab) {
    if (stab.verdict === 'stable') { stabBadgeText = `Stable 90d · ±${stab.swing_pct?.toFixed(1) ?? '0'}%`; stabBadgeColor = 'border-emerald-400/50 text-emerald-200 bg-emerald-500/10'; }
    else if (stab.verdict === 'moderate') { stabBadgeText = `Moderate 90d · ±${stab.swing_pct?.toFixed(1) ?? '0'}%`; stabBadgeColor = 'border-yellow-400/50 text-yellow-200 bg-yellow-500/10'; }
    else if (stab.verdict === 'volatile') { stabBadgeText = `Volatile 90d · ±${stab.swing_pct?.toFixed(1) ?? '0'}%`; stabBadgeColor = 'border-rose-400/50 text-rose-200 bg-rose-500/10'; }
    else { stabBadgeText = stab.reason || 'Not enough 90d history'; }
  }

  const blocked = eligibility === 'restricted' || eligibility === 'approval_required';
  const hasCost = parseFloat(costInput.totalCost) > 0;
  const hasPrice = effPrice != null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-[hsl(222,84%,4.9%)] via-[hsl(230,50%,10%)] to-[hsl(260,50%,8%)] text-white">
      <Helmet>
        <title>Scan Detail | ArbiProSeller Mobile</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
      </Helmet>

      <header className="sticky top-0 z-20 backdrop-blur-md bg-black/40 border-b border-white/10">
        <div className="flex items-center gap-2 px-4 py-3">
          <button onClick={() => navigate(-1)} className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-white/5 border border-white/10 shrink-0" aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold leading-none truncate">{scan.title || '(no Amazon match)'}</h1>
            <p className="text-[11px] text-white/50 mt-0.5 font-mono">{scan.asin || scan.barcode}</p>
          </div>
          <button
            onClick={() => navigate('/m/scan')}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-emerald-500/15 border border-emerald-400/40 text-emerald-200 text-[11px] font-semibold shrink-0 hover:bg-emerald-500/25 transition-colors"
            aria-label="Scan again"
          >
            <ScanLine className="h-4 w-4" />
            Scan
          </button>
        </div>
      </header>

      <main className="px-4 pt-4 pb-24 max-w-md mx-auto">
        <div className="rounded-2xl bg-white/[0.03] border border-white/10 p-4">
          <div className="flex items-start gap-3">
            <div className="h-20 w-20 rounded-lg bg-white/10 overflow-hidden flex items-center justify-center">
              {scan.image_url ? <img src={scan.image_url} alt={scan.title || ""} className="w-full h-full object-cover" /> : <Package className="h-7 w-7 text-white/40" />}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold text-white leading-tight">{scan.title || "(no Amazon match)"}</h3>
              {scan.brand && <p className="text-xs text-white/50 mt-1">{scan.brand}</p>}
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <div className="text-lg font-bold text-emerald-300">{formatPrice(scan.price, scan.currency)}</div>
                {renderEligibilityBadge()}
              </div>
            </div>
          </div>

          <dl className="mt-3 space-y-2 text-xs border-t border-white/10 pt-3">
            <div className="flex justify-between"><dt className="text-white/50">Barcode</dt><dd className="font-mono text-white">{scan.barcode}</dd></div>
            {scan.barcode_format && <div className="flex justify-between"><dt className="text-white/50">Format</dt><dd className="text-white">{scan.barcode_format}</dd></div>}
            {scan.asin && <div className="flex justify-between"><dt className="text-white/50">ASIN</dt><dd className="font-mono text-emerald-300">{scan.asin}</dd></div>}
            <div className="flex justify-between"><dt className="text-white/50">Scanned</dt><dd className="text-white">{formatTime(scan.created_at)}</dd></div>
          </dl>
        </div>

        {scan.asin && (
          <div className="mt-4 rounded-2xl bg-white/[0.03] border border-white/10 p-4">
            <div className="text-[11px] uppercase tracking-wide text-white/50 font-semibold mb-2">Profit & ROI</div>

            {isFetchingPrice && (
              <div className="mb-2 flex items-center gap-2 text-[11px] text-white/60 p-2 rounded-lg bg-white/5 border border-white/10">
                <Loader2 className="h-3 w-3 animate-spin" /> Fetching Amazon price…
              </div>
            )}
            {noAmazonPrice && !isFetchingPrice && (
              <div className="mb-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-white/50">{fetchFailed ? 'Sale Price ($) — Amazon price unavailable' : 'Sale Price ($)'}</span>
                  <button type="button" onClick={() => { setPriceFetchState('idle'); refetchPrice(); }} className="text-[10px] text-emerald-300 hover:text-emerald-200 inline-flex items-center gap-1">
                    <RefreshCw className="h-3 w-3" /> Retry Amazon
                  </button>
                </div>
                <input type="number" inputMode="decimal" step="0.01" min="0" placeholder="0.00"
                  value={costInput.salePrice}
                  onChange={(e) => setCostInput(p => ({ ...p, salePrice: e.target.value }))}
                  className="w-full h-9 px-2 rounded-lg bg-white/5 border border-amber-400/40 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-emerald-400/60" />
              </div>
            )}

            <label className="block">
              <span className="text-[10px] text-white/50">Cost per unit ($)</span>
              <input type="number" inputMode="decimal" step="0.01" min="0" placeholder="0.00"
                value={costInput.totalCost}
                onChange={(e) => setCostInput(p => ({ ...p, totalCost: e.target.value, units: '1' }))}
                className="mt-1 w-full h-10 px-3 rounded-lg bg-white/5 border border-white/15 text-base text-white placeholder:text-white/30 focus:outline-none focus:border-emerald-400/60" />
            </label>

            {fees === 'loading' && <div className="mt-2 text-[10px] text-white/50 flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Fetching Amazon fees…</div>}
            {fees === 'error' && <div className="mt-2 text-[10px] text-amber-300">Could not load Amazon fees — calculation excludes fees.</div>}

            {(effPrice != null || priceFromAmazon) && (() => {
              const overrideActive = costInput.salePrice !== '' && parseFloat(costInput.salePrice) > 0;
              const sourceLabel = overrideActive ? '(What-if)' : priceFromAmazon ? '(Amazon)' : '(Manual)';
              const badgeLabel = overrideActive ? 'What-if price' : priceFromAmazon ? 'Live from Amazon' : 'Manually entered';
              return (
                <div className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] text-emerald-200/80 font-semibold uppercase tracking-wide">Sale Price {sourceLabel}</div>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="text-emerald-300 font-bold">$</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          min="0"
                          placeholder={priceFromAmazon ? String(scan.price?.toFixed(2)) : '0.00'}
                          value={costInput.salePrice}
                          onChange={(e) => setCostInput(p => ({ ...p, salePrice: e.target.value }))}
                          className="w-24 h-8 px-2 rounded-md bg-white/10 border border-emerald-400/40 text-base font-bold text-emerald-200 placeholder:text-emerald-200/40 focus:outline-none focus:border-emerald-300"
                          aria-label="Sale price override"
                        />
                        {overrideActive && (
                          <button
                            type="button"
                            onClick={() => setCostInput(p => ({ ...p, salePrice: '' }))}
                            className="text-[10px] text-emerald-200/80 hover:text-emerald-100 underline"
                          >
                            Reset
                          </button>
                        )}
                      </div>
                      {result?.feesReady && result.afterFees != null && (
                        <div className="text-[10px] text-emerald-200/80 mt-1">
                          After fees: <span className="font-semibold text-emerald-200">${result.afterFees.toFixed(2)}</span>
                          {result.maxCost30 != null && <span className="text-white/50"> · Max cost @30% ROI: <span className="text-white/80 font-medium">${result.maxCost30.toFixed(2)}</span></span>}
                        </div>
                      )}
                    </div>
                    <Badge variant="outline" className="text-[9px] border-emerald-400/40 text-emerald-200 shrink-0">{badgeLabel}</Badge>
                  </div>
                </div>
              );
            })()}

            {(() => {
              // Keepa "drops" under-counts multi-unit orders (1 drop ≠ 1 unit), so for
              // fast movers it diverges sharply from tools like SellerAmp. We take the
              // MAX of all signals so the figure better reflects true sell-through.
              const salesFromDrops = stab?.drops_90 != null && stab.drops_90 > 0
                ? Math.max(1, Math.round(stab.drops_90 / 3))
                : null;
              const bsr = intel?.bsr_current ?? intel?.bsr_avg_90 ?? null;
              const bsrCurve = bsr && bsr > 0
                ? Math.max(1, Math.round(100000 * Math.pow(bsr, -0.78)))
                : null;
              const keepaMonthlySold = intel?.monthly_sold ?? null;
              const candidates = [
                keepaMonthlySold,
                intel?.est_monthly_sales,
                salesFromDrops,
                historyMonthlySales,
                bsrCurve,
              ].filter((v): v is number => v != null && v > 0);
              const display = candidates.length ? Math.max(...candidates) : null;
              const isEstimate = intel?.est_monthly_sales == null && display != null;
              const isLoading = stability === 'loading';

              if (display == null && !isLoading) return null;

              return (
                <div className="mt-3 flex items-baseline justify-center gap-2 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-4 py-3">
                  {display != null ? (
                    <>
                      <span className="text-4xl font-extrabold leading-none tracking-tight text-emerald-300">
                        ~{display}
                      </span>
                      <span className="text-base font-semibold uppercase tracking-wider text-emerald-200/90">
                        /mo sales{isEstimate ? ' (est)' : ''}
                      </span>
                    </>
                  ) : (
                    <span className="text-sm font-medium text-emerald-200/70">Loading sales estimate…</span>
                  )}
                </div>
              );
            })()}

            {stab && (
              <div className={`mt-3 rounded-lg border ${decisionStyle[decision.level]} px-3 py-2`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-lg leading-none">{decision.emoji}</span>
                    <span className="text-sm font-bold uppercase tracking-wide">{decision.label}</span>
                  </div>
                </div>
                {decision.reasons.length > 0 && (
                  <ul className="mt-1 text-[10px] opacity-90 space-y-0.5">
                    {decision.reasons.map((r, i) => <li key={i}>• {r}</li>)}
                  </ul>
                )}
              </div>
            )}

            {/* Keepa refresh + range-aware stability badge moved under the graph (MobileScanMarketIntel). */}

            {intel && (
              <details className="mt-2 rounded-lg border border-white/10 bg-white/[0.03]">
                <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-white/80 flex items-center justify-between">
                  <span>📊 Product Intel</span>
                  <span className="text-[10px] text-white/50">tap to expand</span>
                </summary>
                <div className="px-3 pb-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[10px]">
                  {intel.bsr_current != null && (
                    <div className="flex justify-between col-span-2"><span className="text-white/50">BSR</span>
                      <span className="text-white font-medium">#{intel.bsr_current.toLocaleString()}{intel.bsr_avg_90 != null && intel.bsr_avg_90 !== intel.bsr_current && <span className="text-white/40 ml-1">(90d avg #{intel.bsr_avg_90.toLocaleString()})</span>}</span>
                    </div>
                  )}
                  {(intel.sellers_fba != null || intel.sellers_fbm != null) && (
                    <div className="flex justify-between col-span-2"><span className="text-white/50">Sellers</span><span className="text-white font-medium">{intel.sellers_fba ?? 0} FBA · {intel.sellers_fbm ?? 0} FBM</span></div>
                  )}
                  {intel.amazon_presence_pct != null && (
                    <div className="flex justify-between col-span-2"><span className="text-white/50">Amazon presence</span>
                      <span className={`font-medium ${intel.amazon_presence_pct >= 50 ? 'text-rose-300' : intel.amazon_presence_pct >= 20 ? 'text-amber-300' : 'text-emerald-300'}`}>{intel.amazon_presence_pct.toFixed(0)}% of last 90d</span>
                    </div>
                  )}
                  {intel.amazon_buybox_pct != null && <div className="flex justify-between col-span-2"><span className="text-white/50">Amazon Buy Box</span><span className="text-white font-medium">{intel.amazon_buybox_pct.toFixed(0)}% wins</span></div>}
                  {intel.fba_fee_estimate != null && <div className="flex justify-between col-span-2"><span className="text-white/50">FBA pick & pack</span><span className="text-white font-medium">${intel.fba_fee_estimate.toFixed(2)} (Keepa est.)</span></div>}
                  {intel.brand && <div className="flex justify-between col-span-2"><span className="text-white/50">Brand</span><span className="text-white font-medium truncate ml-2">{intel.brand}</span></div>}
                  {intel.variation_count != null && intel.variation_count > 0 && <div className="flex justify-between col-span-2"><span className="text-white/50">Variations</span><span className="text-white font-medium">{intel.variation_count}</span></div>}
                  {intel.product_age_days != null && (
                    <div className="flex justify-between col-span-2"><span className="text-white/50">Listed since</span>
                      <span className="text-white font-medium">{intel.product_age_days >= 365 ? `${(intel.product_age_days / 365).toFixed(1)} years` : `${intel.product_age_days} days`}</span>
                    </div>
                  )}
                  {intel.category_tree && <div className="col-span-2 mt-1 pt-1 border-t border-white/10"><span className="text-white/40 text-[9px]">{intel.category_tree}</span></div>}
                </div>
              </details>
            )}

            {result && result.hasCost ? (
              <>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <div className="rounded-lg bg-white/5 border border-white/10 p-2"><div className="text-[10px] text-white/50">Unit Cost</div><div className="text-sm font-semibold text-white">${result.cog.toFixed(2)}</div></div>
                  <div className="rounded-lg bg-white/5 border border-white/10 p-2"><div className="text-[10px] text-white/50">Fees</div><div className="text-sm font-semibold text-white">{result.feesReady ? `$${result.totalFees.toFixed(2)}` : '—'}</div></div>
                  <div className={`rounded-lg border p-2 ${result.profit >= 0 ? 'bg-emerald-500/10 border-emerald-400/30' : 'bg-red-500/10 border-red-400/30'}`}><div className="text-[10px] text-white/50">Profit</div><div className={`text-sm font-semibold ${result.profit >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>${result.profit.toFixed(2)}</div></div>
                  <div className={`col-span-3 rounded-lg border p-2 flex items-center justify-between ${result.roi >= 0 ? 'bg-emerald-500/10 border-emerald-400/30' : 'bg-red-500/10 border-red-400/30'}`}>
                    <span className="text-[11px] text-white/60">ROI</span>
                    <span className={`text-base font-bold ${result.roi >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{result.roi.toFixed(2)}%</span>
                  </div>
                  {result.feesReady && result.breakeven != null && (
                    <div className="col-span-3 grid grid-cols-2 gap-2">
                      <div className="rounded-lg bg-white/5 border border-white/10 p-2 flex items-center justify-between"><span className="text-[10px] text-white/50">Breakeven cost</span><span className="text-xs font-semibold text-white">${result.breakeven.toFixed(2)}</span></div>
                      {result.maxCost30 != null && <div className="rounded-lg bg-white/5 border border-white/10 p-2 flex items-center justify-between"><span className="text-[10px] text-white/50">Max @30% ROI</span><span className="text-xs font-semibold text-white">${result.maxCost30.toFixed(2)}</span></div>}
                    </div>
                  )}
                </div>
                {result.feesReady && result.profit < 3 && result.profit >= 0 && (
                  <div className="mt-2 rounded-lg border border-amber-400/40 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-100">⚠️ Low margin — a small price drop can wipe out profit.</div>
                )}
              </>
            ) : (
              <div className="mt-2 text-[10px] text-white/40">
                {result?.feesReady && result.maxCost30 != null
                  ? <>Enter cost to see profit. Aim below <span className="text-white/70 font-semibold">${result.maxCost30.toFixed(2)}</span> for 30%+ ROI.</>
                  : 'Enter cost per unit to see profit and ROI.'}
              </div>
            )}
          </div>
        )}

        {scan.asin && (
          <MobileScanMarketIntel
            asin={scan.asin.toUpperCase()}
            marketplace="US"
            currency={currency}
            unitFees={result?.feesReady ? result.totalFees : 0}
            unitCost={result?.hasCost ? result.cog : 0}
            onMonthlySalesEstimate={setHistoryMonthlySales}
            onRefreshKeepa={() => scan.asin && fetchStability(scan.asin, true)}
            refreshingKeepa={stability === 'loading'}
          />
        )}

        {scan.asin && (
          <div className="mt-4 rounded-2xl bg-white/[0.03] border border-white/10 p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[11px] uppercase tracking-wide text-white/50 font-semibold">Create Listing</div>
              {created && <span className="text-[10px] text-emerald-300">✓ Created</span>}
            </div>

            <div className="grid grid-cols-2 gap-2 mb-2">
              {(['FBA', 'FBM'] as const).map((mode) => (
                <button key={mode} type="button"
                  onClick={() => setCreateForm(p => ({ ...p, fulfillment: mode }))}
                  className={`h-9 rounded-lg border text-sm font-medium transition ${createForm.fulfillment === mode ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-200' : 'bg-white/5 border-white/15 text-white/70 hover:border-white/30'}`}>{mode}</button>
              ))}
            </div>

            <div className="grid grid-cols-[1fr_auto_80px] gap-2 items-end">
              <label className="block">
                <span className="text-[10px] text-white/50">SKU</span>
                <input type="text" value={createForm.sku} onChange={(e) => setCreateForm(p => ({ ...p, sku: e.target.value }))}
                  placeholder="auto-generated"
                  className="mt-1 w-full h-9 px-2 rounded-lg bg-white/5 border border-white/15 text-sm text-white placeholder:text-white/30 font-mono focus:outline-none focus:border-emerald-400/60" />
              </label>
              <button type="button" onClick={() => setCreateForm(p => ({ ...p, sku: generateSKU() }))}
                className="h-9 w-9 inline-flex items-center justify-center rounded-lg bg-white/5 border border-white/15 text-white/70 hover:text-white" aria-label="Generate SKU">
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <label className="block">
                <span className="text-[10px] text-white/50">Qty</span>
                <input type="number" inputMode="numeric" min="1" step="1" value={createForm.quantity}
                  onChange={(e) => setCreateForm(p => ({ ...p, quantity: e.target.value }))}
                  className="mt-1 w-full h-9 px-2 rounded-lg bg-white/5 border border-white/15 text-sm text-white focus:outline-none focus:border-emerald-400/60" />
              </label>
            </div>

            {blocked && (
              <div className="mt-2 text-[10px] text-amber-300 flex items-start gap-1">
                <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                You are not approved to sell this ASIN. Request approval on Amazon first.
              </div>
            )}

            <Button onClick={createListing} disabled={creating || created || blocked || !hasCost || !hasPrice || !createForm.sku}
              className="mt-3 w-full bg-emerald-500 hover:bg-emerald-600 text-white">
              {creating ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating…</> : created ? <>Listing Created</> : <><Plus className="h-4 w-4 mr-2" /> Create {createForm.fulfillment} Listing</>}
            </Button>
            {(!hasCost || !hasPrice) && !created && (
              <div className="mt-1 text-[10px] text-white/40 text-center">
                {!hasPrice ? 'Enter Sale Price in Profit & ROI section above.' : 'Enter Cost above to enable.'}
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex gap-2">
          {scan.asin && (
            <a href={`https://www.amazon.com/dp/${scan.asin}`} target="_blank" rel="noopener noreferrer"
              className="flex-1 inline-flex items-center justify-center h-10 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium">
              View on Amazon
            </a>
          )}
          <Button variant="outline" className="border-red-500/40 text-red-300 hover:bg-red-500/10" onClick={deleteScan}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </main>
    </div>
  );
}
