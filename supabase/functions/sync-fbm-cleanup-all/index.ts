import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

// Fan-out: invoke sync-fbm-cleanup once per user with an active US SP-API
// authorization. Runs in standalone mode — does NOT depend on
// sync-inventory-report. Each per-user call is fired with an 800ms gap to
// respect inter-function rate limits.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  // ── AUTH GATE ─────────────────────────────────────────────────────────────
  // Same three-way gate as sync-inventory-report-all: x-internal-secret,
  // service-role Bearer, or legacy anon Bearer (temporary, kept only so
  // existing anon-key crons don't break; remove once all callers migrated).
  // Without this, an unauthenticated caller could fan out FBM cleanup for
  // every seller on the platform.
  const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const providedSecret = req.headers.get('x-internal-secret') || '';
  const authHeader = req.headers.get('Authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  const okSecret = !!internalSecret && providedSecret === internalSecret;
  const okServiceBearer = !!serviceRoleKey && bearer === serviceRoleKey;
  const okLegacyAnonBearer = !!anonKey && bearer === anonKey; // TODO: remove after all callers migrated

  if (!okSecret && !okServiceBearer && !okLegacyAnonBearer) {
    console.warn('[sync-fbm-cleanup-all] rejected unauthenticated request');
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = serviceRoleKey;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const startedAt = Date.now();
  let dispatched = 0;
  let skipped = 0;
  const errors: string[] = [];

  try {
    // Eligible users: those with an active US SP-API authorization.
    const { data: auths } = await supabase
      .from('seller_authorizations')
      .select('user_id')
      .eq('marketplace_id', 'ATVPDKIKX0DER')
      .eq('is_active', true);

    const userIds = Array.from(new Set((auths || []).map((a: any) => a.user_id))).filter(Boolean);
    console.log(`[FBM_SYNC_ALL] Dispatching to ${userIds.length} users`);

    for (const userId of userIds) {
      try {
        // Fire-and-forget per user (sync-fbm-cleanup writes its own run row)
        const res = await fetch(`${supabaseUrl}/functions/v1/sync-fbm-cleanup`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({
            user_id: userId,
            triggered_by: 'cron-sync-fbm-cleanup-4h',
            non_destructive_sync: true,
          }),
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
      // 800ms delay between dispatches (per inter-function rate-limit rule)
      await new Promise(r => setTimeout(r, 800));
    }

    return new Response(JSON.stringify({
      ok: true,
      dispatched, skipped,
      eligible_users: userIds.length,
      elapsed_ms: Date.now() - startedAt,
      errors: errors.slice(0, 20),
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err: any) {
    console.error('[FBM_SYNC_ALL] Error:', err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
