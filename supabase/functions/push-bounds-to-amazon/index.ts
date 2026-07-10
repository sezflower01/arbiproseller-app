import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { checkModuleAccess } from '../_shared/module-access-guard.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Push min/max bounds to Amazon for assignments that have local bounds
 * but have never had them synced to Amazon (bounds_synced_at IS NULL).
 * 
 * Uses update-amazon-price with updateMinMaxOnly=true to avoid changing the listing price.
 */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('No authorization header');

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) throw new Error('Unauthorized');

    // MODULE ACCESS GUARD: pushing bounds to Amazon = repricer:run
    const access = await checkModuleAccess(supabase, user.id, 'repricer', 'run');
    if (!access.allowed) {
      console.warn(`[push-bounds] MODULE BLOCKED user=${user.id} reason=${access.reason}`);
      return new Response(
        JSON.stringify({ success: false, error: access.reason }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dryRun === true;
    const marketplace = body.marketplace || null;
    const limit = Math.min(body.limit || 50, 200); // Honor frontend request up to 200

    console.log(`[push-bounds] user=${user.id} dryRun=${dryRun} marketplace=${marketplace ?? 'ALL'} limit=${limit}`);

    // Find assignments with local min/max but never pushed to Amazon
    let query = supabase
      .from('repricer_assignments')
      .select('id, asin, sku, marketplace, min_price_override, max_price_override')
      .eq('user_id', user.id)
      .eq('is_enabled', true)
      .not('min_price_override', 'is', null)
      .in('bounds_sync_status', ['pending', 'failed'])
      .order('updated_at', { ascending: true })
      .limit(limit);

    if (marketplace) {
      query = query.eq('marketplace', marketplace);
    }

    const { data: assignments, error: fetchErr } = await query;
    if (fetchErr) throw fetchErr;

    console.log(`[push-bounds] Found ${assignments?.length ?? 0} assignments needing bounds push`);

    if (!assignments || assignments.length === 0) {
      return new Response(
        JSON.stringify({ success: true, pushed: 0, remaining: 0, message: 'All bounds already synced to Amazon' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (dryRun) {
      return new Response(
        JSON.stringify({
          success: true,
          dryRun: true,
          wouldPush: assignments.length,
          sample: assignments.slice(0, 10).map(a => ({
            asin: a.asin, sku: a.sku, marketplace: a.marketplace,
            min: a.min_price_override, max: a.max_price_override,
          })),
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    let pushed = 0;
    let errors = 0;
    const errorDetails: string[] = [];
    const MAX_RETRIES = 2;

    for (const assignment of assignments) {
      let succeeded = false;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const resp = await fetch(`${supabaseUrl}/functions/v1/update-amazon-price`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${supabaseKey}`,
            },
            body: JSON.stringify({
              user_id: user.id,
              asin: assignment.asin,
              sku: assignment.sku,
              marketplace: assignment.marketplace,
              newMinPrice: assignment.min_price_override,
              ...(assignment.max_price_override != null ? { newMaxPrice: assignment.max_price_override } : {}),
              updateMinMaxOnly: true,
              internal: true,
            }),
          });

          const respText = await resp.text();
          let result: any = null;
          try {
            result = JSON.parse(respText);
          } catch {
            console.error(`[push-bounds] ${assignment.asin}/${assignment.marketplace} attempt ${attempt}: Non-JSON response (HTTP ${resp.status}): ${respText.slice(0, 200)}`);
          }

          if (resp.ok && result?.success) {
            succeeded = true;
            pushed++;
            await supabase
              .from('repricer_assignments')
              .update({
                bounds_synced_at: new Date().toISOString(),
                bounds_sync_status: 'synced',
                bounds_sync_attempts: 0,
                last_bounds_sync_error: null,
              })
              .eq('id', assignment.id);
            break; // success, no more retries
          } else {
            const errMsg = result?.error || `HTTP ${resp.status}: ${respText.slice(0, 150)}`;
            console.error(`[push-bounds] FAIL ${assignment.asin}/${assignment.sku}/${assignment.marketplace} attempt ${attempt}/${MAX_RETRIES}: ${errMsg}`);
            
            // On last attempt, record the error
            if (attempt === MAX_RETRIES) {
              errors++;
              errorDetails.push(`${assignment.asin}/${assignment.marketplace}: ${errMsg}`);
              await supabase
                .from('repricer_assignments')
                .update({
                  bounds_sync_status: 'failed',
                  last_bounds_sync_error: errMsg.slice(0, 500),
                  bounds_sync_attempts: (assignment as any).bounds_sync_attempts ? (assignment as any).bounds_sync_attempts + 1 : 1,
                  next_bounds_sync_at: new Date(Date.now() + 120_000).toISOString(),
                })
                .eq('id', assignment.id);
            } else {
              // Wait before retry
              await new Promise(r => setTimeout(r, 1000 * attempt));
            }
          }
        } catch (e: any) {
          console.error(`[push-bounds] EXCEPTION ${assignment.asin}/${assignment.marketplace} attempt ${attempt}/${MAX_RETRIES}: ${(e as Error).message}`);
          if (attempt === MAX_RETRIES) {
            errors++;
            errorDetails.push(`${assignment.asin}/${assignment.marketplace}: EXCEPTION: ${(e as Error).message}`);
            await supabase
              .from('repricer_assignments')
              .update({
                bounds_sync_status: 'failed',
                last_bounds_sync_error: ((e as Error).message || 'unknown').slice(0, 500),
                bounds_sync_attempts: 1,
                next_bounds_sync_at: new Date(Date.now() + 120_000).toISOString(),
              })
              .eq('id', assignment.id);
          } else {
            await new Promise(r => setTimeout(r, 1000 * attempt));
          }
        }
      }

      // Delay between every call to avoid Supabase edge function rate limits
      await new Promise(r => setTimeout(r, 800));
      // Extra delay every 5 pushes
      if (pushed > 0 && pushed % 5 === 0) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    // Check remaining count
    const remainingQuery = supabase
      .from('repricer_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('is_enabled', true)
      .not('min_price_override', 'is', null)
      .in('bounds_sync_status', ['pending', 'failed']);
    const { count: remaining } = marketplace
      ? await remainingQuery.eq('marketplace', marketplace)
      : await remainingQuery;

    // Log first 5 errors in detail for visibility
    if (errorDetails.length > 0) {
      console.error(`[push-bounds] ERROR SAMPLE (${errorDetails.length} total):`);
      for (const ed of errorDetails.slice(0, 5)) {
        console.error(`  → ${ed}`);
      }
    }

    console.log(`[push-bounds] Complete: ${pushed} pushed, ${errors} errors, ${remaining ?? '?'} remaining`);

    return new Response(
      JSON.stringify({
        success: true,
        pushed,
        errors,
        remaining: remaining ?? 0,
        errorDetails: errorDetails.slice(0, 20),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (error: any) {
    console.error('[push-bounds] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
