// reconcile-intl-estimates
// ----------------------------------------------------------------------------
// Targeted reconciler for the CA / MX / BR non-US estimate lifecycle bug.
//
// Problem this fixes (see chat 2026-06-02):
//   Non-US orders arrive Pending, are written with a Listings-API / Pricing-API
//   estimate stored in NATIVE currency on `estimated_price`. Once the order
//   settles, the real `ItemPrice` from the Orders API should replace the
//   estimate and write `sold_price` (USD). In some past code paths the row
//   stayed forever with the estimate (e.g. order 702-4519782-1142614 showed
//   CA$ 59.64 instead of the real CA$ 34.51), inflating Sales Report totals.
//
// Scope (strict):
//   - marketplace IN ('CA','MX','BR')
//   - price_source LIKE 'listings_api_%' OR 'pricing_api_%'
//   - sold_price IS NULL OR sold_price = 0   (never overwrite a real price)
//   - status NOT in cancelled set            (cancelled rows are reported, not converted)
//
// Modes:
//   { dry_run: true }   -> return per-row report, mutate nothing
//   { dry_run: false }  -> apply updates (capped at `max_rows`, default 200)
//   { bulk_backfill: true } lifts the cap so the user-approved final pass can drain
//     everything in one go.
//
// Currency contract (mem://architecture/sales/currency-contract-v1):
//   - `sold_price` is USD (native flip pending; out of scope here).
//   - `estimated_price` is NATIVE marketplace currency for non-US rows.
//   - We convert ItemPrice (Amazon returns native CurrencyCode) -> USD using
//     `fx_rates` (same source the rest of the platform uses) — exactly once.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { exchangeLwaToken } from '../_shared/lwa-token.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ---------------------------------------------------------------------------
// AWS SigV4 (copied verbatim from reconcile-pending-prices for parity)
// ---------------------------------------------------------------------------
async function sha256(message: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message) as any);
}
async function hmac(key: any, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function getSignatureKey(secretKey: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const kDate = await hmac(enc.encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return await hmac(kService, 'aws4_request');
}
async function signRequest(method: string, url: string, body: string, accessToken: string): Promise<Record<string, string>> {
  const accessKeyId = Deno.env.get('AWS_ACCESS_KEY_ID')!;
  const secretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY')!;
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  const service = 'execute-api';
  const u = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = toHex(await sha256(body));
  const canonicalHeaders = `host:${u.host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  const canonicalRequest = [method, u.pathname, u.search.slice(1), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credScope, toHex(await sha256(canonicalRequest))].join('\n');
  const signingKey = await getSignatureKey(secretKey, dateStamp, region, service);
  const signature = toHex(await hmac(signingKey, stringToSign));
  return {
    'Authorization': `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': amzDate,
    'x-amz-access-token': accessToken,
    'host': u.host,
  };
}

// LWA token exchange is delegated to the shared `exchangeLwaToken` helper
// (`supabase/functions/_shared/lwa-token.ts`) so the per-user stored LWA app
// + multi-app fallback chain are honored. Direct env-only token exchange
// (LWA 400 invalid_client) was causing every CA/MX/BR refresh token to fail
// during the first dry-run of this function.

// ---------------------------------------------------------------------------
// FX (mirrors sync-sales-orders fetchFxRates / convertToUsd)
// ---------------------------------------------------------------------------
async function fetchFxRates(supabase: any): Promise<Record<string, number>> {
  try {
    const { data } = await supabase.from('fx_rates').select('quote, rate').eq('base', 'USD');
    const rates: Record<string, number> = { USD: 1 };
    for (const row of (data || [])) rates[row.quote] = Number(row.rate);
    if (!rates.CAD) rates.CAD = 1.38;
    if (!rates.MXN) rates.MXN = 18.0;
    if (!rates.BRL) rates.BRL = 5.4;
    return rates;
  } catch {
    return { USD: 1, CAD: 1.38, MXN: 18.0, BRL: 5.4 };
  }
}
function convertToUsd(amount: number, currency: string, fx: Record<string, number>): number {
  if (!amount || amount <= 0) return 0;
  if (currency === 'USD' || !currency) return Math.round(amount * 100) / 100;
  const rate = fx[currency];
  if (!rate || rate === 0) return Math.round(amount * 100) / 100;
  return Math.round((amount / rate) * 100) / 100;
}

const SPAPI_HOSTS: Record<string, string> = {
  CA: 'sellingpartnerapi-na.amazon.com',
  MX: 'sellingpartnerapi-na.amazon.com',
  BR: 'sellingpartnerapi-na.amazon.com',
};
const MARKETPLACE_ID: Record<string, string> = {
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',
};

const CANCELLED_STATUSES = new Set([
  'canceled', 'cancelled', 'Canceled', 'Cancelled',
  'CANCELED', 'CANCELLED',
]);
function isCancelledStatus(s: string | null | undefined): boolean {
  if (!s) return false;
  return CANCELLED_STATUSES.has(s) || s.toLowerCase().startsWith('cancel');
}

interface DryRunRow {
  user_id: string;
  order_id: string;
  asin: string;
  marketplace: string;
  old_price_source: string | null;
  old_estimated_price_native: number;
  old_estimated_currency: string;
  real_item_price_native: number | null;
  real_currency: string | null;
  converted_usd: number | null;
  old_order_status: string | null;
  new_order_status: string | null;
  will_update: boolean;
  reason: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const startedAt = Date.now();
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* no body */ }

    // ----- caller auth (matches reconcile-pending-prices) -----
    const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
    const callerSecret = req.headers.get('x-internal-secret');
    const hasJwt = !!req.headers.get('authorization');
    if (internalSecret && !hasJwt && callerSecret !== internalSecret) {
      return new Response(JSON.stringify({ ok: false, error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const dryRun: boolean = body?.dry_run !== false; // default DRY-RUN to prevent accidents
    const bulkBackfill: boolean = body?.bulk_backfill === true;
    const userFilter: string | null = body?.user_id ? String(body.user_id) : null;
    const orderFilter: string | null = body?.order_id ? String(body.order_id) : null;
    const marketplaceFilter: string | null = body?.marketplace ? String(body.marketplace).toUpperCase() : null;
    const maxRows: number = bulkBackfill
      ? Number(body?.max_rows || 1000)
      : Math.min(Number(body?.max_rows || 200), 500);

    // ----- target rows -----
    let q = supabase
      .from('sales_orders')
      .select('id, user_id, order_id, asin, marketplace, order_date, quantity, sold_price, estimated_price, price_source, order_status, status')
      .in('marketplace', ['CA', 'MX', 'BR'])
      .or('price_source.like.listings_api_%,price_source.like.pricing_api_%')
      .or('sold_price.is.null,sold_price.eq.0')
      .limit(maxRows);
    if (userFilter) q = q.eq('user_id', userFilter);
    if (orderFilter) q = q.eq('order_id', orderFilter);
    if (marketplaceFilter) q = q.eq('marketplace', marketplaceFilter);

    const { data: candidates, error: fetchErr } = await q;
    if (fetchErr) throw fetchErr;

    if (!candidates || candidates.length === 0) {
      return new Response(JSON.stringify({
        ok: true, mode: dryRun ? 'dry_run' : 'apply', processed: 0,
        message: 'No matching rows', elapsed_ms: Date.now() - startedAt,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const fxRates = await fetchFxRates(supabase);
    console.log(`[RECON_INTL] ${dryRun ? 'DRY_RUN' : 'APPLY'} candidates=${candidates.length} fx CAD=${fxRates.CAD} MXN=${fxRates.MXN} BRL=${fxRates.BRL}`);

    // Group by user -> marketplace
    const byUser = new Map<string, typeof candidates>();
    for (const r of candidates) {
      const a = byUser.get(r.user_id) || [];
      a.push(r);
      byUser.set(r.user_id, a);
    }

    const report: DryRunRow[] = [];
    let updated = 0, cancelledMarked = 0, skipped = 0, errors = 0;

    for (const [userId, rows] of byUser.entries()) {
      const { data: auths } = await supabase
        .from('seller_authorizations')
        .select('refresh_token, marketplace_id')
        .eq('user_id', userId);
      if (!auths || auths.length === 0) {
        for (const r of rows) {
          report.push(buildSkipReport(r, 'no_seller_authorization'));
          skipped++;
        }
        continue;
      }

      const byMp = new Map<string, typeof rows>();
      for (const r of rows) {
        const mp = (r.marketplace || '').toUpperCase();
        if (!SPAPI_HOSTS[mp]) { skipped++; report.push(buildSkipReport(r, `unsupported_marketplace_${mp}`)); continue; }
        const a = byMp.get(mp) || [];
        a.push(r);
        byMp.set(mp, a);
      }

      for (const [mp, mpRows] of byMp.entries()) {
        const mpId = MARKETPLACE_ID[mp];
        const auth = auths.find(a => a.marketplace_id === mpId) || auths[0];
        if (!auth?.refresh_token) {
          for (const r of mpRows) { report.push(buildSkipReport(r, `no_refresh_token_${mp}`)); skipped++; }
          continue;
        }
        let token: string;
        try {
          token = await exchangeLwaToken(auth.refresh_token, supabase, userId);
        } catch (e) {
          console.warn(`[RECON_INTL] LWA failed user=${userId} mp=${mp}: ${(e as Error).message}`);
          for (const r of mpRows) { report.push(buildSkipReport(r, `lwa_failed_${mp}`)); errors++; }
          continue;
        }

        const host = SPAPI_HOSTS[mp];
        const uniqueOrders = Array.from(new Set(mpRows.map(r => r.order_id)));

        for (const orderId of uniqueOrders) {
          const rowsForOrder = mpRows.filter(r => r.order_id === orderId);

          // Short-circuit: if every DB row for this order is already marked
          // cancelled, trust DB and skip the SP-API status round-trip. Saves
          // ~1.5s per order which lets the full dry-run complete inside the
          // edge-function/HTTP timeout.
          const dbAllCancelled = rowsForOrder.every(r =>
            isCancelledStatus(r.order_status) || isCancelledStatus(r.status)
          );

          let liveStatus: string | null = null;
          if (dbAllCancelled) {
            liveStatus = rowsForOrder[0].order_status || 'Canceled';
          } else {
            // 1) Fetch live order status (single /orders/{id} call)
            try {
              const statusUrl = `https://${host}/orders/v0/orders/${orderId}`;
              const sHeaders = await signRequest('GET', statusUrl, '', token);
              const sResp = await fetch(statusUrl, { method: 'GET', headers: { ...sHeaders, 'Content-Type': 'application/json' } });
              if (sResp.status === 429) { await sleep(2000); continue; }
              if (sResp.ok) {
                const sData = await sResp.json();
                liveStatus = sData?.payload?.OrderStatus || null;
              } else {
                await sResp.text().catch(() => '');
              }
            } catch (e) {
              console.warn(`[RECON_INTL] status fetch failed ${orderId}: ${(e as Error).message}`);
            }
            await sleep(350);
          }

          // 2) Handle cancelled rows: skip price write, just mark status
          if (isCancelledStatus(liveStatus)) {
            for (const r of rowsForOrder) {
              report.push({
                user_id: userId,
                order_id: orderId,
                asin: r.asin,
                marketplace: mp,
                old_price_source: r.price_source,
                old_estimated_price_native: Number(r.estimated_price || 0),
                old_estimated_currency: nativeCurrencyFor(mp),
                real_item_price_native: null,
                real_currency: null,
                converted_usd: null,
                old_order_status: r.order_status || r.status || null,
                new_order_status: liveStatus,
                will_update: !dryRun,
                reason: 'cancelled_in_orders_api_no_price_write',
              });
              if (!dryRun) {
                const { error: updErr } = await supabase
                  .from('sales_orders')
                  .update({
                    status: 'cancelled',
                    order_status: liveStatus || 'Canceled',
                    status_source: 'reconcile-intl-estimates',
                    last_status_sync_at: new Date().toISOString(),
                    needs_price_enrich: false,
                    price_confidence: 'CONFIRMED', // confirmed cancelled, not pending
                  })
                  .eq('id', r.id);
                if (updErr) { errors++; console.error(`[RECON_INTL] cancel-mark failed ${orderId}: ${updErr.message}`); }
                else cancelledMarked++;
              }
            }
            continue;
          }

          // 3) Fetch live order items for real ItemPrice
          let items: any[] = [];
          try {
            const itemsUrl = `https://${host}/orders/v0/orders/${orderId}/orderItems`;
            const iHeaders = await signRequest('GET', itemsUrl, '', token);
            const iResp = await fetch(itemsUrl, { method: 'GET', headers: { ...iHeaders, 'Content-Type': 'application/json' } });
            if (iResp.status === 429) { await sleep(2000); continue; }
            if (!iResp.ok) {
              await iResp.text().catch(() => '');
              for (const r of rowsForOrder) {
                report.push(buildSkipReport(r, `order_items_http_${iResp.status}`, liveStatus));
                skipped++;
              }
              await sleep(350);
              continue;
            }
            const data = await iResp.json();
            items = (data?.payload?.OrderItems || []) as any[];
          } catch (e) {
            for (const r of rowsForOrder) {
              report.push(buildSkipReport(r, `order_items_exception:${(e as Error).message}`, liveStatus));
              errors++;
            }
            await sleep(350);
            continue;
          }
          await sleep(350);

          // 4) Match items to DB rows
          for (const r of rowsForOrder) {
            const item = items.find((i: any) => i?.ASIN === r.asin) || items[0];
            const ipObj = item?.ItemPrice;
            const itemPriceNative = ipObj ? Number(ipObj.Amount) : NaN;
            const currency = ipObj?.CurrencyCode || nativeCurrencyFor(mp);
            const qty = Math.max(Number(item?.QuantityOrdered) || Number(r.quantity) || 1, 1);

            if (!Number.isFinite(itemPriceNative) || itemPriceNative <= 0) {
              report.push({
                user_id: userId,
                order_id: orderId,
                asin: r.asin,
                marketplace: mp,
                old_price_source: r.price_source,
                old_estimated_price_native: Number(r.estimated_price || 0),
                old_estimated_currency: nativeCurrencyFor(mp),
                real_item_price_native: null,
                real_currency: currency,
                converted_usd: null,
                old_order_status: r.order_status || r.status || null,
                new_order_status: liveStatus,
                will_update: false,
                reason: 'orders_api_still_no_itemprice',
              });
              skipped++;
              continue;
            }

            const perUnitNative = itemPriceNative / qty;
            const perUnitUsd = convertToUsd(perUnitNative, currency, fxRates);
            const totalUsd = convertToUsd(itemPriceNative, currency, fxRates);

            const newStatus = mapOrderStatus(liveStatus);
            report.push({
              user_id: userId,
              order_id: orderId,
              asin: r.asin,
              marketplace: mp,
              old_price_source: r.price_source,
              old_estimated_price_native: Number(r.estimated_price || 0),
              old_estimated_currency: nativeCurrencyFor(mp),
              real_item_price_native: perUnitNative,
              real_currency: currency,
              converted_usd: perUnitUsd,
              old_order_status: r.order_status || r.status || null,
              new_order_status: liveStatus,
              will_update: !dryRun,
              reason: 'orders_api_itemprice_reconciled',
            });

            if (!dryRun) {
              const { error: updErr } = await supabase
                .from('sales_orders')
                .update({
                  sold_price: perUnitUsd,
                  item_price: perUnitUsd,
                  total_sale_amount: totalUsd,
                  estimated_price: null,
                  price_source: `orders_api_${mp.toLowerCase()}_reconciled`,
                  price_confidence: 'CONFIRMED',
                  price_calc_mode: 'orders_api',
                  needs_price_enrich: false,
                  pending_enrich_attempts: 0,
                  pending_enrich_last_error: null,
                  locked_est_price: null,
                  locked_from: null,
                  price_locked_at: null,
                  status: newStatus || r.status || 'shipped',
                  order_status: liveStatus || r.order_status,
                  status_source: 'reconcile-intl-estimates',
                  last_status_sync_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                })
                .eq('id', r.id);
              if (updErr) { errors++; console.error(`[RECON_INTL] update failed ${orderId}/${r.asin}: ${updErr.message}`); }
              else updated++;
            }
          }
        }
      }
    }

    // Quick aggregate by marketplace for the dry-run summary
    const byMpAgg: Record<string, { total: number; will_update: number; cancelled: number; no_price: number; usd_recovered: number; usd_was_overstated: number }> = {};
    for (const r of report) {
      const m = r.marketplace;
      byMpAgg[m] ||= { total: 0, will_update: 0, cancelled: 0, no_price: 0, usd_recovered: 0, usd_was_overstated: 0 };
      byMpAgg[m].total++;
      if (r.reason === 'cancelled_in_orders_api_no_price_write') byMpAgg[m].cancelled++;
      if (r.reason === 'orders_api_still_no_itemprice') byMpAgg[m].no_price++;
      if (r.will_update || (dryRun && r.reason === 'orders_api_itemprice_reconciled')) {
        byMpAgg[m].will_update++;
        if (r.converted_usd != null) {
          byMpAgg[m].usd_recovered += r.converted_usd;
          // overstatement = (old native estimate / fx) - real USD
          const fx = fxRates[nativeCurrencyFor(m)] || 1;
          const oldUsd = r.old_estimated_price_native / fx;
          byMpAgg[m].usd_was_overstated += Math.max(oldUsd - r.converted_usd, 0);
        }
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      mode: dryRun ? 'dry_run' : 'apply',
      bulk_backfill: bulkBackfill,
      candidates: candidates.length,
      updated,
      cancelled_marked: cancelledMarked,
      skipped,
      errors,
      by_marketplace: byMpAgg,
      report, // full per-row report (always returned, even in apply mode)
      elapsed_ms: Date.now() - startedAt,
    }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[RECON_INTL] Fatal:', e);
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

function nativeCurrencyFor(mp: string): string {
  return mp === 'CA' ? 'CAD' : mp === 'MX' ? 'MXN' : mp === 'BR' ? 'BRL' : 'USD';
}
function mapOrderStatus(s: string | null): string | null {
  if (!s) return null;
  const l = s.toLowerCase();
  if (l.includes('cancel')) return 'cancelled';
  if (l === 'shipped') return 'shipped';
  if (l === 'unshipped' || l === 'partiallyshipped') return 'unshipped';
  if (l === 'pending') return 'pending';
  return l;
}
function buildSkipReport(r: any, reason: string, liveStatus: string | null = null): DryRunRow {
  return {
    user_id: r.user_id,
    order_id: r.order_id,
    asin: r.asin,
    marketplace: r.marketplace,
    old_price_source: r.price_source,
    old_estimated_price_native: Number(r.estimated_price || 0),
    old_estimated_currency: nativeCurrencyFor(r.marketplace),
    real_item_price_native: null,
    real_currency: null,
    converted_usd: null,
    old_order_status: r.order_status || r.status || null,
    new_order_status: liveStatus,
    will_update: false,
    reason,
  };
}
function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}
