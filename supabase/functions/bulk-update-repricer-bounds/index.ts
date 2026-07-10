import { createClient } from 'npm:@supabase/supabase-js@2.57.2';
import { checkMarketplaceAccess } from '../_shared/marketplace-guard.ts';
import { checkModuleAccess } from '../_shared/module-access-guard.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const minPrice = body.minPrice ?? 0;
    const maxPrice = body.maxPrice ?? 300;
    const marketplace = body.marketplace || 'US';
    
    let userId: string;

    // Check for authorization header first
    const authHeader = req.headers.get('Authorization');
    if (authHeader) {
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: userError } = await supabase.auth.getUser(token);
      if (userError || !user) {
        throw new Error('Unauthorized');
      }
      userId = user.id;
    } else if (body.userId) {
      // Allow passing userId directly for admin/testing purposes
      userId = body.userId;
    } else {
      throw new Error('No authorization header or userId provided');
    }

    // Marketplace guard: non-admins can only update their home marketplace
    const guard = await checkMarketplaceAccess(supabase, userId, marketplace);
    if (!guard.allowed) {
      console.warn(`[bulk-update-bounds] BLOCKED: ${guard.reason}`);
      return new Response(
        JSON.stringify({ success: false, error: guard.reason }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Module access guard: repricer:edit required (changing min/max bounds is an edit op).
    const access = await checkModuleAccess(supabase, userId, 'repricer', 'edit');
    if (!access.allowed) {
      console.warn(`[bulk-update-bounds] MODULE BLOCKED: ${access.reason}`);
      return new Response(
        JSON.stringify({ success: false, error: access.reason }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Bulk updating repricer bounds for user ${userId} marketplace=${marketplace}: min=${minPrice}, max=${maxPrice}`);

    // Update assignments for this user filtered by marketplace to prevent cross-marketplace contamination
    const { data: updated, error: updateError } = await supabase
      .from('repricer_assignments')
      .update({
        min_price_override: minPrice,
        manual_min_price: minPrice > 0 ? minPrice : null,
        max_price_override: maxPrice,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('marketplace', marketplace)
      .select('id, asin, sku, min_price_override, max_price_override');

    if (updateError) {
      console.error('Update error:', updateError);
      throw updateError;
    }

    console.log(`Updated ${updated?.length ?? 0} assignments`);

    return new Response(
      JSON.stringify({
        success: true,
        updated: updated?.length ?? 0,
        marketplace,
        minPrice,
        maxPrice,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Bulk update error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: (error as Error).message || 'Failed to bulk update bounds'
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});
