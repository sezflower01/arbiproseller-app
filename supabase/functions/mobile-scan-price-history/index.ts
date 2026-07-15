// Mobile Scan – Price History (time-series) + Live Offers via Keepa
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DOMAIN_MAP: Record<string, number> = {
  US: 1, GB: 2, DE: 3, FR: 4, JP: 5, CA: 6, IT: 8, ES: 9, IN: 10, MX: 11, BR: 12,
};

// Keepa CSV indices we care about
const IDX_AMAZON = 0;
const IDX_NEW = 1;
const IDX_SALES_RANK = 3;
const IDX_BUYBOX = 18;
const IDX_NEW_FBA = 10;
const IDX_NEW_FBM_SHIP = 7;
// COUNT_NEW — active new-condition offer count over time. Verified live
// 2026-07-14 against a real ASIN: stats.current[11]/avg[11]/min[11]/max[11]
// matched this index's own csv values exactly (small integers, no cents
// scaling). This is an OFFER count, not a guaranteed unique-seller count —
// one seller can occasionally hold multiple offers.
const IDX_COUNT_NEW = 11;

const KEEPA_EPOCH_MIN = 21564000; // minutes from unix epoch -> keepa minutes
const KEEPA_EPOCH_MS_CONST = KEEPA_EPOCH_MIN * 60_000; // same epoch, in ms — derived so the two can never drift apart

const AMAZON_SELLER_IDS = new Set(['ATVPDKIKX0DER', 'AMAZON']);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function keepaMinToIso(km: number): string {
  return new Date((km + KEEPA_EPOCH_MIN) * 60_000).toISOString();
}

// Parse a CSV series [t,v,t,v,...]; returns ordered samples within last N days.
// Values are cents; -1 means no data.
function parseSeries(csv: number[] | null | undefined, daysBack: number, isPrice = true) {
  if (!csv || csv.length < 2) return [] as { t: number; v: number }[];
  const cutoffMin = Math.floor(Date.now() / 60_000) - KEEPA_EPOCH_MIN - daysBack * 24 * 60;
  const out: { t: number; v: number }[] = [];
  for (let i = 0; i < csv.length; i += 2) {
    const t = csv[i];
    const v = csv[i + 1];
    if (typeof t !== 'number' || typeof v !== 'number') continue;
    if (v === -1) continue;
    if (t < cutoffMin) continue;
    out.push({ t, v: isPrice ? v / 100 : v });
  }
  return out;
}

// Down-sample to ~1 point per day for the given window (lighter payload, smoother chart).
function downsample(samples: { t: number; v: number }[], daysBack: number) {
  if (samples.length === 0) return [];
  const buckets = Math.min(180, Math.max(30, daysBack));
  const bucketMin = Math.max(1, Math.floor((daysBack * 24 * 60) / buckets));
  const map = new Map<number, { sum: number; n: number; t: number }>();
  for (const s of samples) {
    const key = Math.floor(s.t / bucketMin);
    const b = map.get(key);
    if (b) { b.sum += s.v; b.n += 1; b.t = s.t; }
    else map.set(key, { sum: s.v, n: 1, t: s.t });
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => ({ t: keepaMinToIso(b.t), v: b.sum / b.n }));
}

function appendCurrentPoint(series: { t: string; v: number }[], value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return series;
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const next = series.filter(p => p.t.slice(0, 10) !== today);
  next.push({ t: nowIso, v: value });
  return next.sort((a, b) => a.t.localeCompare(b.t));
}

// ── Private-Label Risk data shaping (pure, unit-tested) ─────────────────
// These functions only transform already-fetched Keepa data — they never
// make network calls, so no additional Keepa cost. See plRisk.test.ts.

export type SellerHistorySummary = {
  windowDays: number;
  points: { t: string; v: number }[];
  currentCount: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  pointsCount: number;
  trend: 'increasing' | 'stable' | 'declining' | 'unknown';
  sufficient: boolean;
  rich: boolean;
};

// Summarize Keepa's COUNT_NEW series (csv[11]) — active new-condition offer
// count over time. `-1` ("no data") points are already dropped by
// parseSeries(). Trend compares the most recent ~30 days against the prior
// ~30 days; informational only per review (never scored in Phase 1), since
// a decline can be a temporary stock/restock blip.
export function summarizeCountSeries(rawPoints: { t: number; v: number }[], windowDays: number): SellerHistorySummary {
  const points = rawPoints
    .slice()
    .sort((a, b) => a.t - b.t)
    .map(p => ({ t: keepaMinToIso(p.t), v: p.v }));
  const pointsCount = points.length;
  const SUFFICIENT_MIN = 5;
  const RICH_MIN = 20;

  if (pointsCount === 0) {
    return {
      windowDays, points: [], currentCount: null, avg: null, min: null, max: null,
      pointsCount: 0, trend: 'unknown', sufficient: false, rich: false,
    };
  }

  const values = points.map(p => p.v);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const currentCount = values[values.length - 1];

  // Trend: last ~30 days average vs. the ~30 days before that.
  const nowMin = Math.floor(Date.now() / 60_000) - KEEPA_EPOCH_MIN;
  const THIRTY_D_MIN = 30 * 24 * 60;
  const recent = rawPoints.filter(p => p.t >= nowMin - THIRTY_D_MIN);
  const prior = rawPoints.filter(p => p.t >= nowMin - THIRTY_D_MIN * 2 && p.t < nowMin - THIRTY_D_MIN);
  let trend: SellerHistorySummary['trend'] = 'unknown';
  if (recent.length >= 2 && prior.length >= 2) {
    const recentAvg = recent.reduce((s, p) => s + p.v, 0) / recent.length;
    const priorAvg = prior.reduce((s, p) => s + p.v, 0) / prior.length;
    if (priorAvg > 0) {
      const deltaPct = ((recentAvg - priorAvg) / priorAvg) * 100;
      trend = deltaPct >= 15 ? 'increasing' : deltaPct <= -15 ? 'declining' : 'stable';
    }
  }

  return {
    windowDays, points, currentCount, avg, min, max, pointsCount,
    trend,
    sufficient: pointsCount >= SUFFICIENT_MIN,
    rich: pointsCount >= RICH_MIN,
  };
}

export type BuyBoxOwnershipSummary = {
  windowDays: number;
  sellers: { sellerId: string; percentageWon: number; isFBA: boolean }[];
  distinctThirdPartyWinners: number | null;
  topThirdPartyPct: number | null;
  topThirdPartySellerId: string | null;
  topSellerContinuityPct: number | null;
  continuityWindowDays: number | null;
  continuitySingleEvent: boolean;
  sufficient: boolean;
  rich: boolean;
};

// Time-weighted Buy Box continuity: what % of the MEASURED period did the
// top third-party seller actually hold the Buy Box, vs. simply "appears in
// the earliest and latest entries" (which proves nothing about the middle).
// `historyRaw` is Keepa's buyBoxSellerIdHistory — a FLAT array of alternating
// [keepaMinuteTimestamp, sellerId, keepaMinuteTimestamp, sellerId, ...],
// both encoded as strings. Verified live 2026-07-14 (typesFound: ["string"]
// for every element sampled).
//
// The final entry's held-duration runs from its own timestamp to
// `referenceEndMs` (real wall-clock "now" at call time, NOT the entry's own
// timestamp) — otherwise the most recent seller would incorrectly show a
// zero-duration hold just because there's no "next" event yet.
export function computeTopSellerContinuity(
  historyRaw: unknown,
  referenceEndMs: number,
  amazonSellerIds: Set<string>,
): { topSellerId: string | null; topSellerContinuityPct: number | null; continuityWindowDays: number | null; singleEvent: boolean } {
  const empty = { topSellerId: null, topSellerContinuityPct: null, continuityWindowDays: null, singleEvent: false };
  if (!Array.isArray(historyRaw) || historyRaw.length < 2) return empty;

  const events: { ms: number; sellerId: string }[] = [];
  for (let i = 0; i + 1 < historyRaw.length; i += 2) {
    const tRaw = Number(historyRaw[i]);
    const sellerId = String(historyRaw[i + 1] ?? '').trim();
    if (!Number.isFinite(tRaw) || !sellerId) continue;
    events.push({ ms: KEEPA_EPOCH_MS_CONST + tRaw * 60_000, sellerId });
  }
  events.sort((a, b) => a.ms - b.ms);
  if (events.length === 0) return empty;

  // A SINGLE recorded event means the Buy Box has never changed hands since
  // Keepa started tracking it for this ASIN — that's real evidence of
  // continuous control, not "not enough data". Used to require >=2 events,
  // which threw away exactly the cleanest private-label signal (one seller,
  // never displaced). Duration = from that one event to referenceEndMs.
  if (events.length === 1) {
    const ev = events[0];
    if (amazonSellerIds.has(ev.sellerId)) return empty; // third-party continuity only
    const coverageMs = referenceEndMs - ev.ms;
    if (coverageMs <= 0) return empty; // invalid/future timestamp
    return {
      topSellerId: ev.sellerId,
      topSellerContinuityPct: 100,
      continuityWindowDays: Math.round(coverageMs / (24 * 60 * 60 * 1000)),
      singleEvent: true,
    };
  }

  const startMs = events[0].ms;
  const totalDurationMs = referenceEndMs - startMs;
  if (totalDurationMs <= 0) return empty;

  const durationBySeller = new Map<string, number>();
  for (let i = 0; i < events.length; i++) {
    const segmentEndMs = i + 1 < events.length ? events[i + 1].ms : referenceEndMs;
    const segmentDurationMs = Math.max(0, segmentEndMs - events[i].ms);
    durationBySeller.set(events[i].sellerId, (durationBySeller.get(events[i].sellerId) || 0) + segmentDurationMs);
  }

  let topSellerId: string | null = null;
  let topDurationMs = 0;
  for (const [sellerId, durationMs] of durationBySeller) {
    if (amazonSellerIds.has(sellerId)) continue; // "third-party" continuity only
    if (durationMs > topDurationMs) { topDurationMs = durationMs; topSellerId = sellerId; }
  }
  if (!topSellerId) return empty;

  return {
    topSellerId,
    topSellerContinuityPct: (topDurationMs / totalDurationMs) * 100,
    continuityWindowDays: Math.round(totalDurationMs / (24 * 60 * 60 * 1000)),
    singleEvent: false,
  };
}

// Combines Keepa's own pre-computed per-seller Buy Box win stats
// (stats.buyBoxStats — verified live to be { sellerId: { percentageWon, ... } }
// for the requested `stats` window) with the time-weighted continuity above.
export function computeBuyBoxOwnership(
  buyBoxStats: Record<string, { percentageWon?: number; isFBA?: boolean }> | null | undefined,
  buyBoxSellerIdHistoryRaw: unknown,
  windowDays: number,
  amazonSellerIds: Set<string>,
  referenceEndMs: number,
): BuyBoxOwnershipSummary {
  const entries = buyBoxStats && typeof buyBoxStats === 'object' ? Object.entries(buyBoxStats) : [];
  const sellers = entries
    .map(([sellerId, info]) => ({
      sellerId,
      percentageWon: Number(info?.percentageWon),
      isFBA: !!info?.isFBA,
    }))
    .filter(s => Number.isFinite(s.percentageWon));

  const thirdParty = sellers.filter(s => !amazonSellerIds.has(s.sellerId));
  const distinctThirdPartyWinners = entries.length > 0 ? thirdParty.length : null;
  const topThirdParty = thirdParty.length
    ? thirdParty.reduce((best, s) => (s.percentageWon > best.percentageWon ? s : best))
    : null;

  const continuity = computeTopSellerContinuity(buyBoxSellerIdHistoryRaw, referenceEndMs, amazonSellerIds);

  // "Sufficient" = we have at least some real BB-stats AND at least a
  // couple weeks of continuity history to compute a meaningful percentage
  // (this bar applies equally to the single-event case — a 3-day-old lone
  // event is real evidence, per computeTopSellerContinuity, but still too
  // thin to trust on its own). "Rich" = a healthier amount of both, used
  // only to gate High confidence.
  const sufficient = entries.length > 0 && continuity.continuityWindowDays != null && continuity.continuityWindowDays >= 14;
  const rich = entries.length >= 3 && (continuity.continuityWindowDays || 0) >= 60;

  return {
    windowDays,
    sellers,
    distinctThirdPartyWinners,
    topThirdPartyPct: topThirdParty ? topThirdParty.percentageWon : null,
    topThirdPartySellerId: topThirdParty ? topThirdParty.sellerId : null,
    topSellerContinuityPct: continuity.topSellerContinuityPct,
    continuityWindowDays: continuity.continuityWindowDays,
    continuitySingleEvent: continuity.singleEvent,
    sufficient,
    rich,
  };
}

async function keepaErrorMessage(res: Response) {
  const txt = await res.text().catch(() => '');
  try {
    const j = JSON.parse(txt);
    return `Keepa HTTP ${res.status}: ${String(j?.error?.message || j?.error || j?.message || txt).slice(0, 240)}`;
  } catch { return `Keepa HTTP ${res.status}: ${txt.slice(0, 240)}`; }
}

const MARKETPLACE_IDS: Record<string, string> = {
  US: 'ATVPDKIKX0DER', CA: 'A2EUQ1WTGCTBG2', MX: 'A1AM78C64UM0Y8', BR: 'A2Q3Y263D00KWC',
};
const REGION_ENDPOINTS: Record<string, string> = {
  US: 'https://sellingpartnerapi-na.amazon.com', CA: 'https://sellingpartnerapi-na.amazon.com',
  MX: 'https://sellingpartnerapi-na.amazon.com', BR: 'https://sellingpartnerapi-na.amazon.com',
};

async function sha256(message: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
}

async function hmac(key: BufferSource, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSignatureKey(secretKey: string, dateStamp: string, region: string): Promise<ArrayBuffer> {
  const kDate = await hmac(new TextEncoder().encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, 'execute-api');
  return await hmac(kService, 'aws4_request');
}

async function getLwaAccessToken(refreshToken: string): Promise<string> {
  const clientId = Deno.env.get('LWA_CLIENT_ID') || Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('LWA_CLIENT_SECRET') || Deno.env.get('SPAPI_LWA_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('LWA credentials not configured');
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  if (!response.ok) throw new Error(`LWA token error: ${response.status}`);
  const data = await response.json();
  return data.access_token;
}

async function signedSpApiFetch(url: string, accessToken: string): Promise<Response> {
  const awsAccessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  if (!awsAccessKeyId || !awsSecretKey) throw new Error('AWS credentials not configured');
  const urlObj = new URL(url);
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const canonicalHeaders = `host:${urlObj.host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = ['GET', urlObj.pathname, urlObj.search.slice(1), canonicalHeaders, 'host;x-amz-access-token;x-amz-date', toHex(await sha256(''))].join('\n');
  const credentialScope = `${dateStamp}/${region}/execute-api/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, toHex(await sha256(canonicalRequest))].join('\n');
  const signature = toHex(await hmac(await getSignatureKey(awsSecretKey, dateStamp, region), stringToSign));
  return fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${awsAccessKeyId}/${credentialScope}, SignedHeaders=host;x-amz-access-token;x-amz-date, Signature=${signature}`,
      'x-amz-date': amzDate,
      'x-amz-access-token': accessToken,
      host: urlObj.host,
    },
  });
}

async function resolveSellerNames(
  admin: any,
  keepaKey: string,
  domainId: number,
  marketplace: string,
  sellerIds: string[],
): Promise<Record<string, { name: string; isAmazon: boolean }>> {
  const out: Record<string, { name: string; isAmazon: boolean }> = {};
  if (sellerIds.length === 0) return out;
  const unique = Array.from(new Set(sellerIds.filter(Boolean)));

  // Amazon shortcut
  for (const id of unique) {
    if (AMAZON_SELLER_IDS.has(id)) out[id] = { name: 'Amazon.com', isAmazon: true };
  }

  // Cache lookup
  const { data: cached } = await admin
    .from('keepa_seller_name_cache')
    .select('seller_id, business_name, storefront_name, is_amazon, expires_at')
    .in('seller_id', unique)
    .eq('marketplace', marketplace);
  const now = Date.now();
  const fresh = new Set<string>();
  for (const row of (cached || []) as any[]) {
    const valid = row.expires_at && new Date(row.expires_at).getTime() > now;
    if (valid) {
      out[row.seller_id] = {
        name: row.business_name || row.storefront_name || row.seller_id,
        isAmazon: !!row.is_amazon,
      };
      fresh.add(row.seller_id);
    }
  }

  const missing = unique.filter(id => !fresh.has(id) && !AMAZON_SELLER_IDS.has(id));
  if (missing.length === 0) return out;

  // Batch in groups of 100 (Keepa /seller supports comma-separated)
  const upserts: any[] = [];
  for (let i = 0; i < missing.length; i += 100) {
    const slice = missing.slice(i, i + 100);
    const url = new URL('https://api.keepa.com/seller');
    url.search = new URLSearchParams({
      key: keepaKey,
      domain: String(domainId),
      seller: slice.join(','),
    }).toString();

    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url.toString(), { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) {
        console.error('[mobile-scan-price-history] seller lookup failed', await keepaErrorMessage(res));
        continue;
      }
      const json = await res.json();
      const sellers = json?.sellers || {};
      for (const id of slice) {
        const s = sellers[id];
        const business = s?.sellerName || s?.businessName || null;
        const storefront = s?.storefrontName || s?.sellerName || null;
        const isAmazon = AMAZON_SELLER_IDS.has(id);
        const display = isAmazon ? 'Amazon.com' : (business || storefront || id);
        out[id] = { name: display, isAmazon };
        upserts.push({
          seller_id: id,
          marketplace,
          business_name: business,
          storefront_name: storefront,
          is_amazon: isAmazon,
          fetched_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        });
      }
    } catch (e) {
      console.error('[mobile-scan-price-history] seller fetch error', (e as Error).message);
    }
  }

  if (upserts.length > 0) {
    await admin.from('keepa_seller_name_cache').upsert(upserts, { onConflict: 'seller_id,marketplace' });
  }
  return out;
}

async function fetchLiveSpApiOffers(
  admin: any,
  keepaKey: string,
  domainId: number,
  userId: string,
  asin: string,
  marketplace: string,
) {
  const marketplaceId = MARKETPLACE_IDS[marketplace] || MARKETPLACE_IDS.US;
  const endpoint = REGION_ENDPOINTS[marketplace] || REGION_ENDPOINTS.US;
  const { data: authRows, error } = await admin
    .from('seller_authorizations')
    .select('refresh_token, seller_id, selling_partner_id, marketplace_id')
    .eq('user_id', userId);
  if (error || !authRows?.length) return null;
  const sellerAuth: any = authRows.find((a: any) => a.marketplace_id === marketplaceId) || authRows[0];
  const selfSellerIds = new Set([sellerAuth.seller_id, sellerAuth.selling_partner_id].filter(Boolean));
  const { data: inventoryRows } = await admin
    .from('inventory')
    .select('fnsku, available, reserved, inbound, source')
    .eq('user_id', userId)
    .eq('asin', asin)
    .limit(5);
  const hasLiveFbmInventory = (inventoryRows || []).some((row: any) =>
    row.source === 'amazon_sync_fbm'
    && (Number(row.available || 0) > 0 || Number(row.reserved || 0) > 0),
  );
  const accessToken = await getLwaAccessToken(sellerAuth.refresh_token);
  const url = `${endpoint}/products/pricing/v0/items/${asin}/offers?MarketplaceId=${marketplaceId}&ItemCondition=New`;
  const response = await signedSpApiFetch(url, accessToken);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`SP-API offers ${response.status}: ${data?.errors?.[0]?.message || 'failed'}`);

  const summary = data?.payload?.Summary || {};
  const rawOffers: any[] = Array.isArray(data?.payload?.Offers) ? data.payload.Offers : [];
  const offers = rawOffers
    .map((offer: any) => {
      const price = typeof offer.ListingPrice?.Amount === 'number' ? offer.ListingPrice.Amount : null;
      const shipping = typeof offer.Shipping?.Amount === 'number' ? offer.Shipping.Amount : 0;
      const sellerId = String(offer.SellerId || '');
      const isSelf = selfSellerIds.has(sellerId);
      // Do not infer FBA from local inventory presence. FBM inventory rows are stock truth,
      // and the old fallback turned real FBM self-offers into phantom FBA in the extension.
      const isFBA = offer.IsFulfilledByAmazon === true && !(isSelf && hasLiveFbmInventory);
      return {
        sellerId,
        isFBA,
        isPrime: isFBA,
        condition: 1,
        price,
        shipping,
        stock: null,
        isBuyBox: offer.IsBuyBoxWinner === true,
        landed: price != null ? price + shipping : null,
        sellerName: sellerId,
        isAmazon: AMAZON_SELLER_IDS.has(sellerId),
        isSelf,
      };
    })
    .filter((o: any) => o.sellerId && o.price != null && o.landed != null)
    .sort((a: any, b: any) => a.landed - b.landed);

  // Resolve names for ALL sellers (including self) via Keepa storefront lookup.
  // No hardcoded names — the UI shows the real storefront name; the YOU badge
  // (driven by isSelf) is what marks the current user's row.
  const nameMap = await resolveSellerNames(
    admin,
    keepaKey,
    domainId,
    marketplace,
    offers.map((o: any) => o.sellerId),
  );
  for (const offer of offers) {
    offer.sellerName = nameMap[offer.sellerId]?.name || offer.sellerName;
    offer.isAmazon = !!nameMap[offer.sellerId]?.isAmazon || offer.isAmazon;
  }

  const buyBox = offers.find((o: any) => o.isBuyBox);
  const buyBoxPrice = buyBox?.landed ?? summary?.BuyBoxPrices?.find?.((bp: any) => bp.condition === 'New')?.LandedPrice?.Amount ?? null;
  if (!buyBox && buyBoxPrice != null) {
    const match = offers.find((o: any) => Math.abs(Number(o.landed) - Number(buyBoxPrice)) < 0.01);
    if (match) match.isBuyBox = true;
  }
  return { offers, buyBoxPrice };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const KEEPA_KEY = Deno.env.get('KEEPA_API_KEY')?.trim();
    if (!KEEPA_KEY) return jsonResponse({ error: 'KEEPA_API_KEY not configured' }, 500);

    const auth = req.headers.get('Authorization');
    if (!auth?.startsWith('Bearer ')) return jsonResponse({ error: 'Unauthorized' }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const token = auth.replace('Bearer ', '').trim();
    const { data: userRes, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userRes?.user) return jsonResponse({ error: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const asin = String(body.asin || '').toUpperCase().trim();
    const marketplace = String(body.marketplace || 'US').toUpperCase();
    const range = String(body.range || '90'); // '90' | '180' | '365'
    const force = body.force === true;
    const days = range === '365' ? 365 : range === '180' ? 180 : 90;

    if (!/^[A-Z0-9]{10}$/.test(asin)) return jsonResponse({ error: 'Invalid ASIN' }, 400);

    const domainId = DOMAIN_MAP[marketplace] ?? 1;

    // Cache lookup (also kept as stale fallback if Keepa rate-limits us)
    const { data: cached } = await admin
      .from('keepa_price_history_cache')
      .select('*')
      .eq('asin', asin)
      .eq('marketplace', marketplace)
      .eq('days_range', days)
      .maybeSingle();

    const cacheFresh = cached && new Date(cached.expires_at).getTime() > Date.now();
    // Legacy rows written before the Private-Label Risk redesign lack these
    // two keys entirely. Never serve them as "fresh" just because they're
    // within the 24h TTL — that would strand users on the old snapshot
    // classifier for up to a day. Force one real Keepa refetch instead.
    const cacheHasPlData = !!(cached?.series?.sellerHistory && cached?.series?.buyBoxOwnership);

    if (!force && cacheFresh && cacheHasPlData) {
      let liveOffers = cached.offers;
      let liveBuyBoxPrice: number | null = null;
      try {
        const spLive = await fetchLiveSpApiOffers(admin, KEEPA_KEY, domainId, userRes.user.id, asin, marketplace);
        if (spLive) {
          liveOffers = { count: spLive.offers.length, list: spLive.offers };
          liveBuyBoxPrice = spLive.buyBoxPrice;
        }
      } catch (e) {
        console.warn('[mobile-scan-price-history] SP-API live offers failed, using cached offers', (e as Error).message);
      }
      const liveList = Array.isArray((liveOffers as any)?.list) ? (liveOffers as any).list : [];
      const liveFba = liveList.filter((o: any) => o.isFBA || o.isAmazon || o.isSelf).map((o: any) => Number(o.landed)).filter((v: number) => Number.isFinite(v) && v > 0);
      const liveFbm = liveList.filter((o: any) => !o.isFBA && !o.isAmazon && !o.isSelf).map((o: any) => Number(o.landed)).filter((v: number) => Number.isFinite(v) && v > 0);
      const liveSeries = {
        ...(cached.series || {}),
        buybox: appendCurrentPoint(cached.series?.buybox || [], liveBuyBoxPrice),
        newFba: appendCurrentPoint(cached.series?.newFba || [], liveFba.length ? Math.min(...liveFba) : null),
        newFbm: appendCurrentPoint(cached.series?.newFbm || [], liveFbm.length ? Math.min(...liveFbm) : null),
      };
      return jsonResponse({
        asin, marketplace, days, cached: true,
        series: liveSeries,
        offers: liveOffers,
        fetched_at: cached.fetched_at,
      });
    }

    // Helper: degrade gracefully when Keepa is unavailable (429 / timeout / 5xx).
    // Prefer stale cache + live SP-API offers over a hard error so the panel
    // never shows "All sellers retrieval failed" when we have ANY usable data.
    const degradeFallback = async (reason: string) => {
      console.warn('[mobile-scan-price-history] degrading Keepa response:', reason);
      let spOffers: any = null;
      let spBuyBox: number | null = null;
      try {
        const spLive = await fetchLiveSpApiOffers(admin, KEEPA_KEY, domainId, userRes.user.id, asin, marketplace);
        if (spLive) {
          spOffers = { count: spLive.offers.length, list: spLive.offers };
          spBuyBox = spLive.buyBoxPrice;
        }
      } catch (e) {
        console.warn('[mobile-scan-price-history] degrade: SP-API also failed', (e as Error).message);
      }
      if (cached) {
        const series = {
          ...(cached.series || {}),
          buybox: appendCurrentPoint(cached.series?.buybox || [], spBuyBox),
        };
        return jsonResponse({
          asin, marketplace, days, cached: true, degraded: true, degraded_reason: reason,
          series,
          offers: spOffers || cached.offers,
          fetched_at: cached.fetched_at,
        });
      }
      if (spOffers && spOffers.list.length > 0) {
        return jsonResponse({
          asin, marketplace, days, cached: false, degraded: true, degraded_reason: reason,
          series: { buybox: appendCurrentPoint([], spBuyBox) },
          offers: spOffers,
          fetched_at: new Date().toISOString(),
        });
      }
      return jsonResponse({ error: reason }, 502);
    };

    const url = new URL('https://api.keepa.com/product');
    url.search = new URLSearchParams({
      key: KEEPA_KEY,
      domain: String(domainId),
      asin,
      stats: String(days),
      history: '1',
      offers: '20',
      buybox: '1',
    }).toString();

    const ctrl = new AbortController();
    const tId = setTimeout(() => ctrl.abort(), 15000);
    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: ctrl.signal });
    } catch (e) {
      clearTimeout(tId);
      const aborted = (e as Error)?.name === 'AbortError';
      return await degradeFallback(aborted ? 'Keepa timeout' : `Keepa fetch failed: ${(e as Error).message}`);
    }
    clearTimeout(tId);
    if (!res.ok) {
      const msg = await keepaErrorMessage(res);
      // 429 / 5xx: serve stale cache or SP-API rather than hard-failing the panel.
      if (res.status === 429 || res.status >= 500) {
        return await degradeFallback(msg);
      }
      return jsonResponse({ error: msg }, 502);
    }

    const json = await res.json();
    const product = json?.products?.[0];
    if (!product) return await degradeFallback('No Keepa product data');

    const csv: (number[] | null)[] = product.csv || [];

    // Private-Label Risk data — parsed from fields already present in this
    // SAME Keepa response (stats + history + buybox were already requested
    // above for the price chart), so this adds zero additional Keepa cost.
    const sellerHistory = summarizeCountSeries(parseSeries(csv[IDX_COUNT_NEW], days, false), days);
    const buyBoxSellerIdHistory: unknown[] = Array.isArray(product.buyBoxSellerIdHistory) ? product.buyBoxSellerIdHistory : [];
    const buyBoxOwnership = computeBuyBoxOwnership(
      product.stats?.buyBoxStats,
      buyBoxSellerIdHistory,
      days,
      AMAZON_SELLER_IDS,
      Date.now(),
    );

    const series = {
      amazon: downsample(parseSeries(csv[IDX_AMAZON], days, true), days),
      buybox: downsample(parseSeries(csv[IDX_BUYBOX], days, true), days),
      newPrice: downsample(parseSeries(csv[IDX_NEW], days, true), days),
      newFba: downsample(parseSeries(csv[IDX_NEW_FBA], days, true), days),
      newFbm: downsample(parseSeries(csv[IDX_NEW_FBM_SHIP], days, true), days),
      bsr: downsample(parseSeries(csv[IDX_SALES_RANK], days, false), days),
      // Nested here (not a new DB column) so the existing JSONB `series`
      // cache column absorbs them with no migration required.
      sellerHistory,
      buyBoxOwnership,
    };

    // Build live offers from product.offers
    const rawOffers: any[] = Array.isArray(product.offers) ? product.offers : [];
    type Offer = {
      sellerId: string;
      isFBA: boolean;
      isPrime: boolean;
      condition: number;
      price: number | null;
      shipping: number | null;
      stock: number | null;
      isBuyBox: boolean;
    };
    const lastBBSeller = buyBoxSellerIdHistory.length > 1
      ? String(buyBoxSellerIdHistory[buyBoxSellerIdHistory.length - 1])
      : null;

    // Filter stale offers: Keepa returns the union of offers ever seen.
    // Only offers seen within the last 7 days are considered "live".
    // Keepa time = minutes since 2011-01-01 UTC.
    const nowKeepaMin = Math.floor((Date.now() - KEEPA_EPOCH_MS_CONST) / 60000);
    const LIVE_WINDOW_MIN = 7 * 24 * 60; // 7 days

    const offers: Offer[] = rawOffers
      .filter(o => o && (o.condition === 1 || o.condition === 0 || o.condition == null)) // New only
      .filter(o => {
        const ls = Number(o.lastSeen);
        // If lastSeen is missing, keep (Keepa sometimes omits); otherwise require recency.
        if (!Number.isFinite(ls) || ls <= 0) return true;
        return (nowKeepaMin - ls) <= LIVE_WINDOW_MIN;
      })
      .map(o => {
        // o.offerCSV alternates [t, price, shipping] triples (newest last)
        const arr: number[] = Array.isArray(o.offerCSV) ? o.offerCSV : [];
        let price: number | null = null;
        let shipping: number | null = null;
        if (arr.length >= 3) {
          const p = arr[arr.length - 2];
          const s = arr[arr.length - 1];
          if (typeof p === 'number' && p > 0) price = p / 100;
          if (typeof s === 'number' && s >= 0) shipping = s / 100;
        }
        // Strict FBA: Keepa flags many FBM offers with isFBA=true if seller has any FBA SKUs.
        // True FBA offers are ALWAYS Prime-eligible. Require both flags.
        const strictFBA = !!o.isFBA && !!o.isPrime;
        return {
          sellerId: String(o.sellerId || ''),
          isFBA: strictFBA,
          isPrime: !!o.isPrime,
          condition: Number(o.condition ?? 1),
          price,
          shipping,
          stock: Number.isFinite(Number(o.stockCSV?.at?.(-1))) ? Number(o.stockCSV.at(-1)) : null,
          isBuyBox: lastBBSeller != null && String(o.sellerId) === lastBBSeller,
        } as Offer;
      })
      .filter(o => o.sellerId && o.price != null);


    // Resolve seller names
    const sellerIds = offers.map(o => o.sellerId);
    const nameMap = await resolveSellerNames(admin, KEEPA_KEY, domainId, marketplace, sellerIds);

    const enrichedOffers = offers
      .map(o => {
        const total = (o.price ?? 0) + (o.shipping ?? 0);
        const meta = nameMap[o.sellerId];
        return {
          ...o,
          landed: total,
          sellerName: meta?.name || o.sellerId,
          isAmazon: !!meta?.isAmazon,
        };
      })
      .sort((a, b) => a.landed - b.landed);

    let finalOffers = enrichedOffers;
    let liveBuyBoxPrice: number | null = null;
    try {
      const spLive = await fetchLiveSpApiOffers(admin, KEEPA_KEY, domainId, userRes.user.id, asin, marketplace);
      if (spLive) {
        finalOffers = spLive.offers;
        liveBuyBoxPrice = spLive.buyBoxPrice;
      }
    } catch (e) {
      console.warn('[mobile-scan-price-history] SP-API live offers failed, using Keepa offers', (e as Error).message);
    }

    const finalFba = finalOffers.filter((o: any) => o.isFBA || o.isAmazon || o.isSelf).map((o: any) => Number(o.landed)).filter((v: number) => Number.isFinite(v) && v > 0);
    const finalFbm = finalOffers.filter((o: any) => !o.isFBA && !o.isAmazon && !o.isSelf).map((o: any) => Number(o.landed)).filter((v: number) => Number.isFinite(v) && v > 0);
    series.buybox = appendCurrentPoint(series.buybox, liveBuyBoxPrice);
    series.newFba = appendCurrentPoint(series.newFba, finalFba.length ? Math.min(...finalFba) : null);
    series.newFbm = appendCurrentPoint(series.newFbm, finalFbm.length ? Math.min(...finalFbm) : null);

    const offersPayload = {
      count: finalOffers.length,
      list: finalOffers,
    };

    // Cache
    await admin.from('keepa_price_history_cache').upsert({
      asin, marketplace, days_range: days,
      series, offers: offersPayload,
      fetched_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: 'asin,marketplace,days_range' });

    return jsonResponse({
      asin, marketplace, days, cached: false,
      series, offers: offersPayload,
      fetched_at: new Date().toISOString(),
    });
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
