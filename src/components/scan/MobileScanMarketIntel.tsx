import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, RefreshCw, TrendingUp, Crown } from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from "recharts";

type SeriesPoint = { t: string; v: number };
type Series = {
  amazon: SeriesPoint[];
  buybox: SeriesPoint[];
  newPrice: SeriesPoint[];
  newFba: SeriesPoint[];
  newFbm: SeriesPoint[];
  bsr: SeriesPoint[];
};
type Offer = {
  sellerId: string;
  sellerName: string;
  isAmazon: boolean;
  isSelf?: boolean;
  isFBA: boolean;
  isPrime: boolean;
  price: number | null;
  shipping: number | null;
  landed: number;
  stock: number | null;
  isBuyBox: boolean;
};
type HistoryPayload = {
  series: Series;
  offers: { count: number; list: Offer[] };
  cached: boolean;
  fetched_at: string;
} | null;

type RangeKey = '90' | '180' | '365';

interface Props {
  asin: string;
  marketplace?: string;
  currency?: string;
  unitFees?: number; // referral + fba + variable closing
  unitCost?: number; // total / units
  onMonthlySalesEstimate?: (sales: number | null) => void;
  // Optional: shows the "Refresh Keepa Data" button that triggers parent stability refetch
  onRefreshKeepa?: () => void;
  refreshingKeepa?: boolean;
}

const RANGE_LABELS: Record<RangeKey, string> = { '90': '3M', '180': '6M', '365': '1Y' };

const fmtCurrency = (n: number | null | undefined, ccy = 'USD') => {
  if (n == null || !isFinite(n)) return '—';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy }).format(n); }
  catch { return `$${n.toFixed(2)}`; }
};

const fmtChartDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

// Merge multiple series into one array of points keyed by date for recharts
function mergeSeries(s: Series) {
  const map = new Map<string, any>();
  const push = (key: keyof Series, name: string) => {
    for (const p of s[key]) {
      const day = p.t.slice(0, 10);
      const row = map.get(day) || { date: day };
      row[name] = p.v;
      map.set(day, row);
    }
  };
  push('amazon', 'Amazon');
  push('buybox', 'BuyBox');
  push('newFba', 'FBA');
  push('newFbm', 'FBM');
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export default function MobileScanMarketIntel({
  asin, marketplace = 'US', currency = 'USD', unitFees = 0, unitCost = 0,
  onMonthlySalesEstimate, onRefreshKeepa, refreshingKeepa = false,
}: Props) {
  const [range, setRange] = useState<RangeKey>('90');
  const [data, setData] = useState<HistoryPayload>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async (force: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const { data: resp, error: invErr } = await supabase.functions.invoke('mobile-scan-price-history', {
        body: { asin, marketplace, range, force },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (invErr) throw invErr;
      if (!resp || resp.error) throw new Error(resp?.error || 'Failed to load history');
      setData(resp as HistoryPayload);
    } catch (e: any) {
      setError(e?.message || 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }, [asin, marketplace, range]);

  useEffect(() => { load(false); }, [load]);

  useEffect(() => {
    if (!onMonthlySalesEstimate || !data) return;
    const bsrPoints = (data.series.bsr || []).filter(p => Number.isFinite(p.v) && p.v > 0);
    const latestBsr = bsrPoints.at(-1)?.v ?? null;
    onMonthlySalesEstimate(latestBsr ? Math.max(1, Math.round(100000 * Math.pow(latestBsr, -0.78))) : null);
  }, [data, onMonthlySalesEstimate]);

  const chartData = useMemo(() => data ? mergeSeries(data.series) : [], [data]);

  // Range-aware stability: prefer BuyBox, fall back to FBA, then Amazon series.
  const stability = useMemo(() => {
    if (!data) return null;
    const pick = (arr: SeriesPoint[]) => arr.filter(p => isFinite(p.v) && p.v > 0).map(p => p.v);
    const series = pick(data.series.buybox).length >= 5 ? pick(data.series.buybox)
      : pick(data.series.newFba).length >= 5 ? pick(data.series.newFba)
      : pick(data.series.amazon).length >= 5 ? pick(data.series.amazon)
      : pick(data.series.newFbm);
    if (series.length < 5) return null;
    const min = Math.min(...series);
    const max = Math.max(...series);
    const avg = series.reduce((s, v) => s + v, 0) / series.length;
    const swingPct = avg > 0 ? ((max - min) / avg) * 100 : 0;
    const verdict: 'stable' | 'moderate' | 'volatile' =
      swingPct < 8 ? 'stable' : swingPct < 18 ? 'moderate' : 'volatile';
    const rangeLabel = RANGE_LABELS[range];
    return { verdict, swingPct, min, max, avg, rangeLabel };
  }, [data, range]);

  const allOffers = data?.offers?.list || [];

  // Effective competitors:
  //  - FBA or Amazon (FBM rarely wins BB on FBA-dominated listings)
  //  - In stock (stock > 0, or unknown stock = treat as in-stock since SP-API often hides it)
  //  - Within ±5% of Buy Box price (or anchor lowest FBA if BB missing)
  //  - NEVER fall back to "top 4 lowest" — that surfaces stale/used offers far below BB
  //    and misrepresents real competition.
  const { effectiveOffers, buyBoxPrice, anchorPrice } = useMemo(() => {
    if (allOffers.length === 0) return { effectiveOffers: [], buyBoxPrice: null, anchorPrice: null };
    const bb = allOffers.find(o => o.isBuyBox);
    const bbPrice = bb?.landed ?? null;
    const fbaOffers = allOffers.filter(o => (o.isFBA || o.isAmazon || o.isBuyBox || o.isSelf) && (o.stock == null || o.stock > 0));
    const anchor = bbPrice;
    if (!anchor) {
      // No BB — show all eligible FBA in stock, no synthetic fallback.
      return { effectiveOffers: fbaOffers, buyBoxPrice: bbPrice, anchorPrice: null };
    }

    // ±5% window around BB. Real BB-eligible competitors price near the BB.
    const window = anchor * 0.05;
    const lo = anchor - window;
    const hi = anchor + window;
    const within = fbaOffers.filter(o => o.landed >= lo && o.landed <= hi);

    return { effectiveOffers: within, buyBoxPrice: bbPrice, anchorPrice: anchor };
  }, [allOffers]);

  const offers = showAll ? allOffers : effectiveOffers;
  const amzPresent = allOffers.some(o => o.isAmazon);


  return (
    <section className="mt-4 rounded-2xl bg-white/[0.03] border border-white/10 p-4">
      <header className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-emerald-300" />
          <h2 className="text-[11px] uppercase tracking-wide text-white/70 font-semibold">Price History & Live Offers</h2>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          className="inline-flex items-center gap-1 text-[10px] text-blue-200 hover:text-blue-100 disabled:opacity-50"
          aria-label="Refresh history"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </header>

      {/* Range tabs */}
      <div className="flex gap-1 mb-3">
        {(Object.keys(RANGE_LABELS) as RangeKey[]).map(r => (
          <button
            key={r}
            type="button"
            onClick={() => setRange(r)}
            className={`flex-1 h-8 rounded-lg text-[11px] font-semibold border transition ${
              range === r
                ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-200'
                : 'bg-white/5 border-white/10 text-white/60 hover:border-white/30'
            }`}
          >
            {RANGE_LABELS[r]}
          </button>
        ))}
      </div>

      {/* Chart */}
      <div className="w-full h-56 -ml-2">
        {loading && !data ? (
          <div className="h-full flex items-center justify-center text-white/50 text-xs">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading Keepa price history…
          </div>
        ) : error ? (
          <div className="h-full flex items-center justify-center text-amber-300 text-xs px-2 text-center">
            {error}
          </div>
        ) : chartData.length === 0 ? (
          <div className="h-full flex items-center justify-center text-white/40 text-xs">No price history available.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              <XAxis
                dataKey="date"
                tickFormatter={fmtChartDate}
                stroke="rgba(255,255,255,0.45)"
                tick={{ fontSize: 10 }}
                minTickGap={32}
              />
              <YAxis
                stroke="rgba(255,255,255,0.45)"
                tick={{ fontSize: 10 }}
                tickFormatter={(v) => `$${Number(v).toFixed(0)}`}
                domain={['auto', 'auto']}
                width={42}
              />
              <Tooltip
                contentStyle={{
                  background: 'rgba(15,28,63,0.95)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  borderRadius: 8,
                  fontSize: 11,
                  color: '#fff',
                }}
                labelFormatter={(l) => fmtChartDate(l as string)}
                formatter={(v: any, n: any) => [fmtCurrency(Number(v), currency), n]}
              />
              <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} iconType="line" />
              <Line type="monotone" dataKey="BuyBox" stroke="#34d399" dot={false} strokeWidth={2} connectNulls />
              <Line type="monotone" dataKey="Amazon" stroke="#f97316" dot={false} strokeWidth={1.5} connectNulls />
              <Line type="monotone" dataKey="FBA" stroke="#60a5fa" dot={false} strokeWidth={1.5} connectNulls />
              <Line type="monotone" dataKey="FBM" stroke="#a78bfa" dot={false} strokeWidth={1.5} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Range-aware stability + Keepa refresh footer (under graph) */}
      {(stability || onRefreshKeepa) && (
        <div className="mt-2 flex flex-col gap-1">
          {onRefreshKeepa && (
            <button
              type="button"
              onClick={onRefreshKeepa}
              disabled={refreshingKeepa}
              className="w-full rounded-lg border border-blue-400/40 text-blue-100 bg-blue-500/10 hover:bg-blue-500/20 disabled:opacity-60 px-3 py-2 text-sm font-semibold flex items-center justify-center gap-2 transition-colors"
            >
              <RefreshCw className={`h-4 w-4 ${refreshingKeepa ? 'animate-spin' : ''}`} />
              {refreshingKeepa ? 'Refreshing Keepa…' : 'Refresh Keepa Data'}
            </button>
          )}
          {onRefreshKeepa && (
            <span className="text-xs text-white/55 text-center">Uses 1 Keepa token. Use only when you need fresh data.</span>
          )}
          {stability && (() => {
            const v = stability.verdict;
            const label = v === 'stable' ? 'Stable' : v === 'moderate' ? 'Moderate' : 'Volatile';
            const color = v === 'stable' ? 'border-emerald-400/50 text-emerald-200 bg-emerald-500/10'
              : v === 'moderate' ? 'border-yellow-400/50 text-yellow-200 bg-yellow-500/10'
              : 'border-rose-400/50 text-rose-200 bg-rose-500/10';
            return (
              <div className={`mt-0.5 rounded-lg border ${color} px-3 py-2 text-sm font-semibold flex items-center justify-between`}>
                <span>{label} {stability.rangeLabel} · ±{stability.swingPct.toFixed(1)}%</span>
                <span className="text-xs opacity-80">
                  {fmtCurrency(stability.min, currency)}–{fmtCurrency(stability.max, currency)}
                </span>
              </div>
            );
          })()}
        </div>
      )}

      {/* Offers table */}
      <div className="mt-3">
        <div className="flex items-center justify-between mb-1 gap-2">
          <h3 className="text-xs uppercase tracking-wide text-white/60 font-semibold">
            {showAll ? `All Offers (${allOffers.length})` : `Effective Sellers (${effectiveOffers.length})`}
          </h3>
          <div className="flex items-center gap-2">
            {data?.cached && <span className="text-xs text-white/50">Cached</span>}
            {allOffers.length > effectiveOffers.length && (
              <button
                type="button"
                onClick={() => setShowAll(s => !s)}
                className="text-xs px-2.5 py-1 rounded-md bg-white/5 border border-white/15 text-white/80 hover:text-white hover:border-white/30"
              >
                {showAll ? `Show top ${effectiveOffers.length}` : `Show all ${allOffers.length}`}
              </button>
            )}
          </div>
        </div>

        {!showAll && allOffers.length > 0 && (
          <div className="mb-2 rounded-md bg-white/[0.04] border border-white/10 px-2.5 py-2 text-xs text-white/75 leading-snug">
            <div>
              <span className="text-white font-semibold">{effectiveOffers.length}</span> live FBA offers near {buyBoxPrice ? 'Buy Box' : 'lowest FBA'} ({fmtCurrency(anchorPrice, currency)}) ·
              <span className="text-white/50"> {allOffers.length} live offers returned</span>
            </div>
            {allOffers.length >= 50 && (
              <div className="mt-0.5 text-amber-300/90">⚠️ Saturated listing — heavy competition may compress price.</div>
            )}
            {amzPresent && (
              <div className="mt-0.5 text-orange-300/90">🟠 Amazon is selling this item — Buy Box is hard to win.</div>
            )}
          </div>
        )}

        {loading && !data ? (
          <div className="h-16 flex items-center justify-center text-white/50 text-xs">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading offers…
          </div>
        ) : offers.length === 0 ? (
          <div className="text-[11px] text-white/40 py-3 text-center">No active offers found.</div>
        ) : (
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-sm border-separate border-spacing-y-1">
              <thead>
                <tr className="text-white/50 text-xs">
                  <th className="px-1 text-left font-medium">#</th>
                  <th className="px-1 text-left font-medium">Seller</th>
                  <th className="px-1 text-center font-medium">Type</th>
                  <th className="px-1 text-right font-medium">Stock</th>
                  <th className="px-1 text-right font-medium">Price</th>
                  <th className="px-1 text-right font-medium">Profit</th>
                  <th className="px-1 text-right font-medium">ROI</th>
                </tr>
              </thead>
              <tbody>
                {offers.map((o, i) => {
                  const profit = o.landed - unitFees - unitCost;
                  const roi = unitCost > 0 ? (profit / unitCost) * 100 : null;
                  const profitGood = profit >= 3;
                  const profitOk = profit >= 1;
                  return (
                    <tr
                      key={`${o.sellerId}-${i}`}
                      className={`bg-white/[0.04] ${o.isBuyBox ? 'ring-1 ring-emerald-400/40' : ''}`}
                    >
                      <td className="px-1 py-1.5 text-white/40 rounded-l-md">{i + 1}</td>
                      <td className="px-1 py-1.5 text-white truncate max-w-[120px]">
                        <div className="flex items-center gap-1">
                          {o.isBuyBox && <Crown className="h-3 w-3 text-emerald-300 shrink-0" />}
                          <span className={`truncate ${o.isSelf ? 'text-emerald-200 font-semibold' : o.isAmazon ? 'text-orange-200 font-semibold' : ''}`} title={o.sellerName}>
                            {o.sellerName}
                          </span>
                        </div>
                      </td>
                      <td className="px-1 py-1.5 text-center">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-semibold ${
                          o.isSelf ? 'bg-emerald-500/20 text-emerald-200'
                          : o.isAmazon ? 'bg-orange-500/20 text-orange-200'
                          : o.isFBA ? 'bg-blue-500/20 text-blue-200'
                          : 'bg-purple-500/20 text-purple-200'
                        }`}>
                          {o.isSelf ? 'YOU' : o.isAmazon ? 'AMZ' : o.isFBA ? 'FBA' : 'FBM'}
                        </span>
                      </td>
                      <td className="px-1 py-1.5 text-right text-white/70">{o.stock != null && o.stock > 0 ? o.stock : '—'}</td>
                      <td className="px-1 py-1.5 text-right text-white font-medium">{fmtCurrency(o.landed, currency)}</td>
                      <td className={`px-1 py-1.5 text-right font-semibold ${
                        unitCost > 0
                          ? (profitGood ? 'text-emerald-300' : profitOk ? 'text-amber-300' : 'text-rose-300')
                          : 'text-white/40'
                      }`}>
                        {unitCost > 0 ? fmtCurrency(profit, currency) : '—'}
                      </td>
                      <td className={`px-1 py-1.5 text-right font-semibold rounded-r-md ${
                        roi == null ? 'text-white/40'
                        : roi >= 30 ? 'text-emerald-300'
                        : roi >= 15 ? 'text-amber-300'
                        : 'text-rose-300'
                      }`}>
                        {roi == null ? '—' : `${roi.toFixed(0)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-white/50">
              {showAll ? 'Showing every active seller on this listing.' : 'Effective sellers = within ±5% of Buy Box. These are who you actually compete with.'} Crown = current Buy Box winner.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
