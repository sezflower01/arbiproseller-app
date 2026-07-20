// Frontend-facing "Check now" trigger. Replaces the old direct call to
// detect-pricing-suppressions (which loops a user's whole catalog in one
// invocation and hit WORKER_RESOURCE_LIMIT for a 1,723-SKU account).
// Verifies the caller's own JWT (never trusts a client-supplied user_id --
// enqueue always runs for the authenticated caller only), enqueues via the
// same SQL function the nightly cron uses, then kicks the worker once
// immediately so the user gets fast feedback instead of waiting for the
// next 1-minute cron tick.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('Missing authorization');
    const jwt = authHeader.replace('Bearer ', '');
    const { data: { user } } = await supabase.auth.getUser(jwt);
    if (!user) throw new Error('Unauthorized');
    const userId = user.id;

    const { data: enqueueResult, error: enqueueError } = await supabase.rpc('enqueue_pricing_suppression_check', { p_user_id: userId });
    if (enqueueError) throw enqueueError;

    // Kick the worker once immediately for fast feedback, instead of making
    // the user wait for the next 1-minute cron tick. Best-effort -- if this
    // particular invocation times out or fails, the cron will still drain
    // the queue on its normal cadence.
    let workerResult: any = null;
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const resp = await fetch(`${supabaseUrl}/functions/v1/pricing-suppression-worker`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({ batch_size: 30 }),
      });
      workerResult = await resp.json().catch(() => null);
    } catch (workerErr: any) {
      console.warn('[trigger-pricing-suppression-check] worker kick failed (non-fatal):', workerErr?.message || workerErr);
    }

    return new Response(JSON.stringify({
      ok: true,
      enqueued: enqueueResult?.enqueued ?? 0,
      worker: workerResult,
    }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('[trigger-pricing-suppression-check] error:', e?.message || e);
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
