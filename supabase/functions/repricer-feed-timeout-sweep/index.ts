import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { requireInternalCall } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Safety net for repricer-batch-update's background feed poll
// (pollAfterDelay): a fixed 120s sleep followed by up to 5x60s poll
// attempts, run as a single continuous EdgeRuntime.waitUntil() execution
// with no checkpointing. Live evidence: 9 of ~500 sampled
// repricer_feed_submissions rows are stuck at 'IN_QUEUE' forever (some
// months old) — most feeds finish inside the ~150s real runtime ceiling
// (this account's feeds are typically 1-7 SKUs), but when Amazon is slow
// or the poll loop runs long, the execution silently dies with no trace.
// This sweep makes that failure visible instead of permanently invisible —
// it does not attempt to resume polling (unlike the other resume-sweeps
// built today), since there's nothing to safely resume: the price change
// was already submitted to Amazon, we just never confirmed the outcome.
const TIMEOUT_MINUTES = 20;

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

    const { data: stale, error: selErr } = await supabase
      .from('repricer_feed_submissions')
      .select('id, feed_id, user_id')
      .eq('status', 'IN_QUEUE')
      .lt('created_at', cutoff);
    if (selErr) {
      return new Response(JSON.stringify({ ok: false, step: 'select', error: selErr }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!stale || stale.length === 0) {
      return new Response(JSON.stringify({ ok: true, marked: 0 }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const ids = stale.map((r: any) => r.id);
    const { error: updErr } = await supabase
      .from('repricer_feed_submissions')
      .update({
        status: 'timed_out',
        error_message: `Poll never confirmed outcome within ${TIMEOUT_MINUTES} minutes (background execution likely killed by the runtime before it could check Amazon's feed status).`,
        updated_at: new Date().toISOString(),
      })
      .in('id', ids);
    if (updErr) {
      return new Response(JSON.stringify({ ok: false, step: 'update_submissions', error: updErr }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Mark the linked price_actions as unverified — we submitted the price
    // change to Amazon but never confirmed whether it actually applied.
    let actionsMarked = 0;
    for (const row of stale) {
      if (!row.feed_id) continue;
      const { error: actErr, count } = await supabase
        .from('repricer_price_actions')
        .update({ reconciliation_status: 'unverified' }, { count: 'exact' })
        .eq('feed_id', row.feed_id)
        .eq('user_id', row.user_id)
        .eq('reconciliation_status', 'pending');
      if (!actErr) actionsMarked += count || 0;
    }

    return new Response(JSON.stringify({ ok: true, marked: ids.length, actions_marked_unverified: actionsMarked }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
