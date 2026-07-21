import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { listing_id } = await req.json();
    if (!listing_id || typeof listing_id !== 'string') {
      return new Response(JSON.stringify({ error: 'listing_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: listing, error: listingErr } = await supabase
      .from('created_listings')
      .select('id, user_id, asin, sku')
      .eq('id', listing_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (listingErr) throw listingErr;
    if (!listing) {
      return new Response(JSON.stringify({ error: 'Listing not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { error: updateErr } = await supabase
      .from('created_listings')
      .update({
        validation_status: 'PENDING_VALIDATION',
        validation_failure_code: null,
        validation_failure_reason: null,
        validation_completed_at: null,
        validation_attempts: 0,
        validation_started_at: new Date().toISOString(),
      })
      .eq('id', listing.id);
    if (updateErr) throw updateErr;

    const { error: queueErr } = await supabase.from('listing_validation_queue').upsert({
      listing_id: listing.id,
      user_id: user.id,
      asin: listing.asin,
      sku: listing.sku,
      marketplace: 'US',
      next_stage: 'await_fnsku',
      attempts: 0,
      next_run_at: new Date().toISOString(),
      last_error: null,
    }, { onConflict: 'listing_id' });
    if (queueErr) throw queueErr;

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[retry-listing-validation] error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
