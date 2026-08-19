// CHECK-PRICE-ALERTS
// Hourly cron worker (see migration 20260715195131_add_price_alerts.sql).
// For every active price alert, fetches the current Amazon price from Keepa
// (one minimal /product call per DISTINCT asin+marketplace, shared across
// however many users are tracking the same listing) and fires the
// price-alert-fired email once, then deactivates that alert.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  acquireKeepaGlobalSlot, reportKeepaTokensLeft, recordKeepa429,
  KEEPA_COST, KEEPA_RESERVE,
} from '../_shared/keepa-rate-gate.ts';

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

    // GATED 2026-08-19, and with the FULL two-layer gate on purpose.
    //
    // This loop is the caller Layer 1's call-rate guard exists for: it fires
    // one Keepa /product per distinct ASIN, sequentially, with no bound on how
    // many alerts exist. On 2026-08-19 it ran 13:00:04-13:03:31 UTC spending
    // unmetered the whole time. The interactive analyzer callers use the
    // token-only lane because human-paced traffic cannot hammer; a cron loop
    // absolutely can, so it keeps the rate guard.
    //
    // BACKGROUND tier: a price alert that checks an hour late is a
    // non-event, whereas a person waiting on the analyzer is not. This job
    // should be the first to yield.
    //
    // WHY THIS MATTERED MORE THAN IT LOOKED. Spending without claiming does
    // not just overspend -- it corrupts the shared budget for everyone else.
    // keepa_token_budget read 38.13 while Keepa's own response carried
    // tokensLeft -9, so correctly-gated callers were approved against a number
    // that was already fiction and got a raw 429 anyway. That desync is what
    // made the analyzer fix look unreliable at 13:20 UTC.
    let slotDenied = 0;
    for (const { asin, marketplace, alerts: group } of groups.values()) {
      const domainId = DOMAIN_MAP[marketplace] ?? 1;
      let price: number | null = null;

      const slot = await acquireKeepaGlobalSlot(admin, {
        estimatedTokens: KEEPA_COST.productPerAsin,
        minReserve: KEEPA_RESERVE.background,
      });
      if (!slot.ok) {
        // Skip rather than wait. The alert keeps last_checked_at from its
        // previous run and is retried next hour -- burning the worker's
        // wall-clock sleeping would only push the same contention later.
        slotDenied++;
        console.warn(`[check-price-alerts] Keepa slot denied (${slot.blockedBy}) for ${asin}, skipping this run`);
        continue;
      }

      try {
        const url = new URL('https://api.keepa.com/product');
        url.search = new URLSearchParams({ key: KEEPA_KEY, domain: String(domainId), asin }).toString();
        const res = await fetch(url.toString());
        if (res.ok) {
          const json = await res.json();
          // Reconcile BEFORE reading the payload, and regardless of whether
          // the body turns out to carry an error: a 200 with an in-body error
          // still moved the balance, and not reporting it is precisely how the
          // local number drifted 47 tokens high.
          await reportKeepaTokensLeft(admin, json?.tokensLeft, json?.refillRate);
          if (json?.error) {
            console.warn(`[check-price-alerts] Keepa in-body error for ${asin}:`,
              typeof json.error === 'string' ? json.error : JSON.stringify(json.error));
          } else {
            price = currentAmazonPrice(json?.products?.[0]?.csv);
          }
        } else {
          console.warn(`[check-price-alerts] Keepa HTTP ${res.status} for ${asin}`);
          if (res.status === 429) {
            // Keepa puts tokensLeft in the 429 body -- capturing it records the
            // balance AT the moment of refusal, which is the number that turns
            // "something is starving the analyzer" into a measurement.
            const txt = await res.text().catch(() => '');
            let tl: unknown = undefined;
            try { tl = JSON.parse(txt)?.tokensLeft; } catch { /* not JSON */ }
            await recordKeepa429(admin, tl, 'check-price-alerts');
          }
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

    // slotDenied is reported so "alerts went quiet" is diagnosable as budget
    // pressure rather than looking like there was nothing to check.
    if (slotDenied) {
      console.warn(`[check-price-alerts] skipped ${slotDenied}/${groups.size} listings — Keepa budget busy`);
    }
    return jsonResponse({ ok: true, checked, fired, distinctListings: groups.size, slotDenied });
  } catch (e) {
    console.error('[check-price-alerts] error', (e as Error).message);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
