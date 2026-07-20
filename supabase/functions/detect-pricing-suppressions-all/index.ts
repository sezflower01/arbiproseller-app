// Fan-out wrapper for cron. Enumerates users with active seller_authorizations
// and invokes detect-pricing-suppressions per user with a small stagger.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { requireInternalCall } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const { data: auths } = await supabase
      .from('seller_authorizations')
      .select('user_id')
      .eq('is_active', true)
      .not('refresh_token', 'is', null);

    const userIds = Array.from(new Set((auths || []).map((r: any) => r.user_id).filter(Boolean)));

    const results: any[] = [];
    for (const userId of userIds) {
      try {
        const resp = await fetch(`${supabaseUrl}/functions/v1/detect-pricing-suppressions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({ user_id: userId }),
        });
        const text = await resp.text();
        results.push({ user_id: userId, http: resp.status, body_prefix: text.slice(0, 200) });
      } catch (e: any) {
        results.push({ user_id: userId, error: String(e?.message || e) });
      }
      await new Promise((r) => setTimeout(r, 800)); // Stagger per rate-limit rules
    }

    return new Response(JSON.stringify({
      fanned_out: userIds.length,
      finished_at: new Date().toISOString(),
      results,
    }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('[detect-pricing-suppressions-all] error:', e?.message || e);
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
