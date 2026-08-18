// Mobile Scan – 90-day price stability via Keepa
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

const DOMAIN_MAP: Record<string, number> = {
  US: 1, GB: 2, DE: 3, FR: 4, JP: 5, CA: 6, IT: 8, ES: 9, IN: 10, MX: 11, BR: 12,
};

// Keepa CSV indices
const IDX_AMAZON = 0;
const IDX_NEW = 1;
const IDX_BUYBOX = 18;

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hasSanePriceRange(min: number | null, avg: number | null, max: number | null): boolean {
  if (min == null || avg == null || max == null) return false;
  if (![min, avg, max].every((v) => Number.isFinite(v) && v > 0)) return false;
  if (min > max) return false;
  // Poisoned cache / parser mistakes show Keepa timestamps as prices, usually thousands
  // of times above the actual average. Keepa prices can move, but not like timestamps.
  if (min > avg * 25 || max > avg * 25) return false;
  return true;
}

function bsrToMonthlySales(bsr: number | null): number | null {
  if (bsr == null || !Number.isFinite(bsr) || bsr <= 0) return null;
  // Calibrated to align with Amazon's public "bought in past month" indicator.
  // Old curve (100000 * bsr^-0.78) under-estimated mid-BSR items by ~5-7x
  // (e.g. BSR 35k showed ~29/mo while Amazon reports 200+/mo).
  // New curve gives: BSR 1k≈1.6k/mo, 10k≈400/mo, 35k≈190/mo, 100k≈100/mo.
  return Math.max(1, Math.round(100000 * Math.pow(bsr, -0.6)));
}

// Convert Keepa "csv" array (alternating [keepaMinutes, value, keepaMinutes, value, ...])
// to ordered samples in the last N days. Values of -1 mean "no data".
function parseSeries(csv: number[] | null | undefined, daysBack: number) {
  if (!csv || csv.length < 2) return [] as { t: number; v: number }[];
  const KEEPA_EPOCH = 21564000; // minutes since 2011-01-01 to UNIX epoch / 60
  const cutoffMin = Math.floor(Date.now() / 60000) - KEEPA_EPOCH - daysBack * 24 * 60;
  const out: { t: number; v: number }[] = [];
  for (let i = 0; i < csv.length; i += 2) {
    const t = csv[i];
    const v = csv[i + 1];
    if (typeof t !== 'number' || typeof v !== 'number') continue;
    if (v === -1) continue;
    if (t < cutoffMin) continue;
    out.push({ t, v: v / 100 }); // cents -> currency units
  }
  return out;
}

function summarize(samples: { t: number; v: number }[]) {
  if (samples.length === 0) return null;
  let min = Infinity, max = -Infinity, sum = 0;
  for (const s of samples) {
    if (s.v < min) min = s.v;
    if (s.v > max) max = s.v;
    sum += s.v;
  }
  const avg = sum / samples.length;
  const swingPct = avg > 0 ? ((max - min) / avg) * 100 : 0;
  // days covered
  const tMin = samples[0].t;
  const tMax = samples[samples.length - 1].t;
  const daysCovered = Math.round((tMax - tMin) / (24 * 60));
  return { min, max, avg, swingPct, daysCovered, current: samples[samples.length - 1].v };
}

function classify(swingPct: number | null, samplesCount: number): string {
  if (swingPct == null || samplesCount < 3) return 'unknown';
  if (swingPct <= 10) return 'stable';
  if (swingPct <= 25) return 'moderate';
  return 'volatile';
}

function emptyPayload(asin: string, marketplace: string, reason: string) {
  return {
    asin,
    marketplace,
    current_price: null,
    min_price: null,
    avg_price: null,
    max_price: null,
    swing_pct: null,
    drops_90: null,
    days_covered: 0,
    verdict: 'unknown',
    series_used: null,
    cached: false,
    reason,
    // Always include `intel` so clients can distinguish "still loading" (stab===null)
    // from "request finished but Keepa had nothing" (stab.intel exists but empty).
    intel: {
      bsr_current: null,
      amazon_presence_pct: null,
      sellers_fba: null,
      sellers_fbm: null,
    },
  };
}

async function keepaErrorMessage(res: Response) {
  const bodyText = await res.text().catch(() => '');
  let detail = bodyText.trim();
  try {
    const parsed = JSON.parse(bodyText);
    detail = String(parsed?.error?.message || parsed?.error || parsed?.message || detail);
  } catch (_) {
    // Keepa often returns plain text for request/subscription/token errors.
  }
  return detail ? `Keepa HTTP ${res.status}: ${detail.slice(0, 240)}` : `Keepa HTTP ${res.status}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const KEEPA_KEY = Deno.env.get('KEEPA_API_KEY')?.trim();
    if (!KEEPA_KEY) {
      return jsonResponse({ error: 'KEEPA_API_KEY not configured' }, 500);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const token = authHeader.replace('Bearer ', '').trim();
    const { data: userRes, error: userError } = await admin.auth.getUser(token);
    if (userError || !userRes?.user) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const asin = String(body.asin || '').toUpperCase().trim();
    const marketplace = String(body.marketplace || 'US').toUpperCase();
    const force = body.force === true;
    if (!/^[A-Z0-9]{10}$/.test(asin)) {
      return new Response(JSON.stringify({ error: 'Invalid ASIN' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Cache lookup
    if (!force) {
      const { data: cached } = await admin
        .from('keepa_price_stability_cache')
        .select('*')
        .eq('asin', asin)
        .eq('marketplace', marketplace)
        .maybeSingle();
      if (cached && new Date(cached.expires_at).getTime() > Date.now()) {
        const cachedMin = num(cached.min_price);
        const cachedAvg = num(cached.avg_price);
        const cachedMax = num(cached.max_price);
        if (!hasSanePriceRange(cachedMin, cachedAvg, cachedMax)) {
          console.warn('[mobile-scan-price-stability] Ignoring poisoned Keepa cache', { asin, marketplace });
        } else {
          const raw = cached.raw && typeof cached.raw === 'object' ? cached.raw as any : null;
          const cachedIntel = raw?.sales_estimate_version === 3 ? raw?.intel ?? null : null;
          if (!cachedIntel) {
            console.warn('[mobile-scan-price-stability] Refreshing cache without current sales estimate logic', { asin, marketplace });
          } else {
            return jsonResponse({
              cached: true,
              asin, marketplace,
              verdict: cached.verdict,
              current_price: num(cached.current_price),
              min_price: cachedMin,
              avg_price: cachedAvg,
              max_price: cachedMax,
              swing_pct: num(cached.swing_pct),
              drops_90: cached.drops_90,
              days_covered: cached.days_covered,
              series_used: cached.series_used,
              fetched_at: cached.fetched_at,
              intel: cachedIntel,
            });
          }
        }
      }
    }

    const domainId = DOMAIN_MAP[marketplace] ?? 1;
    // Keep this request on Keepa's basic product endpoint only. Premium params like
    // offers/buybox can fail on some plans, and history=0 keeps the payload small.
    const url = new URL('https://api.keepa.com/product');
    url.search = new URLSearchParams({
      key: KEEPA_KEY,
      domain: String(domainId),
      asin,
      stats: '90',
      history: '0',
    }).toString();

    // Hard timeout so the UI never hangs forever on a slow Keepa response.
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 20000);
    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timeoutId);
      const aborted = (e as Error)?.name === 'AbortError';
      return jsonResponse(
        emptyPayload(asin, marketplace, aborted ? 'Keepa request timed out' : `Keepa fetch failed: ${(e as Error).message}`),
      );
    }
    clearTimeout(timeoutId);
    if (!res.ok) {
      const message = await keepaErrorMessage(res);
      console.error('[mobile-scan-price-stability] Keepa error', message);
      return jsonResponse(emptyPayload(asin, marketplace, message));
    }
    const json = await res.json();
    const product = json?.products?.[0];
    if (!product) {
      return jsonResponse(emptyPayload(asin, marketplace, 'No Keepa data'));
    }

    // With history=0 we use stats interval arrays (one entry per series index).
    const stats = product.stats || {};
    // Keepa stats shapes:
    //   stats.minInInterval / maxInInterval -> each entry is usually [priceCents, keepaMinutes]
    //   stats.avg / stats.avg90 -> array per series of priceCents (flat number)
    //   stats.current          -> array per series of priceCents (flat number)
    // Prices are in cents; -1 means "no data". For pairs, choose the value closest to avg/current
    // so we never render Keepa timestamps as $34k+ prices.
    const toPrice = (raw: unknown): number | null => {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n / 100;
    };
    const pickFlatPrice = (arr: any, idx: number): number | null => {
      const entry = arr?.[idx];
      if (entry == null) return null;
      return toPrice(Array.isArray(entry) ? entry[0] : entry);
    };
    const pickPairPrice = (arr: any, idx: number, referencePrice: number | null): number | null => {
      const entry = arr?.[idx];
      if (entry == null) return null;
      if (!Array.isArray(entry)) return toPrice(entry);
      const candidates = entry
        .map((raw: unknown) => Number(raw))
        .filter((n: number) => Number.isFinite(n) && n > 0);
      if (candidates.length === 0) return null;
      const refCents = referencePrice != null && referencePrice > 0 ? referencePrice * 100 : null;
      const chosen = refCents
        ? candidates.sort((a: number, b: number) => Math.abs(Math.log(a / refCents)) - Math.abs(Math.log(b / refCents)))[0]
        : candidates.sort((a: number, b: number) => a - b)[0];
      return chosen / 100;
    };

    const seriesOrder: { name: string; idx: number }[] = [
      { name: 'BUY_BOX', idx: IDX_BUYBOX },
      { name: 'AMAZON', idx: IDX_AMAZON },
      { name: 'NEW', idx: IDX_NEW },
    ];

    let chosenName = 'BUY_BOX';
    let minP: number | null = null, maxP: number | null = null, avgP: number | null = null, curP: number | null = null;
    for (const s of seriesOrder) {
      const av = pickFlatPrice(stats.avg90 ?? stats.avg, s.idx);
      const cu = pickFlatPrice(stats.current, s.idx);
      const reference = av ?? cu;
      const mn = pickPairPrice(stats.minInInterval ?? stats.min, s.idx, reference);
      const mx = pickPairPrice(stats.maxInInterval ?? stats.max, s.idx, reference);
      if (hasSanePriceRange(mn, av, mx)) {
        chosenName = s.name; minP = mn; maxP = mx; avgP = av; curP = cu; break;
      }
    }

    const drops90 = stats.salesRankDrops90 ?? null;

    // ============ Tier 1 enrichment — same Keepa call, zero extra tokens ============
    // BSR (sales rank) — series index 3 in Keepa CSV
    const IDX_SALES_RANK = 3;
    const bsrCurrent = (() => {
      const v = stats.current?.[IDX_SALES_RANK];
      const n = Array.isArray(v) ? Number(v[0]) : Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();
    const bsrAvg90 = (() => {
      const v = (stats.avg90 ?? stats.avg)?.[IDX_SALES_RANK];
      const n = Array.isArray(v) ? Number(v[0]) : Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    })();

    // Buy Box winner percentages (Amazon vs 3rd party) — Keepa: buyBoxStats { sellerId: { percentageWon } }
    const buyBoxStats = stats.buyBoxStats || product.buyBoxStats || null;
    let amazonBuyBoxPct: number | null = null;
    let topThirdPartyBuyBoxPct: number | null = null;
    if (buyBoxStats && typeof buyBoxStats === 'object') {
      const entries = Object.entries(buyBoxStats);
      let topNonAmazon = 0;
      for (const [sellerId, info] of entries) {
        const pct = Number((info as any)?.percentageWon);
        if (!Number.isFinite(pct)) continue;
        if (sellerId === 'ATVPDKIKX0DER' || sellerId === 'AMAZON') {
          amazonBuyBoxPct = pct;
        } else if (pct > topNonAmazon) {
          topNonAmazon = pct;
        }
      }
      if (topNonAmazon > 0) topThirdPartyBuyBoxPct = topNonAmazon;
    }

    // Seller / offer counts
    const offerCountFBA = Number(stats.offerCountFBA ?? product.offerCountFBA);
    const offerCountFBM = Number(stats.offerCountFBM ?? product.offerCountFBM);
    const sellersFBA = Number.isFinite(offerCountFBA) && offerCountFBA >= 0 ? offerCountFBA : null;
    const sellersFBM = Number.isFinite(offerCountFBM) && offerCountFBM >= 0 ? offerCountFBM : null;

    // Amazon presence: % of last 90d Amazon was selling (out of stock when -1)
    // stats.outOfStockPercentage[0] is Amazon's OOS % over 90d; presence = 100 - OOS
    const amazonOOS90 = Number(stats.outOfStockPercentage?.[IDX_AMAZON] ?? -1);
    const amazonPresencePct = Number.isFinite(amazonOOS90) && amazonOOS90 >= 0
      ? Math.max(0, Math.min(100, 100 - amazonOOS90))
      : null;

    // FBA Pick & Pack fee estimate (Keepa returns in cents)
    const fbaFeeRaw = Number(product.fbaFees?.pickAndPackFee);
    const fbaFeeEstimate = Number.isFinite(fbaFeeRaw) && fbaFeeRaw > 0 ? fbaFeeRaw / 100 : null;

    // Product metadata
    const productTitle = product.title ?? null;
    const brand = product.brand ?? product.manufacturer ?? null;
    const variationCount = Array.isArray(product.variations) ? product.variations.length : null;
    const categoryTree = Array.isArray(product.categoryTree)
      ? product.categoryTree.map((c: any) => c?.name).filter(Boolean).join(' › ')
      : null;
    const listedSinceTimestamp = Number(product.listedSince);
    const productAgeDays = Number.isFinite(listedSinceTimestamp) && listedSinceTimestamp > 0
      ? Math.round((Date.now() / 60000 - 21564000 - listedSinceTimestamp) / (60 * 24))
      : null;

    const monthlySoldRaw = Number(product.monthlySold ?? stats.monthlySold);
    const monthlySold = Number.isFinite(monthlySoldRaw) && monthlySoldRaw > 0 ? Math.round(monthlySoldRaw) : null;
    const dropsMonthly = drops90 != null ? Math.round(drops90 / 3) : null;
    const salesCandidates = [
      monthlySold,
      dropsMonthly,
      bsrToMonthlySales(bsrCurrent),
      bsrToMonthlySales(bsrAvg90),
    ].filter((v): v is number => v != null && v > 0);
    const estMonthlySales = salesCandidates.length ? Math.max(...salesCandidates) : null;

    const intel = {
      bsr_current: bsrCurrent,
      bsr_avg_90: bsrAvg90,
      sellers_fba: sellersFBA,
      sellers_fbm: sellersFBM,
      amazon_buybox_pct: amazonBuyBoxPct,
      third_party_buybox_pct: topThirdPartyBuyBoxPct,
      amazon_presence_pct: amazonPresencePct,
      fba_fee_estimate: fbaFeeEstimate,
      brand,
      title: productTitle,
      variation_count: variationCount,
      category_tree: categoryTree,
      product_age_days: productAgeDays,
      monthly_sold: monthlySold,
      est_monthly_sales: estMonthlySales,
    };

    if (minP == null || maxP == null || avgP == null) {
      return jsonResponse({
        ...emptyPayload(asin, marketplace, 'No usable Keepa price stats in the last 90 days'),
        drops_90: drops90,
        series_used: chosenName,
        intel,
      });
    }

    const swingPct = avgP > 0 ? ((maxP - minP) / avgP) * 100 : 0;
    // We don't have raw sample count without history; treat presence of stats as sufficient.
    const verdict = classify(swingPct, 3);

    const payload = {
      asin,
      marketplace,
      current_price: curP,
      min_price: minP,
      avg_price: avgP,
      max_price: maxP,
      swing_pct: swingPct,
      drops_90: drops90,
      days_covered: 90,
      verdict,
      series_used: chosenName,
      cached: false,
      intel,
    };

    // Upsert cache
    await admin.from('keepa_price_stability_cache').upsert({
      asin, marketplace,
      current_price: payload.current_price,
      min_price: payload.min_price,
      avg_price: payload.avg_price,
      max_price: payload.max_price,
      swing_pct: payload.swing_pct,
      drops_90: payload.drops_90,
      days_covered: payload.days_covered,
      verdict: payload.verdict,
      series_used: payload.series_used,
      raw: { sales_estimate_version: 3, intel },
      fetched_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: 'asin,marketplace' });

    return jsonResponse(payload);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
