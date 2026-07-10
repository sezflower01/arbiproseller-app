import { useEffect, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { RefreshCw, Search, Loader2 } from "lucide-react";
import { useAnalyzerSnapshot } from "@/hooks/use-analyzer-snapshot";
import { supabase } from "@/integrations/supabase/client";
import ProductHeader from "@/components/analyzer/ProductHeader";
import QuickInfoCards from "@/components/analyzer/QuickInfoCards";
import AlertsPanel from "@/components/analyzer/AlertsPanel";
import OffersTable from "@/components/analyzer/OffersTable";
import AnalyzerCharts from "@/components/analyzer/AnalyzerCharts";
import RanksPricesPanel from "@/components/analyzer/RanksPricesPanel";
import ProfitCalculator, { computeCalc } from "@/components/analyzer/ProfitCalculator";
import { useLiveRoi } from "@/pages/tools/supplier-discovery/useLiveRoi";
import NotesAndTags from "@/components/analyzer/NotesAndTags";
import FbaCompliancePanel from "@/components/analyzer/FbaCompliancePanel";
import DecisionMemoryPanel from "@/components/analyzer/DecisionMemoryPanel";
import { computeFinalDecision, complianceFromStageStatuses } from "@/lib/finalDecision";
import { useFbaEligibility } from "@/hooks/use-fba-eligibility";
import { getMarketplaceConfig } from "@/lib/marketplaceCurrency";
import { toast } from "sonner";



export default function ProductAnalyzer() {
  const [params, setParams] = useSearchParams();
  const initialAsin = (params.get("asin") || "").toUpperCase();
  const initialMarket = (params.get("marketplace") || "US").toUpperCase();

  const [asinInput, setAsinInput] = useState(initialAsin);
  const [marketplace, setMarketplace] = useState(initialMarket);
  const [costPrice, setCostPrice] = useState(0);
  const [salePrice, setSalePrice] = useState(0);
  const [feeRate, setFeeRate] = useState(0.30);
  const [fxRate, setFxRate] = useState(1); // USD → marketplace currency

  const mktConfig = getMarketplaceConfig(marketplace);
  const currency = mktConfig.currency;
  const currencySymbol = mktConfig.currencySymbol;

  // Load FX rate when marketplace is non-USD (same logic as extension panel)
  useEffect(() => {
    let cancelled = false;
    if (currency === "USD") { setFxRate(1); return; }
    (async () => {
      const { data: row } = await supabase
        .from("fx_rates")
        .select("rate")
        .eq("base", "USD")
        .eq("quote", currency)
        .maybeSingle();
      if (cancelled) return;
      const r = Number(row?.rate);
      setFxRate(Number.isFinite(r) && r > 0 ? r : 1);
    })();
    return () => { cancelled = true; };
  }, [currency]);

  const { data, loading, error, load } = useAnalyzerSnapshot();

  // FBA compliance (hazmat/prep/sellability) — shared with FbaCompliancePanel via edge-fn cache.
  const eligHook = useFbaEligibility({
    asin: data?.asin,
    marketplace: data?.marketplace || marketplace,
    enabled: !!data?.asin,
  });


  useEffect(() => {
    if (initialAsin && /^[A-Z0-9]{10}$/.test(initialAsin)) {
      load(initialAsin, marketplace);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (data?.ranksPrices?.buyBox?.current && !salePrice) {
      setSalePrice(data.ranksPrices.buyBox.current);
    }
  }, [data, salePrice]);

  // Load persisted cost from extension memory whenever ASIN changes
  const loadedCostFor = useRef<string | null>(null);
  useEffect(() => {
    if (!data?.asin) return;
    const key = `${data.asin}`;
    if (loadedCostFor.current === key) return;
    loadedCostFor.current = key;
    (async () => {
      const { data: u, error: uErr } = await supabase.auth.getUser();
      if (uErr) console.warn("[ProductAnalyzer] getUser error", uErr);
      if (!u?.user) {
        console.warn("[ProductAnalyzer] no auth user — cannot load saved cost");
        return;
      }
      const asin = (data.asin || "").toUpperCase();
      const { data: rows, error: qErr } = await supabase
        .from("mobile_scan_cost_memory")
        .select("total_cost, units, sale_price_override, updated_at, barcode")
        .eq("user_id", u.user.id)
        .eq("asin", asin)
        .order("updated_at", { ascending: false })
        .limit(1);
      if (qErr) {
        console.error("[ProductAnalyzer] cost query error", qErr);
        return;
      }
      console.log("[ProductAnalyzer] cost rows for", asin, rows);
      const row = rows && rows.length > 0 ? rows[0] : null;
      if (row) {
        const units = Math.max(1, Number(row.units) || 1);
        const total = Number(row.total_cost) || 0;
        if (total > 0) setCostPrice(+(total / units).toFixed(2));
        if (row.sale_price_override) setSalePrice(Number(row.sale_price_override));
      }
    })();
  }, [data?.asin]);

  // Persist cost back so the extension and other devices see it.
  // Uses the safe RPC: zero/empty values do NOT overwrite a saved cost.
  useEffect(() => {
    if (!data?.asin || costPrice <= 0) return;
    const t = setTimeout(async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u?.user) return;
      const { error: rpcErr } = await (supabase as any).rpc("save_mobile_scan_cost_memory", {
        _asin: data.asin,
        _barcode: null,
        _total_cost: costPrice,
        _units: 1,
        _sale_price_override: salePrice > 0 ? salePrice : null,
      });
      if (rpcErr) console.warn("[ProductAnalyzer] save cost rpc error", rpcErr);
    }, 600);
    return () => clearTimeout(t);
  }, [costPrice, salePrice, data?.asin]);

  const handleSearch = () => {
    const asin = asinInput.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) return;
    setParams({ asin, marketplace });
    load(asin, marketplace);
  };

  // Cost is stored in USD (from mobile_scan_cost_memory / extension).
  // For non-US marketplaces, Keepa prices and SP-API fees come back in
  // native currency, so we lift the USD cost into the marketplace currency
  // before any Profit/ROI math — identical to the Chrome extension panel.
  const costInMarket = costPrice > 0 ? +(costPrice * fxRate).toFixed(2) : 0;
  const fxApplied = currency !== "USD" && fxRate !== 1 && costPrice > 0;

  // Live SP-API ROI — identical engine used by the Chrome extension
  // (calculate-roi → GetMyFeesEstimate, always FBA-priced).
  const live = useLiveRoi(data?.asin ?? null, costInMarket > 0 ? costInMarket : null, marketplace);
  const liveFees = live.totalFees;
  const liveReferralFee = live.referralFee;
  const liveFbaFee = live.fbaFee;
  const liveClosingFee = (live.variableClosingFee ?? 0) + (live.otherFees ?? 0);

  // Prefer live SP-API fees (identical to extension). Fall back to feeRate estimate
  // only when SP-API hasn't returned yet or cost/sale aren't both available.
  let calc = data ? computeCalc(costInMarket, salePrice, feeRate, "FBA", 0, 1) : null;
  if (calc && liveFees != null && salePrice > 0 && costInMarket > 0) {
    const profit = salePrice - liveFees - costInMarket;
    const roi = costInMarket > 0 ? (profit / costInMarket) * 100 : 0;
    const margin = salePrice > 0 ? (profit / salePrice) * 100 : 0;
    calc = {
      profit,
      roi,
      margin,
      totalFees: liveFees,
      amazonPayout: salePrice - liveFees,
      breakeven: costInMarket + liveFees,
      maxCost: (salePrice - liveFees) / 1.15,
    };
  }


  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Product Analyzer | ArbiProSeller</title>
        <meta name="description" content="Full SellerAmp-style product analysis with charts, offers, BSR history, and profit calculator." />
      </Helmet>

      <div className="bg-[#0f1c3f] text-white">
        <div className="max-w-[1600px] mx-auto px-4 py-3 flex items-center gap-2 flex-wrap">
          <h1 className="text-base font-semibold mr-2">Product Analyzer</h1>
          <div className="flex items-center gap-2 flex-1 min-w-[280px] max-w-xl">
            <Input
              value={asinInput}
              onChange={(e) => setAsinInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="Enter ASIN (e.g. B071GWMDWD)"
              className="h-9 bg-white/10 border-white/20 text-white placeholder:text-white/60 font-mono"
              maxLength={10}
            />
            <select
              value={marketplace}
              onChange={(e) => setMarketplace(e.target.value)}
              className="h-9 rounded-md bg-white/10 border border-white/20 text-white text-sm px-2"
            >
              {["US", "CA", "MX", "BR", "GB", "DE", "FR", "IT", "ES", "JP"].map((m) => (
                <option key={m} value={m} className="text-foreground">{m}</option>
              ))}
            </select>
            <Button onClick={handleSearch} disabled={loading} size="sm" className="bg-primary hover:bg-primary/90">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            </Button>
          </div>
          {data && (
            <div className="flex items-center gap-2">
              {data.cached && data.fetchedAt && (
                <span className="text-xs text-white/70 hidden md:inline">
                  Cached · Last fetched {new Date(data.fetchedAt).toLocaleString()}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                className="bg-white/10 border-white/20 text-white hover:bg-white/20"
                onClick={() => load(data.asin, data.marketplace, true)}
                disabled={loading}
                title="Force a fresh Keepa fetch (uses tokens)"
              >
                <RefreshCw className={`w-4 h-4 mr-1 ${loading ? "animate-spin" : ""}`} /> Refresh Keepa
              </Button>
            </div>
          )}
        </div>
      </div>

      <main className="max-w-[1600px] mx-auto px-4 py-4 space-y-3">
        {error && (
          <Card><CardContent className="p-4 text-sm text-rose-600">{error}</CardContent></Card>
        )}
        {!data && !loading && !error && (
          <Card><CardContent className="p-8 text-center text-muted-foreground">Enter an ASIN to load full product analysis.</CardContent></Card>
        )}
        {loading && !data && (
          <Card><CardContent className="p-8 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />Fetching from Keepa…</CardContent></Card>
        )}

        {data && (
          <>
            <ProductHeader snap={data} />

            <QuickInfoCards
              snap={data}
              costPrice={costPrice}
              salePrice={salePrice}
              onCostChange={setCostPrice}
              onSaleChange={setSalePrice}
              profit={calc?.profit ?? 0}
              roi={calc?.roi ?? 0}
              maxCost={calc?.maxCost ?? 0}
              currencySymbol={currencySymbol}
              currency={currency}
              fxRate={fxRate}
              costInMarket={costInMarket}
            />

            {fxApplied && (
              <Card>
                <CardContent className="p-3 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 rounded">
                  💱 Cost entered in USD is converted to {currency} at 1 USD = {fxRate.toFixed(4)} so Profit / ROI / competitor ROI all use the marketplace's native currency (same as the Chrome extension).
                  &nbsp;<span className="text-foreground">${costPrice.toFixed(2)} ≈ {currencySymbol}{costInMarket.toFixed(2)}</span>
                </CardContent>
              </Card>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
              <div className="xl:col-span-2 space-y-3">
                <AnalyzerCharts snap={data} />
                <OffersTable
                  snap={data}
                  costPrice={costInMarket}
                  feeRate={feeRate}
                  liveReferralFee={liveReferralFee}
                  liveFbaFee={liveFbaFee}
                  liveClosingFee={liveClosingFee}
                  liveRefPrice={live.amazonPrice}
                  currencySymbol={currencySymbol}
                />
                
              </div>

              <div className="space-y-3">
                <FbaCompliancePanel asin={data.asin} marketplace={data.marketplace} />
                {(() => {
                  // ipRisk overlay removed 2026-07-06 (see architecture-audit.md);
                  // the IP alert had no real classifier behind it.
                  const compliance = complianceFromStageStatuses(
                    eligHook.data?.stageStatuses,
                  );
                  const bbPrice = data.ranksPrices.buyBox.current;

                  // Sim override is active when the user typed a sale price that differs
                  // from Buy Box (ProfitCalculator's default sync populates salePrice from BB).
                  const simActive = salePrice > 0 && bbPrice != null && Math.abs(salePrice - bbPrice) > 0.01;
                  const fd = computeFinalDecision({
                    profit: calc?.profit ?? null,
                    roi: calc?.roi ?? null,
                    hasCost: costPrice > 0,
                    eligibility: eligHook.data?.eligible ? "approved" : eligHook.data?.blockingIssues?.length ? "restricted" : null,
                    intel: {
                      bsr_current: data.quickInfo.bsr,
                      est_monthly_sales: data.quickInfo.salesPerMonth,
                    },
                    offerCounts: { fba: data.computed.fbaOffers, fbm: data.computed.fbmOffers },
                    compliance,
                    buyBoxPrice: bbPrice,
                    simOverride: simActive
                      ? { active: true, profit: calc?.profit ?? null, roi: calc?.roi ?? null, salePrice }
                      : null,
                  });
                  const decisionDebugPayload = {
                    asin: data.asin,
                    marketplace: data.marketplace,
                    priceBasis: fd.priceBasis,
                    buyBoxPrice: bbPrice,
                    simActive,
                    simDelta: fd.simDelta ?? null,
                    final: fd.final,
                    confidence: fd.confidence,
                    scorePct: fd.scorePct,
                    complianceFlags: fd.complianceFlags,
                    complianceInput: compliance,
                    sellerCountSource: fd.sellerCountSource,
                    sellerCountUsed: fd.sellerCountUsed,
                    offerCountsInput: { fba: data.computed.fbaOffers, fbm: data.computed.fbmOffers },
                    competition: fd.competition,
                    profit: fd.profit,
                    trend: fd.trend,
                    eligibility: fd.eligibility,
                    salesVelocity: fd.salesVelocity,
                    explanation: fd.explanation,
                  };
                  return (
                    <div className="space-y-2">
                      <DecisionMemoryPanel
                        reArmKey={`${data.asin}:${data.marketplace}:${costPrice}:${salePrice}`}
                        source="web"
                        snapshot={{
                          asin: data.asin,
                          marketplace: data.marketplace,
                          cost: costPrice || null,
                          fees: calc?.totalFees ?? null,
                          sale_price: salePrice || null,
                          roi: calc?.roi ?? null,
                          profit: calc?.profit ?? null,
                          margin: calc?.margin ?? null,
                          bsr: data.quickInfo.bsr,
                          est_sales_month: data.quickInfo.salesPerMonth,
                          buy_box: data.ranksPrices.buyBox.current,
                          lowest_fba: data.ranksPrices.newFba.current,
                          seller_count: data.computed.totalOffers,
                          final_decision: fd.final.action,
                          confidence: fd.confidence,
                          competition_level: fd.competition.text,
                          ai_reasoning: fd.explanation,
                          raw_snapshot: { quickInfo: data.quickInfo, ranksPrices: data.ranksPrices, computed: data.computed, alerts: data.alerts },
                          category: data.identity.category,
                          brand: data.identity.brand,
                          amazon_presence: data.offers.some(o => o.isAmazon) ? "present" : "absent",
                          source_surface: "web",
                          data_freshness: data.cached ? "cached" : "live",
                          retrieval_state: data.offers.length > 0 ? "ok" : "partial",
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const json = JSON.stringify(decisionDebugPayload, null, 2);
                          navigator.clipboard.writeText(json).then(
                            () => toast.success("Decision JSON copied to clipboard"),
                            () => {
                              // Fallback: log to console when clipboard is blocked
                              // eslint-disable-next-line no-console
                              console.log("[decision-debug]", decisionDebugPayload);
                              toast.message("Clipboard blocked — payload printed to console");
                            },
                          );
                        }}
                        className="w-full text-[11px] px-2 py-1 rounded border border-white/15 bg-white/5 hover:bg-white/10 text-white/80"
                      >
                        Copy decision JSON (debug)
                      </button>
                    </div>
                  );
                })()}
                <AlertsPanel alerts={data.alerts} dimensions={data.identity.packageDimensions} />
                <RanksPricesPanel snap={data} />
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              <ProfitCalculator
                costPrice={costPrice}
                salePrice={salePrice}
                feeRate={feeRate}
                onCostChange={setCostPrice}
                onSaleChange={setSalePrice}
                onFeeRateChange={setFeeRate}
                currencySymbol={currencySymbol}
                currency={currency}
                fxRate={fxRate}
                costInMarket={costInMarket}
              />

              <NotesAndTags asin={data.asin} marketplace={data.marketplace} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
