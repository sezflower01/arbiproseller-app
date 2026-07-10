// Keepa Historical Price Lookup
// Returns the listing/Buy Box price at a specific timestamp for an ASIN+marketplace.
// Used as a FALLBACK estimate for pending orders where Orders API ItemPrice is missing.
// Result is ALWAYS an estimate - never written to sold_price.
//
// Caching: Results are bucketed to 15-minute windows and stored in keepa_price_cache
// (shared across users) to minimize Keepa token usage.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DOMAIN_MAP: Record<string, number> = {
  US: 1, GB: 2, DE: 3, FR: 4, JP: 5, CA: 6, IT: 8, ES: 9, IN: 10, MX: 11, BR: 12,
};

// Keepa CSV indices
const IDX_AMAZON = 0;
const IDX_NEW = 1;
const IDX_BUYBOX = 18;
const IDX_NEW_FBA = 10;

// Keepa epoch: minutes since 2011-01-01
const KEEPA_EPOCH_MS = Date.UTC(2011, 0, 1);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Truncate timestamp to nearest 15-min boundary (down).
function bucket15Min(ts: Date): Date {
  const ms = ts.getTime();
  const bucketMs = 15 * 60 * 1000;
  return new Date(Math.floor(ms / bucketMs) * bucketMs);
}

// Convert JS Date -> Keepa minutes
function toKeepaMin(d: Date): number {
  return Math.floor((d.getTime() - KEEPA_EPOCH_MS) / 60000);
}

// Parse Keepa CSV [t,v,t,v,...] and find the value closest to (and not after) targetKeepaMin.
// Returns price in dollars, or null.
function findPriceAtTime(csv: number[] | null | undefined, targetKeepaMin: number): number | null {
  if (!csv || csv.length < 2) return null;
  let best: { t: number; v: number } | null = null;
  for (let i = 0; i < csv.length; i += 2) {
    const t = csv[i];
    const v = csv[i + 1];
    if (typeof t !== 'number' || typeof v !== 'number') continue;
    if (v <= 0) continue; // -1 = no data
    if (t > targetKeepaMin) {
      // This sample is AFTER target; if we have nothing yet, accept the first future sample
      // (within 24h tolerance). Otherwise stop.
      if (!best && (t - targetKeepaMin) <= 24 * 60) {
        best = { t, v };
      }
      break;
    }
    best = { t, v };
  }
  return best ? best.v / 100 : null;
}

interface RequestBody {
  asin: string;
  marketplace?: string; // e.g. 'US', 'CA', 'MX', 'BR'
  timestamp: string;    // ISO string of order_date
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const KEEPA_KEY = Deno.env.get('KEEPA_API_KEY');

    if (!KEEPA_KEY) {
      return jsonResponse({ error: 'KEEPA_API_KEY not configured' }, 500);
    }

    const body = await req.json() as RequestBody;
    const asin = String(body.asin || '').trim().toUpperCase();
    const marketplace = String(body.marketplace || 'US').toUpperCase();
    const tsRaw = body.timestamp;

    if (!asin || !/^B[0-9A-Z]{9}$/.test(asin) && !/^\d{10}$/.test(asin)) {
      return jsonResponse({ error: 'Invalid ASIN' }, 400);
    }
    const targetDate = new Date(tsRaw);
    if (isNaN(targetDate.getTime())) {
      return jsonResponse({ error: 'Invalid timestamp' }, 400);
    }
    const domainId = DOMAIN_MAP[marketplace];
    if (!domainId) {
      return jsonResponse({ error: `Unsupported marketplace: ${marketplace}` }, 400);
    }

    const bucket = bucket15Min(targetDate);
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 1. Check cache
    const { data: cached } = await supabase
      .from('keepa_price_cache')
      .select('price_usd, source, fetched_at')
      .eq('asin', asin)
      .eq('marketplace', marketplace)
      .eq('bucket_ts', bucket.toISOString())
      .maybeSingle();

    if (cached) {
      return jsonResponse({
        asin,
        marketplace,
        bucket_ts: bucket.toISOString(),
        price_usd: cached.price_usd,
        source: cached.source,
        cached: true,
        fetched_at: cached.fetched_at,
      });
    }

    // 2. Cache miss - fetch from Keepa.
    // Use stats=180 days to get history covering the order date.
    // Compute days from now to order date (min 1, max 365).
    const daysAgo = Math.max(
      1,
      Math.min(365, Math.ceil((Date.now() - targetDate.getTime()) / (24 * 60 * 60 * 1000)) + 7)
    );

    const url = new URL('https://api.keepa.com/product');
    url.search = new URLSearchParams({
      key: KEEPA_KEY,
      domain: String(domainId),
      asin,
      stats: String(daysAgo),
      history: '1',
    }).toString();

    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), 25000);
    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: ctrl.signal });
    } catch (e) {
      clearTimeout(tId);
      const aborted = (e as Error)?.name === 'AbortError';
      return jsonResponse({ error: aborted ? 'Keepa timeout' : `Keepa fetch failed: ${(e as Error).message}` }, 502);
    }
    clearTimeout(tId);

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return jsonResponse({ error: `Keepa ${res.status}: ${txt.slice(0, 200)}` }, 502);
    }

    const json = await res.json();
    const product = json?.products?.[0];
    if (!product) {
      // Cache the negative result so we don't re-query
      await supabase.from('keepa_price_cache').upsert({
        asin, marketplace,
        bucket_ts: bucket.toISOString(),
        price_usd: null, source: 'none',
        domain_id: domainId,
      }, { onConflict: 'asin,marketplace,bucket_ts' });
      return jsonResponse({ asin, marketplace, bucket_ts: bucket.toISOString(), price_usd: null, source: 'none', cached: false });
    }

    const csv: (number[] | null)[] = product.csv || [];
    const targetKeepaMin = toKeepaMin(targetDate);

    // Priority order: Buy Box -> New FBA -> New (any) -> Amazon
    const candidates: Array<[string, number[] | null]> = [
      ['buybox', csv[IDX_BUYBOX]],
      ['new_fba', csv[IDX_NEW_FBA]],
      ['new', csv[IDX_NEW]],
      ['amazon', csv[IDX_AMAZON]],
    ];

    let foundPrice: number | null = null;
    let foundSource = 'none';
    for (const [src, series] of candidates) {
      const p = findPriceAtTime(series, targetKeepaMin);
      if (p && p > 0) {
        foundPrice = p;
        foundSource = src;
        break;
      }
    }

    // 3. Cache result (positive or negative)
    await supabase.from('keepa_price_cache').upsert({
      asin, marketplace,
      bucket_ts: bucket.toISOString(),
      price_usd: foundPrice,
      raw_price_cents: foundPrice ? Math.round(foundPrice * 100) : null,
      source: foundSource,
      domain_id: domainId,
    }, { onConflict: 'asin,marketplace,bucket_ts' });

    return jsonResponse({
      asin,
      marketplace,
      bucket_ts: bucket.toISOString(),
      price_usd: foundPrice,
      source: foundSource,
      cached: false,
      tokens_left: json?.tokensLeft ?? null,
    });
  } catch (error) {
    console.error('[KEEPA-HIST-PRICE] Error:', error);
    return jsonResponse({ error: (error as Error).message }, 500);
  }
});
