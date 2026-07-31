import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { requireInternalCall } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Safety net: marks fnsku_sync_history rows stuck 'in_progress' with no
// recent heartbeat as 'timed_out', so a genuinely dead run is visible and
// distinguishable from one still working, instead of looking like a phantom
// "still running" sync forever (759 historical rows never got any terminal
// status at all before this). Threshold is intentionally longer than the
// per-invocation TIME_BUDGET_MS in sync-fnsku-report (100s) plus its own
// self-continuation network round-trips, so a healthy chain of continuations
// is never mistaken for a stall.
const TIMEOUT_MINUTES = 12;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const cutoff = new Date(Date.now() - TIMEOUT_MINUTES * 60 * 1000).toISOString();

    const step1 = await supabase
      .from('fnsku_sync_history')
      .select('id, user_id, sync_started_at, last_heartbeat_at, phase')
      .eq('status', 'in_progress')
      .lt('last_heartbeat_at', cutoff);
    if (step1.error) {
      return new Response(JSON.stringify({ ok: false, step: 'step1', error: step1.error }, null, 2), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const step2 = await supabase
      .from('fnsku_sync_history')
      .select('id, user_id, sync_started_at, last_heartbeat_at, phase')
      .eq('status', 'in_progress')
      .is('last_heartbeat_at', null)
      .lt('sync_started_at', cutoff);
    if (step2.error) {
      return new Response(JSON.stringify({ ok: false, step: 'step2', error: step2.error }, null, 2), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const staleRows = [...(step1.data || []), ...(step2.data || [])];

    if (!staleRows || staleRows.length === 0) {
      return new Response(JSON.stringify({ ok: true, marked: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const ids = staleRows.map((r: any) => r.id);
    // Batched — a single .in() with hundreds of UUIDs (759 historical stuck
    // rows on first run) produces a URL long enough to be rejected outright.
    const UPDATE_BATCH = 100;
    let marked = 0;
    for (let i = 0; i < ids.length; i += UPDATE_BATCH) {
      const batch = ids.slice(i, i + UPDATE_BATCH);
      const { error: updErr } = await supabase
        .from('fnsku_sync_history')
        .update({ status: 'timed_out', sync_completed_at: new Date().toISOString(), error_message: `No progress for over ${TIMEOUT_MINUTES} minutes` })
        .in('id', batch);
      if (updErr) {
        return new Response(JSON.stringify({ ok: false, step: 'update', batchIndex: i, error: updErr }, null, 2), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      marked += batch.length;
    }

    console.log(`[fnsku-sync-timeout-sweep] marked ${marked} stale rows as timed_out`);
    return new Response(JSON.stringify({ ok: true, marked, sample: staleRows.slice(0, 5) }, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('[fnsku-sync-timeout-sweep] error:', e);
    return new Response(JSON.stringify({ ok: false, error: e?.message, details: e?.details, hint: e?.hint, code: e?.code, full: JSON.stringify(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
