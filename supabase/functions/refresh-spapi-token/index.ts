import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';
import { getLWAAccessToken } from '../_shared/sp-api-sigv4.ts';
import { requireInternalCall } from '../_shared/require-internal.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  try {
    const { user_id } = await req.json();
    if (!user_id || typeof user_id !== 'string') {
      return new Response(JSON.stringify({ error: 'user_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: authRows, error: authError } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id, seller_id, selling_partner_id, is_active')
      .eq('user_id', user_id);

    if (authError) throw authError;

    const activeAuths = (authRows || []).filter((a: any) => a.is_active !== false && a.refresh_token);
    const sellerAuth = activeAuths.find((a: any) => a.marketplace_id === 'ATVPDKIKX0DER') || activeAuths[0];

    if (!sellerAuth) {
      return new Response(JSON.stringify({ error: 'No active Amazon authorization found for user' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const accessToken = await getLWAAccessToken(sellerAuth.refresh_token);

    return new Response(JSON.stringify({ access_token: accessToken }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[refresh-spapi-token] error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
