import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { requireInternalCall } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Mirrors full-inv-refresh-timeout-sweep's resume+timeout pattern, for
// prewarm_pl_runs. Live-discovered: prewarm-profit-loss-all's in-band
// selfContinue() call shares the same execution/trace as the work that
// tripped the platform's outbound-call quota ("Rate limit exceeded for
// trace <id>"), so it reliably fails right when it's needed, orphaning the
// run at whatever offset it last checkpointed. A resume call from THIS
// sweep (its own independently-triggered execution/trace) is what actually
// gets a fresh quota.
// Must comfortably clear prewarm-profit-loss-all's worst-case gap between
// heartbeat touches (~60s FETCH_CALL_TIMEOUT_MS plus poll/DB overhead) —
// too short and this fires on genuinely in-flight work, restarting it
// mid-month (live-observed once at 45s: it duplicated a still-running
// current-month fetch).
const RESUME_STALE_SECONDS = 90;
const TIMEOUT_MINUTES = 12;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const resumeCutoff = new Date(Date.now() - RESUME_STALE_SECONDS * 1000).toISOString();
    const timeoutCutoff = new Date(Date.now() - TIMEOUT_MINUTES * 60 * 1000).toISOString();

    // Resume pass: moderately-stale unfinished runs get an external kick.
    const { data: staleRuns } = await supabase
      .from('prewarm_pl_runs')
      .select('id')
      .is('finished_at', null)
      .eq('timed_out', false)
      .lt('last_heartbeat_at', resumeCutoff)
      .gt('last_heartbeat_at', timeoutCutoff);

    let resumed = 0;
    for (const run of staleRuns || []) {
      try {
        const resp = await fetch(`${supabaseUrl}/functions/v1/prewarm-profit-loss-all`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceRoleKey}`,
            'x-internal-secret': internalSecret,
          },
          body: JSON.stringify({ resume: true, run_id: (run as any).id }),
        });
        if (resp.ok) resumed++;
      } catch (e) {
        console.warn('[prewarm-pl-resume-sweep] resume attempt failed:', (e as Error).message);
      }
    }

    // Timeout pass: truly stale unfinished runs (heartbeat OR, for legacy
    // rows predating the heartbeat column, started_at) get marked timed_out.
    const step1 = await supabase
      .from('prewarm_pl_runs')
      .select('id')
      .is('finished_at', null)
      .eq('timed_out', false)
      .lt('last_heartbeat_at', timeoutCutoff);
    const step2 = await supabase
      .from('prewarm_pl_runs')
      .select('id')
      .is('finished_at', null)
      .eq('timed_out', false)
      .is('last_heartbeat_at', null)
      .lt('started_at', timeoutCutoff);

    const ids = [...(step1.data || []), ...(step2.data || [])].map((r: any) => r.id);
    let marked = 0;
    const BATCH = 100;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const { error } = await supabase
        .from('prewarm_pl_runs')
        .update({
          finished_at: new Date().toISOString(),
          timed_out: true,
          notes: `No progress for over ${TIMEOUT_MINUTES} minutes`,
        })
        .in('id', batch);
      if (!error) marked += batch.length;
    }

    return new Response(JSON.stringify({ ok: true, resumed, marked }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
