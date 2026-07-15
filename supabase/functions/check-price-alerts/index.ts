// CHECK-PRICE-ALERTS
// Hourly cron worker (see migration 20260715195131_add_price_alerts.sql).
// For every active price alert, fetches the current Amazon price from Keepa
// (one minimal /product call per DISTINCT asin+marketplace, shared across
// however many users are tracking the same listing) and fires the
// price-alert-fired email once, then deactivates that alert.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const DOMAIN_MAP: Record<string, number> = {
  US: 1, GB: 2, DE: 3, FR: 4, JP: 5, CA: 6, IT: 8, ES: 9, IN: 10, MX: 11, BR: 12,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// Current Amazon price (cents -> dollars), from the last valid point in
// Keepa's Amazon-price CSV series (csv[0]). No stats/history/offers/buybox
// requested — this is the cheapest possible Keepa call for "what does
// Amazon charge right now".
function currentAmazonPrice(csv: (number[] | null)[] | undefined): number | null {
  const series = csv?.[0];
  if (!Array.isArray(series) || series.length < 2) return null;
  for (let i = series.length - 2; i >= 0; i -= 2) {
    const v = series[i + 1];
    if (typeof v === 'number' && v >= 0) return v / 100;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  // Same auth gate as sync-inventory-report-all: internal secret (cron) or
  // service-role bearer (manual/internal trigger). Never open to the public
  // — this reads every user's active alerts and spends Keepa tokens.
  const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const providedSecret = req.headers.get('x-internal-secret') || '';
  const authHeader = req.headers.get('Authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const okSecret = !!internalSecret && providedSecret === internalSecret;
  const okServiceBearer = !!serviceRoleKey && bearer === serviceRoleKey;
  if (!okSecret && !okServiceBearer) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const KEEPA_KEY = Deno.env.get('KEEPA_API_KEY')?.trim();
    if (!KEEPA_KEY) return jsonResponse({ error: 'KEEPA_API_KEY not configured' }, 500);
    const admin = createClient(SUPABASE_URL, serviceRoleKey);

    const { data: alerts, error } = await admin
      .from('price_alerts')
      .select('id, asin, marketplace, target_price, direction, notify_email')
      .eq('status', 'active')
      .limit(500);
    if (error) return jsonResponse({ error: error.message }, 500);
    if (!alerts?.length) return jsonResponse({ ok: true, checked: 0, fired: 0 });

    // Group by asin+marketplace so N alerts on the same listing cost ONE
    // Keepa call, not N.
    const groups = new Map<string, { asin: string; marketplace: string; alerts: typeof alerts }>();
    for (const a of alerts) {
      const key = `${a.asin}|${a.marketplace}`;
      if (!groups.has(key)) groups.set(key, { asin: a.asin, marketplace: a.marketplace, alerts: [] });
      groups.get(key)!.alerts.push(a);
    }

    let checked = 0;
    let fired = 0;
    const nowIso = new Date().toISOString();

    for (const { asin, marketplace, alerts: group } of groups.values()) {
      const domainId = DOMAIN_MAP[marketplace] ?? 1;
      let price: number | null = null;
      try {
        const url = new URL('https://api.keepa.com/product');
        url.search = new URLSearchParams({ key: KEEPA_KEY, domain: String(domainId), asin }).toString();
        const res = await fetch(url.toString());
        if (res.ok) {
          const json = await res.json();
          price = currentAmazonPrice(json?.products?.[0]?.csv);
        } else {
          console.warn(`[check-price-alerts] Keepa HTTP ${res.status} for ${asin}`);
        }
      } catch (e) {
        console.warn(`[check-price-alerts] Keepa fetch failed for ${asin}`, (e as Error).message);
      }

      for (const a of group) {
        checked++;
        const patch: Record<string, unknown> = { last_checked_at: nowIso };
        if (price != null) patch.last_price_seen = price;

        const target = Number(a.target_price);
        const hit = price != null && (a.direction === 'at_or_above' ? price >= target : price <= target);

        if (hit) {
          try {
            const emailRes = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceRoleKey}` },
              body: JSON.stringify({
                to: a.notify_email,
                name: 'there',
                emailType: 'price-alert-fired',
                priceAlert: { asin: a.asin, marketplace: a.marketplace, targetPrice: target, currentPrice: price },
              }),
            });
            if (!emailRes.ok) console.error(`[check-price-alerts] fired-email send failed for alert ${a.id}`, await emailRes.text());
          } catch (e) {
            console.error(`[check-price-alerts] fired-email send error for alert ${a.id}`, (e as Error).message);
          }
          patch.status = 'fired';
          patch.fired_at = nowIso;
          fired++;
        }

        await admin.from('price_alerts').update(patch).eq('id', a.id);
      }
    }

    return jsonResponse({ ok: true, checked, fired, distinctListings: groups.size });
  } catch (e) {
    console.error('[check-price-alerts] error', (e as Error).message);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
