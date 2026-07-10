// Customer Intelligence — Path B (PII-free pattern detector)
// Detects repeat refund/replacement abuse patterns using ONLY order metadata
// (ASIN, marketplace, order_id lineage, refunds, replacements, quantities,
// and optionally ship_to_hash when populated). No BuyerInfo required.
//
// Emits business_health_issues in the "Customer Intelligence" category with
// confidence='low' and a clear "Matched by order/product pattern" label so it
// can never be confused with PII-verified signals from Path A.
//
// Safe to run repeatedly (idempotent upsert by fingerprint).
// Invocation:
//   POST { userId?: uuid, windowDays?: number, dryRun?: boolean }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

type PatternRow = {
  asin: string;
  marketplace: string | null;
  ship_to_hash: string | null;
  base_orders: number;
  refund_orders: number;
  replacement_orders: number;
  units: number;
  refund_amount_usd: number;
  first_seen: string;
  last_seen: string;
  order_ids: string[];
};

function classify(p: PatternRow): { severity: 'critical' | 'warning' | 'info' | null; reason: string } {
  const returnEvents = p.refund_orders + p.replacement_orders;
  const refundRate = p.base_orders > 0 ? p.refund_orders / p.base_orders : 0;

  // Highest priority — ASIN loop with any ship-to identity signal
  if (p.ship_to_hash && returnEvents >= 2 && p.base_orders >= 3) {
    return { severity: 'critical', reason: 'shipto_loop' };
  }
  // Same ship-area + refund event on same ASIN (Panduit-style: 3+ orders to
  // same address on the same ASIN followed by a refund/replacement).
  if (p.ship_to_hash && p.base_orders >= 3 && returnEvents >= 1 && p.refund_amount_usd >= 50) {
    return { severity: 'critical', reason: 'shipto_repeat_with_refund' };
  }
  // Same ship-area + high volume on same ASIN, no returns yet (early warning).
  if (p.ship_to_hash && p.base_orders >= 4) {
    return { severity: 'warning', reason: 'shipto_repeat_volume' };
  }
  // Replacement clusters (Panduit-style repeated swaps)
  if (p.replacement_orders >= 2 && p.base_orders >= 3) {
    return { severity: 'critical', reason: 'replacement_cluster' };
  }
  // Refund cluster — many refunds AND either high rate or material dollar exposure
  if (p.refund_orders >= 3 && (refundRate >= 0.20 || p.refund_amount_usd >= 100)) {
    return { severity: 'critical', reason: 'refund_cluster' };
  }
  // High-volume ASIN with material refund exposure (catches Panduit: 10 orders + $379 refund)
  if (p.base_orders >= 5 && p.refund_amount_usd >= 150) {
    return { severity: 'warning', reason: 'volume_with_returns' };
  }
  // Refund + replacement pair on same ASIN (rare but strong signal)
  if (p.replacement_orders >= 1 && p.refund_orders >= 1 && p.refund_amount_usd >= 50) {
    return { severity: 'warning', reason: 'refund_and_replacement' };
  }
  return { severity: null, reason: 'none' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const body = await req.json().catch(() => ({}));
    const userId: string | undefined = body?.userId;
    const windowDays: number = Math.min(Math.max(parseInt(String(body?.windowDays || '90'), 10), 7), 365);
    const dryRun: boolean = body?.dryRun === true;

    let userIds: string[] = [];
    if (userId) {
      userIds = [userId];
    } else {
      const { data } = await supabase
        .from('sales_orders')
        .select('user_id')
        .gte('order_date', new Date(Date.now() - windowDays * 86400 * 1000).toISOString())
        .limit(5000);
      userIds = Array.from(new Set((data || []).map((r: any) => r.user_id))).filter(Boolean);
    }

    const perUserStats: any[] = [];
    const sinceIso = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();

    for (const uid of userIds) {
      const stats = { userId: uid, patternsScanned: 0, issuesEmitted: 0, issuesResolved: 0, errors: [] as string[] };

      // Pull recent rows via keyset pagination on id (stable across duplicate order_date values)
      const PAGE = 1000;
      const MAX_ROWS = 60000;
      let rows: any[] = [];
      let lastId: string | null = null;
      while (rows.length < MAX_ROWS) {
        let q = supabase
          .from('sales_orders')
          .select('id, order_id, asin, marketplace, ship_to_hash, quantity, refund_amount, is_replacement, order_date')
          .eq('user_id', uid)
          .gte('order_date', sinceIso)
          .not('asin', 'is', null)
          .order('id', { ascending: true })
          .limit(PAGE);
        if (lastId) q = q.gt('id', lastId);
        const { data: page, error } = await q;
        if (error) {
          stats.errors.push('query_failed:' + error.message);
          break;
        }
        if (!page || page.length === 0) break;
        rows = rows.concat(page);
        lastId = page[page.length - 1].id as string;
        if (page.length < PAGE) break;
      }

      // Group by (asin, marketplace, ship_to_hash-or-null)
      const groups = new Map<string, PatternRow>();
      for (const r of rows || []) {
        const asin = r.asin as string;
        const mp = (r.marketplace as string) || 'US';
        const sh = (r.ship_to_hash as string) || '';
        const key = `${asin}|${mp}|${sh}`;
        let g = groups.get(key);
        if (!g) {
          g = {
            asin,
            marketplace: mp,
            ship_to_hash: sh || null,
            base_orders: 0,
            refund_orders: 0,
            replacement_orders: 0,
            units: 0,
            refund_amount_usd: 0,
            first_seen: r.order_date as string,
            last_seen: r.order_date as string,
            order_ids: [],
          };
          groups.set(key, g);
        }
        const baseId = String(r.order_id || '').split('-REFUND')[0];
        const isRefund = String(r.order_id || '').includes('-REFUND');
        if (!isRefund && !g.order_ids.includes(baseId)) {
          g.order_ids.push(baseId);
          g.base_orders++;
          g.units += Number(r.quantity || 0);
        }
        if (isRefund || Number(r.refund_amount || 0) > 0) {
          g.refund_orders++;
          g.refund_amount_usd += Number(r.refund_amount || 0);
        }
        if (r.is_replacement) g.replacement_orders++;
        if ((r.order_date as string) < g.first_seen) g.first_seen = r.order_date as string;
        if ((r.order_date as string) > g.last_seen) g.last_seen = r.order_date as string;
      }

      stats.patternsScanned = groups.size;
      const activeFingerprints = new Set<string>();

      for (const g of groups.values()) {
        const { severity, reason } = classify(g);
        if (!severity) continue;

        const fingerprint = `abuse-pattern:${g.asin}:${g.marketplace}:${g.ship_to_hash || 'no-shipto'}:${reason}`;
        activeFingerprints.add(fingerprint);

        const title = g.ship_to_hash
          ? `Possible repeat customer — same ship-area pattern on ${g.asin}`
          : `Repeat refund/replacement pattern on ${g.asin}`;
        const impact = [
          `Possible repeat customer — matched by order/product pattern (no buyer PII available; not a confirmed identity).`,
          `ASIN ${g.asin} · ${g.marketplace} — ${g.base_orders} orders, ${g.refund_orders} refunds ($${g.refund_amount_usd.toFixed(2)}), ${g.replacement_orders} replacements in last ${windowDays}d.`,
          g.ship_to_hash
            ? `Same ship-area signal present (city+state+postal+country hash) across these orders.`
            : `No ship-area signal — pattern is ASIN-level only.`,
        ].join(' ');
        const recommended_fix =
          reason === 'shipto_loop' || reason === 'replacement_cluster'
            ? 'Review these order IDs. If they appear to trace to one buyer, open an A-to-z / abuse case in Seller Central citing the same ship-area pattern.'
            : 'Review sales/returns for this ASIN. If concentrated on one ship-area, escalate through Seller Central as a possible repeat customer.';

        const affected_entities = {
          asin: g.asin,
          marketplace: g.marketplace,
          ship_to_hash: g.ship_to_hash,
          orders_count: g.base_orders,
          refund_orders_count: g.refund_orders,
          replacement_orders_count: g.replacement_orders,
          refund_amount_usd: Number(g.refund_amount_usd.toFixed(2)),
          order_ids: g.order_ids.slice(0, 25),
          window_days: windowDays,
          pattern_reason: reason,
          confidence_label: g.ship_to_hash
            ? 'Same ship-area pattern (possible repeat customer, not PII-verified)'
            : 'ASIN-level pattern only (no ship-area signal)',
        };

        if (dryRun) {
          stats.issuesEmitted++;
          continue;
        }

        const { error: upErr } = await supabase.from('business_health_issues').upsert(
          {
            user_id: uid,
            fingerprint,
            module: 'customer_intelligence',
            severity,
            confidence: 'low',
            title,
            impact,
            recommended_fix,
            occurrence_count: g.base_orders + g.refund_orders + g.replacement_orders,
            first_seen: g.first_seen,
            last_seen: g.last_seen,
            affected_entities,
            routes: ['/tools/live-sales', '/tools/sales'],
            functions: ['detect-abuse-patterns'],
            sources: ['sales_orders'],
            status: 'open',
            retryable: false,
            display_category: 'Customers',
          },
          { onConflict: 'user_id,fingerprint' },
        );
        if (upErr) stats.errors.push(`upsert_failed:${fingerprint}:${upErr.message}`);
        else stats.issuesEmitted++;
      }

      // Auto-resolve stale abuse-pattern issues no longer matching
      if (!dryRun) {
        const { data: existing } = await supabase
          .from('business_health_issues')
          .select('id, fingerprint')
          .eq('user_id', uid)
          .eq('module', 'customer_intelligence')
          .like('fingerprint', 'abuse-pattern:%')
          .eq('status', 'open');
        const stale = (existing || []).filter((r: any) => !activeFingerprints.has(r.fingerprint));
        if (stale.length) {
          const { error: resErr } = await supabase
            .from('business_health_issues')
            .update({ status: 'resolved', resolved_at: new Date().toISOString(), resolved_reason: 'pattern_no_longer_matches' })
            .in('id', stale.map((r: any) => r.id));
          if (!resErr) stats.issuesResolved = stale.length;
        }
      }

      perUserStats.push(stats);
    }

    return new Response(JSON.stringify({ ok: true, users: perUserStats }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
