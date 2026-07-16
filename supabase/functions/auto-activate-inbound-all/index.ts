// auto-activate-inbound-all
// Fan-out wrapper that scans every user with `inventory.inbound > 0` and calls
// `auto-assign-bulk` per (user_id, marketplace). This is the cron entrypoint
// for the "Instant Inbound Auto-Activation" feature — the moment an active
// listing has inbound stock, the repricer attaches the user's default rule,
// computes the ROI floor, sets min = floor, max above min, raises live price
// up to the floor if below, and enables the assignment.
//
// Scope: US, CA, MX, BR. Intl marketplaces only proceed if the assignment is
// BUYABLE (auto-assign-bulk applies its own sellability gate downstream).
//
// Concurrency: cron-lock prevents overlapping runs. Per-user calls are
// fire-and-forget with 800ms staggers to respect the inter-function rate
// limit.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const MARKETPLACES = ['US', 'CA', 'MX', 'BR'] as const;
const STAGGER_MS = 800;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  // ── AUTH GATE ── same pattern as sync-inventory-report-all: accepts
  // x-internal-secret (cron path) or a service-role bearer. Without this,
  // an unauthenticated caller could trigger a full-catalog activation pass
  // for every seller.
  const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
  const serviceRoleKeyEnv = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const providedSecret = req.headers.get('x-internal-secret') || '';
  const authHeader = req.headers.get('Authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const okSecret = !!internalSecret && providedSecret === internalSecret;
  const okServiceBearer = !!serviceRoleKeyEnv && bearer === serviceRoleKeyEnv;
  if (!okSecret && !okServiceBearer) {
    console.warn('[auto-activate-inbound-all] rejected unauthenticated request');
    return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  // Cron lock — single concurrent run platform-wide.
  const { data: lockOk } = await supabase.rpc('try_acquire_cron_lock', {
    p_job_name: 'auto_activate_inbound_all',
    p_ttl_seconds: 600,
  });
  if (!lockOk) {
    return new Response(JSON.stringify({ success: true, skipped: 'lock_held' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const runStartedAt = new Date().toISOString();
  let usersProcessed = 0;
  let callsDispatched = 0;
  let errors = 0;

  try {
    // Pull distinct user_ids with inbound > 0 (active listings only).
    // Limit to non-ghost rows to avoid wasting calls on tombstoned listings.
    const { data: candidates, error: candErr } = await supabase
      .from('inventory')
      .select('user_id')
      .gt('inbound', 0)
      .not('listing_status', 'in', '(DELETED,NOT_IN_CATALOG,INCOMPLETE)')
      .limit(10000);

    if (candErr) throw candErr;

    const userIds = Array.from(new Set((candidates || []).map((r: any) => r.user_id))).filter(Boolean);
    console.log(`[auto-activate-inbound-all] ${userIds.length} users with inbound>0`);

    for (const userId of userIds) {
      const runRow = await supabase.from('auto_activate_runs').insert({
        user_id: userId,
        started_at: runStartedAt,
      }).select('id').single();

      let userActivated = 0;
      let userReenabled = 0;
      let userRaised = 0;
      let userError: string | null = null;

      for (const marketplace of MARKETPLACES) {
        try {
          const resp = await fetch(`${supabaseUrl}/functions/v1/auto-assign-bulk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
            body: JSON.stringify({
              user_id: userId,
              marketplace,
              internal: true,
              triggered_by: 'auto_activate_inbound_cron',
            }),
          });
          const json = await resp.json().catch(() => null);
          if (resp.ok && json) {
            userActivated += Number(json.created || 0);
            userReenabled += Number(json.reenabled || 0);
            userRaised += Number(json.auto_raised ?? json.autoRaised ?? 0);
            callsDispatched++;
          } else if (!resp.ok) {
            console.log(`[auto-activate-inbound-all] ${userId} ${marketplace}: ${resp.status} ${json?.error || ''}`);
          }
        } catch (e: any) {
          userError = e?.message || String(e);
          errors++;
        }
        await new Promise(r => setTimeout(r, STAGGER_MS));
      }

      if (runRow.data?.id) {
        await supabase.from('auto_activate_runs').update({
          finished_at: new Date().toISOString(),
          activated: userActivated,
          re_enabled: userReenabled,
          auto_raised: userRaised,
          error: userError,
        }).eq('id', runRow.data.id);
      }

      usersProcessed++;
    }

    return new Response(JSON.stringify({
      success: true,
      users: usersProcessed,
      calls: callsDispatched,
      errors,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('[auto-activate-inbound-all] fatal', e);
    return new Response(JSON.stringify({ success: false, error: e?.message || String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } finally {
    try {
      await supabase.rpc('release_cron_lock', { p_job_name: 'auto_activate_inbound_all' });
    } catch (releaseErr) {
      console.warn('[auto-activate-inbound-all] failed to release cron lock', releaseErr);
    }
  }
});
