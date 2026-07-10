// auto-sync-settlements-weekly
// Cron-triggered: iterates all users with seller_authorizations and calls
// sync-settlement-reports for the last 75 days. This guarantees we always
// pull every settlement report well within Amazon's 90-day retention window,
// so a year never falls into the "permanently lost" hole that 2025 did.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const LOOKBACK_DAYS = 75; // pull last 75 days every run — well inside the 90d retention window

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseService = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';

    if (!internalSecret) {
      return new Response(JSON.stringify({ error: 'INTERNAL_SYNC_SECRET not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseService);

    const today = new Date().toISOString().slice(0, 10);
    const fromDate = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);

    // Distinct users with at least one seller authorization
    const { data: users, error: usersErr } = await supabase
      .from('seller_authorizations')
      .select('user_id')
      .not('refresh_token', 'is', null);
    if (usersErr) throw new Error(`Failed to list users: ${usersErr.message}`);

    const userIds = Array.from(new Set((users || []).map((u: any) => u.user_id))).filter(Boolean);
    console.log(`[auto-sync-settlements-weekly] ${userIds.length} users · range ${fromDate} → ${today}`);

    const results: any[] = [];
    for (const userId of userIds) {
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/sync-settlement-reports`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': internalSecret,
            'Authorization': `Bearer ${supabaseService}`,
          },
          body: JSON.stringify({
            action: 'sync',
            targetUserId: userId,
            fromDate,
            toDate: today,
          }),
        });
        const text = await res.text();
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { /* keep raw */ }
        results.push({
          userId,
          status: res.status,
          reportsFound: parsed?.reportsFound,
          processed: parsed?.processed,
          totalLineItems: parsed?.totalLineItems,
          error: res.ok ? null : (parsed?.error || text.slice(0, 200)),
        });
        console.log(`  user=${userId} status=${res.status} reports=${parsed?.reportsFound ?? '?'} processed=${parsed?.processed ?? '?'}`);
        // Pace between users to avoid hammering SP-API and the function pool
        await new Promise(r => setTimeout(r, 5_000));
      } catch (err: any) {
        console.error(`  user=${userId} failed:`, err.message);
        results.push({ userId, status: 'error', error: err.message });
      }
    }

    const ok = results.filter(r => r.status === 200).length;
    return new Response(JSON.stringify({
      ok: true,
      window: { fromDate, toDate: today, lookbackDays: LOOKBACK_DAYS },
      usersProcessed: userIds.length,
      usersSucceeded: ok,
      results,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err: any) {
    console.error('auto-sync-settlements-weekly fatal:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
