import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

// Fan-out: invoke apply-min-roi-intl-sweep once per user with at least one
// enabled CA/MX/BR assignment, so international Min ROI floors stay current
// with live SP-API fees + FX automatically instead of requiring someone to
// click "Apply now". Each per-user call is fired with an 800ms gap to
// respect inter-function rate limits.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  // ── AUTH GATE ─────────────────────────────────────────────────────────────
  // Same gate as sync-fbm-cleanup-all / sync-inventory-report-all — without
  // this, an unauthenticated caller could fan out ROI enforcement (and real
  // Amazon price-bound pushes) for every seller on the platform.
  const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const providedSecret = req.headers.get('x-internal-secret') || '';
  const authHeader = req.headers.get('Authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  const okSecret = !!internalSecret && providedSecret === internalSecret;
  const okServiceBearer = !!serviceRoleKey && bearer === serviceRoleKey;

  if (!okSecret && !okServiceBearer) {
    console.warn('[apply-min-roi-intl-sweep-all] rejected unauthenticated request');
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = serviceRoleKey;
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Allow a safe, platform-wide dry-run test of the fan-out itself (discovers
  // real eligible users and proxies real per-user calls, but every downstream
  // apply-min-roi-intl-sweep call stays in dry-run — no Amazon price bounds
  // are touched for anyone). The real daily cron never sends this flag.
  const reqBody = await req.json().catch(() => ({}));
  const dryRun = reqBody?.dry_run === true;

  const startedAt = Date.now();
  let dispatched = 0;
  let skipped = 0;
  const errors: string[] = [];

  try {
    // Eligible users: those with at least one enabled CA/MX/BR assignment.
    const { data: assignments } = await supabase
      .from('repricer_assignments')
      .select('user_id')
      .eq('is_enabled', true)
      .in('marketplace', ['CA', 'MX', 'BR']);

    const userIds = Array.from(new Set((assignments || []).map((a: any) => a.user_id))).filter(Boolean);
    console.log(`[INTL_ROI_SWEEP_ALL] Dispatching to ${userIds.length} users`);

    for (const userId of userIds) {
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/apply-min-roi-intl-sweep`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({
            internal: true,
            user_id: userId,
            dry_run: dryRun,
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
      dry_run: dryRun,
      dispatched, skipped,
      eligible_users: userIds.length,
      elapsed_ms: Date.now() - startedAt,
      errors: errors.slice(0, 20),
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err: any) {
    console.error('[INTL_ROI_SWEEP_ALL] Error:', err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
