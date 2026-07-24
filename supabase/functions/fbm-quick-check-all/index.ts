import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { requireInternalCall } from '../_shared/require-internal.ts';

// Cron entrypoint for the fast FBM onboarding check (see fbm-quick-check for
// why this exists). Finds every user with at least one FBM listing currently
// at zero stock, and dispatches fbm-quick-check per user so each one's
// candidate SKUs get a live quantity check via the Listings API.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const STAGGER_MS = 800;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: lockOk } = await supabase.rpc('try_acquire_cron_lock', {
    p_job_name: 'fbm_quick_check_all',
    p_ttl_seconds: 280,
  });
  if (!lockOk) {
    return new Response(JSON.stringify({ ok: true, skipped: 'lock_held' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const startedAt = Date.now();
  let dispatched = 0;
  let skipped = 0;
  const errors: string[] = [];

  try {
    const { data: candidates, error: candErr } = await supabase
      .from('inventory')
      .select('user_id')
      .eq('source', 'amazon_sync_fbm')
      .or('available.is.null,available.eq.0')
      .not('listing_status', 'in', '(DELETED,NOT_IN_CATALOG,INCOMPLETE)')
      .limit(10000);
    if (candErr) throw candErr;

    const userIds = Array.from(new Set((candidates || []).map((r: any) => r.user_id))).filter(Boolean);
    console.log(`[fbm-quick-check-all] ${userIds.length} users with zero-stock FBM listings`);

    for (const userId of userIds) {
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/fbm-quick-check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
          body: JSON.stringify({ user_id: userId, marketplace: 'US' }),
        });
        if (res.ok) dispatched++;
        else {
          skipped++;
          const txt = await res.text().catch(() => '');
          errors.push(`user=${userId} status=${res.status} ${txt.slice(0, 120)}`);
        }
      } catch (err: any) {
        skipped++;
        errors.push(`user=${userId} err=${err.message?.slice(0, 120)}`);
      }
      await new Promise(r => setTimeout(r, STAGGER_MS));
    }

    return new Response(JSON.stringify({
      ok: true,
      dispatched, skipped,
      eligible_users: userIds.length,
      elapsed_ms: Date.now() - startedAt,
      errors: errors.slice(0, 20),
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err: any) {
    console.error('[fbm-quick-check-all] Error:', err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } finally {
    try {
      await supabase.rpc('release_cron_lock', { p_job_name: 'fbm_quick_check_all' });
    } catch (releaseErr) {
      console.warn('[fbm-quick-check-all] failed to release cron lock', releaseErr);
    }
  }
});
