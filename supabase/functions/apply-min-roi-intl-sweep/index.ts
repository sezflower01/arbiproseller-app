// Sweep: for the calling user, enforce per-marketplace min ROI on every
// international (CA / MX / BR) rule × marketplace combo by delegating to
// `apply-min-roi`. The ROI percent is read from
// `repricer_rules.min_roi_marketplace_overrides[marketplace]` and falls back
// to `min_roi_percent` when the override isn't set.
//
// Apply-min-roi raises `min_price_override` (FX-aware via calculate-roi-floor)
// and pushes the new bounds to Amazon. The next repricer evaluation will then
// naturally raise the live price up to the new floor — no separate price push
// is needed here.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { isInternalCaller } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const INTL_MARKETPLACES = ['CA', 'MX', 'BR'];

interface SweepBody {
  marketplaces?: string[]; // optional subset
  dry_run?: boolean;
  internal?: boolean; // cron/fanout calls: skip user-JWT auth, use user_id below
  user_id?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: SweepBody = await req.json().catch(() => ({}));

    // Auth check — cron/fanout calls pass internal:true + user_id and
    // authenticate via the shared internal-caller guard (service-role Bearer
    // or x-internal-secret); the frontend "Apply now" / Dry run path keeps
    // authenticating via a real user JWT.
    const incomingAuthHeader = req.headers.get('Authorization');
    let userId: string;
    let isInternalCall = false;
    if (body.internal && body.user_id && isInternalCaller(req)) {
      userId = body.user_id;
      isInternalCall = true;
    } else {
      if (!incomingAuthHeader) throw new Error('No authorization header');
      const token = incomingAuthHeader.replace('Bearer ', '');
      const { data: { user } } = await supabase.auth.getUser(token);
      if (!user) throw new Error('Unauthorized');
      userId = user.id;
    }

    const targetMkts = (body.marketplaces && body.marketplaces.length
      ? body.marketplaces
      : INTL_MARKETPLACES
    ).filter(m => INTL_MARKETPLACES.includes(m));

    if (targetMkts.length === 0) {
      return new Response(JSON.stringify({ error: 'No valid intl marketplaces' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`[intl-roi-sweep] user=${userId} marketplaces=${targetMkts.join(',')} dry_run=${!!body.dry_run} internal=${isInternalCall}`);

    // 1. Distinct (rule_id, marketplace) pairs with at least one enabled intl assignment
    const { data: pairs, error: pairErr } = await supabase
      .from('repricer_assignments')
      .select('rule_id, marketplace')
      .eq('user_id', userId)
      .eq('is_enabled', true)
      .in('marketplace', targetMkts)
      .not('rule_id', 'is', null);

    if (pairErr) throw pairErr;

    const uniquePairs = Array.from(new Set((pairs || []).map(p => `${p.rule_id}::${p.marketplace}`)))
      .map(k => { const [rule_id, marketplace] = k.split('::'); return { rule_id, marketplace }; });

    if (uniquePairs.length === 0) {
      return new Response(JSON.stringify({
        message: 'No enabled intl assignments found',
        pairs: 0, updated: 0, skipped: 0,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // 2. Load all touched rules
    const ruleIds = [...new Set(uniquePairs.map(p => p.rule_id))];
    const { data: rules } = await supabase
      .from('repricer_rules')
      .select('id, name, min_roi_percent, min_roi_marketplace_overrides')
      .in('id', ruleIds);

    const ruleMap: Record<string, any> = {};
    for (const r of (rules || [])) ruleMap[r.id] = r;

    // 3. For each (rule, marketplace) resolve the ROI and call apply-min-roi
    const results: any[] = [];
    let totalUpdated = 0, totalSkipped = 0, ranPairs = 0;

    for (const { rule_id, marketplace } of uniquePairs) {
      const rule = ruleMap[rule_id];
      if (!rule) {
        results.push({ rule_id, marketplace, status: 'skipped', reason: 'rule_not_found' });
        continue;
      }
      const overrides = rule.min_roi_marketplace_overrides || {};
      const roi = overrides?.[marketplace] ?? rule.min_roi_percent;
      if (roi == null || isNaN(Number(roi)) || Number(roi) <= 0) {
        results.push({
          rule_id, marketplace, rule_name: rule.name,
          status: 'skipped', reason: 'no_roi_configured',
        });
        continue;
      }

      if (body.dry_run) {
        // Count assignments that would be touched
        const { count } = await supabase
          .from('repricer_assignments')
          .select('id', { count: 'exact', head: true })
          .eq('rule_id', rule_id)
          .eq('marketplace', marketplace)
          .eq('user_id', userId)
          .eq('is_enabled', true);
        results.push({
          rule_id, marketplace, rule_name: rule.name,
          target_roi: Number(roi), would_touch: count ?? 0, status: 'dry_run',
        });
        continue;
      }

      try {
        const resp = await fetch(`${supabaseUrl}/functions/v1/apply-min-roi`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Internal/cron calls have no real user JWT to forward — authenticate
            // to apply-min-roi as a service-role internal caller instead, and
            // pass user_id explicitly. Frontend calls keep forwarding the user's JWT.
            'Authorization': isInternalCall ? `Bearer ${supabaseKey}` : incomingAuthHeader!,
            apikey: anonKey,
          },
          body: JSON.stringify({
            rule_id,
            marketplace,
            min_roi_percent: Number(roi),
            ...(isInternalCall ? { internal: true, user_id: userId } : {}),
          }),
        });
        const json = await resp.json().catch(() => ({}));
        if (resp.ok) {
          ranPairs++;
          totalUpdated += json.updated ?? 0;
          totalSkipped += json.skipped ?? 0;
          results.push({
            rule_id, marketplace, rule_name: rule.name, target_roi: Number(roi),
            status: 'ok', updated: json.updated ?? 0, skipped: json.skipped ?? 0,
          });
        } else {
          results.push({
            rule_id, marketplace, rule_name: rule.name, target_roi: Number(roi),
            status: 'error', error: json?.error || `HTTP ${resp.status}`,
          });
        }
      } catch (e: any) {
        results.push({
          rule_id, marketplace, rule_name: rule.name, target_roi: Number(roi),
          status: 'error', error: (e as Error).message,
        });
      }

      // Throttle between rule × marketplace calls (each one internally
      // throttles per-ASIN already)
      await new Promise(r => setTimeout(r, 1500));
    }

    console.log(`[intl-roi-sweep] done: pairs=${uniquePairs.length} ran=${ranPairs} updated=${totalUpdated} skipped=${totalSkipped}`);

    return new Response(JSON.stringify({
      pairs: uniquePairs.length,
      ran: ranPairs,
      updated: totalUpdated,
      skipped: totalSkipped,
      results,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[intl-roi-sweep] Error:', error);
    return new Response(
      JSON.stringify({ error: (error as Error).message || 'intl-roi-sweep failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
