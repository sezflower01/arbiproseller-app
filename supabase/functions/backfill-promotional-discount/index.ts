// Backfill `sales_orders.promotion_discount*` for the last N days by re-reading
// Amazon Orders API GetOrderItems for orders that don't have promo captured yet.
// SAFE: only writes the 5 promotion_discount_* columns + updated_at. Never
// touches sold_price / total_sale_amount / fees / status / anything else.
//
// Scope: NA region marketplaces only (US, CA, MX, BR) — covers the user-reported
// MX deductions. EU/FE backfill can be added later if needed.
//
// Usage (admin only): POST { user_id?: string, days?: number, dry_run?: boolean, max_orders?: number }
import { maybeFirePromoTripwire } from '../_shared/promo-tripwire.ts';

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { exchangeLwaToken } from '../_shared/lwa-token.ts';
import { signRequest } from '../_shared/sp-api-sigv4.ts';

const NA_MARKETPLACES = new Set(['US', 'CA', 'MX', 'BR']);
const NA_ENDPOINT = 'https://sellingpartnerapi-na.amazon.com';

async function fetchOrderItems(accessToken: string, orderId: string): Promise<any[]> {
  const url = `${NA_ENDPOINT}/orders/v0/orders/${orderId}/orderItems`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const headers = await signRequest('GET', url, '', accessToken);
      const res = await fetch(url, { headers });
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, Math.min(8000, 1500 * attempt)));
        continue;
      }
      if (!res.ok) {
        console.warn(`getOrderItems ${orderId} -> ${res.status}`);
        return [];
      }
      const data = await res.json();
      return data.payload?.OrderItems || [];
    } catch (e: any) {
      console.warn(`getOrderItems ${orderId} error: ${e?.message || e}`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  return [];
}

async function getUserAccessToken(admin: any, userId: string): Promise<string | null> {
  const { data, error } = await admin.rpc('get_spapi_credentials_decrypted', { p_user_id: userId });
  if (error) {
    console.warn(`decrypt creds for ${userId}:`, error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  const refresh = row?.refresh_token;
  if (!refresh) return null;
  try {
    return await exchangeLwaToken(refresh, admin, userId);
  } catch (e: any) {
    console.warn(`token exchange for ${userId}: ${e?.message || e}`);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json().catch(() => ({}));
    const days = Math.min(Math.max(Number(body.days) || 90, 1), 180);
    const dryRun = Boolean(body.dry_run);
    const maxOrders = Math.min(Number(body.max_orders) || 2000, 5000);
    const targetUserId: string | null = body.user_id || null;
    const orderIds: string[] | null = Array.isArray(body.order_ids) && body.order_ids.length > 0 ? body.order_ids : null;
    const marketplaces: string[] = Array.isArray(body.marketplaces) && body.marketplaces.length > 0
      ? body.marketplaces.filter((m: string) => NA_MARKETPLACES.has(m))
      : Array.from(NA_MARKETPLACES);

    const sinceISO = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

    let q = admin
      .from('sales_orders')
      .select('id, user_id, order_id, marketplace, sold_price, quantity, asin')
      .gte('order_date', sinceISO)
      .in('marketplace', marketplaces)
      .is('promotion_discount_captured_at', null)
      .not('order_id', 'is', null)
      .not('order_id', 'like', '%-REFUND')
      .gt('sold_price', 0)
      .order('order_date', { ascending: false })
      .limit(maxOrders);
    if (targetUserId) q = q.eq('user_id', targetUserId);
    if (orderIds) q = q.in('order_id', orderIds);

    const { data: rows, error } = await q;
    if (error) throw error;

    if (!rows || rows.length === 0) {
      return new Response(JSON.stringify({ ok: true, message: 'nothing to backfill', candidates: 0, days, sinceISO }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Group by (user_id, order_id) to call Amazon once per order.
    const byUser = new Map<string, Map<string, typeof rows>>();
    for (const r of rows) {
      const u = byUser.get(r.user_id) || new Map();
      const arr = u.get(r.order_id) || [];
      arr.push(r);
      u.set(r.order_id, arr);
      byUser.set(r.user_id, u);
    }

    let touched = 0;
    let updated = 0;
    let ordersWithPromo = 0;
    const examples: Array<{ order_id: string; marketplace: string; promo: number; currency: string }> = [];

    for (const [uid, orderMap] of byUser) {
      const token = dryRun ? '' : await getUserAccessToken(admin, uid);
      if (!dryRun && !token) {
        console.warn(`skip user ${uid}: no access token`);
        continue;
      }
      for (const [orderId, group] of orderMap) {
        touched++;
        let promoSum = 0;
        let currency = 'USD';
        if (!dryRun) {
          const items = await fetchOrderItems(token!, orderId);
          for (const it of items) {
            const pd = parseFloat(it?.PromotionDiscount?.Amount || '0') || 0;
            if (pd > 0) {
              promoSum += pd;
              if (it?.PromotionDiscount?.CurrencyCode) currency = it.PromotionDiscount.CurrencyCode;
            }
          }
          // Pace ~1 req/sec — Amazon Order Items quota is tight.
          await new Promise(r => setTimeout(r, 300));
        }

        // Always stamp the rows (zero promo => "checked, none found").
        const patch: any = {
          promotion_discount: promoSum,
          promotion_discount_native: promoSum,
          promotion_discount_currency: currency,
          promotion_discount_source: 'backfill',
          promotion_discount_captured_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (!dryRun) {
          const ids = group.map(g => g.id);
          const { error: upErr } = await admin.from('sales_orders').update(patch).in('id', ids);
          if (upErr) {
            console.warn(`update fail ${orderId}: ${upErr.message}`);
            continue;
          }
          updated += ids.length;
          if (promoSum > 0) {
            ordersWithPromo++;
            if (examples.length < 20) {
              examples.push({ order_id: orderId, marketplace: group[0].marketplace, promo: promoSum, currency });
            }
            maybeFirePromoTripwire({
              userId: uid,
              orderId,
              asin: group[0].asin,
              marketplace: group[0].marketplace,
              promotionDiscount: promoSum,
              currency,
              sourceFunction: 'backfill-promotional-discount',
            });
          }
        }
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      days,
      sinceISO,
      candidates: rows.length,
      orders_touched: touched,
      rows_updated: updated,
      orders_with_promo: ordersWithPromo,
      examples,
      dry_run: dryRun,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('backfill error:', e?.message || e);
    return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
