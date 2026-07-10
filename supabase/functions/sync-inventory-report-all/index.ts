import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

/**
 * SYNC-INVENTORY-REPORT-ALL
 *
 * Fan-out wrapper for the per-user `sync-inventory-report` (Reports API).
 * Cron-friendly: enumerates every user that has at least one active
 * seller_authorization, then invokes sync-inventory-report for each user
 * sequentially with `{ user_id }` in the body. Sequential + spaced calls
 * avoid hammering SP-API and stay under edge-function CPU limits.
 *
 * Auth: accepts service-role bearer OR x-internal-secret. The cron sends
 * the anon key — that is also accepted because this fan-out itself does
 * not touch SP-API; it only triggers per-user functions which authenticate
 * via service-role internally.
 *
 * Body (optional): { delay_ms?: number, max_users?: number }
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  // ── AUTH GATE ─────────────────────────────────────────────────────────────
  // Accepts (in order):
  //   1. x-internal-secret matching INTERNAL_SYNC_SECRET (hardened cron path)
  //   2. Authorization: Bearer <service_role key> (internal service callers)
  //   3. Authorization: Bearer <anon key> — TEMPORARY, kept only so the
  //      legacy anon-key cron (job 77) does not break. Remove once job 77
  //      is migrated to the internal-secret pattern.
  // Anything else is rejected. Without this gate, an unauthenticated caller
  // could trigger a full-catalog Reports API sync for every seller.
  const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const providedSecret = req.headers.get('x-internal-secret') || '';
  const authHeader = req.headers.get('Authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  const okSecret = !!internalSecret && providedSecret === internalSecret;
  const okServiceBearer = !!serviceRoleKey && bearer === serviceRoleKey;
  const okLegacyAnonBearer = !!anonKey && bearer === anonKey; // TODO: remove after job 77 migrated

  if (!okSecret && !okServiceBearer && !okLegacyAnonBearer) {
    console.warn('[sync-inventory-report-all] rejected unauthenticated request');
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const t0 = Date.now();
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    let body: any = {};
    try { body = await req.json(); } catch { /* ok */ }
    const delayMs = Math.max(0, Math.min(60000, body?.delay_ms ?? 1500));
    const maxUsers = Math.max(1, Math.min(5000, body?.max_users ?? 1000));

    // Enumerate distinct users with at least one Amazon authorization.
    const { data: rows, error } = await supabase
      .from('seller_authorizations')
      .select('user_id')
      .not('refresh_token', 'is', null)
      .limit(10000);
    if (error) throw error;

    const userIds = Array.from(new Set((rows || []).map((r: any) => r.user_id))).filter(Boolean).slice(0, maxUsers);
    console.log(`[sync-inventory-report-all] dispatching to ${userIds.length} users, delay=${delayMs}ms`);

    const results: any[] = [];
    for (let i = 0; i < userIds.length; i++) {
      const uid = userIds[i];
      const tStart = Date.now();
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/sync-inventory-report`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${serviceKey}`,
            'apikey': serviceKey,
          },
          body: JSON.stringify({ user_id: uid, triggered_by: 'cron-fanout' }),
        });
        const text = await res.text().catch(() => '');
        const ok = res.ok;
        results.push({ user_id: uid, status: res.status, ok, ms: Date.now() - tStart, snippet: text.slice(0, 200) });
        console.log(`[sync-inventory-report-all] ${uid} → ${res.status} (${Date.now() - tStart}ms)`);
      } catch (e) {
        results.push({ user_id: uid, error: (e as Error)?.message, ms: Date.now() - tStart });
        console.error(`[sync-inventory-report-all] ${uid} crashed:`, (e as Error)?.message);
      }
      if (i + 1 < userIds.length) await sleep(delayMs);
    }

    return new Response(JSON.stringify({
      ok: true,
      users: userIds.length,
      elapsed_ms: Date.now() - t0,
      results,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    const msg = (err as Error)?.message || String(err);
    console.error('[sync-inventory-report-all] TOP-LEVEL crash:', msg);
    return new Response(JSON.stringify({ ok: false, error: msg, elapsed_ms: Date.now() - t0 }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
