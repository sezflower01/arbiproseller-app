import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { requireInternalCall } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Same safety net as fnsku-sync-timeout-sweep, for full_inventory_refresh_runs.
const TIMEOUT_MINUTES = 12;

// Live-discovered: the in-band selfContinue() call inside
// full-inventory-refresh-all shares the SAME execution/trace as the work
// that just tripped the platform's outbound-call quota ("Rate limit
// exceeded for trace <id>"), so it reliably fails too — the chain gets
// orphaned at whatever item it last checkpointed, with a live heartbeat that
// simply stops advancing. A resume call from THIS sweep (its own
// independently-triggered execution/trace) is what actually gets a fresh
// quota. Confirmed live: a run stuck at item 30/4432 sat with a frozen
// heartbeat for 15+ minutes with no in-band recovery.
const RESUME_STALE_SECONDS = 45;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

    // Resume pass: moderately-stale in_progress runs get an external kick
    // (independent trace, so it isn't blocked by the same quota the stuck
    // execution tripped) before they're old enough to be marked timed_out.
    const resumeCutoff = new Date(Date.now() - RESUME_STALE_SECONDS * 1000).toISOString();
    const { data: staleRuns } = await supabase
      .from('full_inventory_refresh_runs')
      .select('id')
      .eq('status', 'in_progress')
      .lt('last_heartbeat_at', resumeCutoff)
      .gt('last_heartbeat_at', new Date(Date.now() - TIMEOUT_MINUTES * 60 * 1000).toISOString());
    let resumed = 0;
    for (const run of staleRuns || []) {
      try {
        const resp = await fetch(`${supabaseUrl}/functions/v1/full-inventory-refresh-all`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceRoleKey}`,
            'x-internal-secret': internalSecret,
          },
          body: JSON.stringify({ resume: true, runId: (run as any).id }),
        });
        if (resp.ok) resumed++;
      } catch (e) {
        console.warn('[full-inv-refresh-timeout-sweep] resume attempt failed:', (e as Error).message);
      }
    }

    const cutoff = new Date(Date.now() - TIMEOUT_MINUTES * 60 * 1000).toISOString();

    const step1 = await supabase
      .from('full_inventory_refresh_runs')
      .select('id')
      .eq('status', 'in_progress')
      .lt('last_heartbeat_at', cutoff);
    if (step1.error) {
      return new Response(JSON.stringify({ ok: false, step: 'step1', error: step1.error }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const step2 = await supabase
      .from('full_inventory_refresh_runs')
      .select('id')
      .eq('status', 'in_progress')
      .is('last_heartbeat_at', null)
      .lt('started_at', cutoff);
    if (step2.error) {
      return new Response(JSON.stringify({ ok: false, step: 'step2', error: step2.error }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const ids = [...(step1.data || []), ...(step2.data || [])].map((r: any) => r.id);
    if (ids.length === 0) {
      return new Response(JSON.stringify({ ok: true, marked: 0, resumed }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const BATCH = 100;
    let marked = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const { error } = await supabase
        .from('full_inventory_refresh_runs')
        .update({ status: 'timed_out', completed_at: new Date().toISOString(), error_message: `No progress for over ${TIMEOUT_MINUTES} minutes` })
        .in('id', batch);
      if (error) {
        return new Response(JSON.stringify({ ok: false, step: 'update', batchIndex: i, error }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      marked += batch.length;
    }

    return new Response(JSON.stringify({ ok: true, marked, resumed }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
