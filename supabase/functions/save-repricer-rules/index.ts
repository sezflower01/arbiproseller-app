import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { checkModuleAccess } from '../_shared/module-access-guard.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SaveRulesRequest {
  inventoryId: string;
  minPrice?: number | null;
  maxPrice?: number | null;
  myPrice?: number | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    // Module access guard: changing min/max/my_price is a repricer:edit operation,
    // even though it writes to the inventory table. This closes the
    // "inventory side-door" — repricer-permission boundary, not table boundary.
    const access = await checkModuleAccess(supabase, user.id, 'repricer', 'edit');
    if (!access.allowed) {
      console.warn(`[save-repricer-rules] MODULE BLOCKED: ${access.reason}`);
      return new Response(
        JSON.stringify({ success: false, error: access.reason }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body: SaveRulesRequest = await req.json();
    console.log('Save repricer rules request:', body);


    // Validate prices
    if (body.minPrice !== null && body.minPrice !== undefined && body.minPrice < 0) {
      throw new Error('Min price must be >= 0');
    }
    if (body.maxPrice !== null && body.maxPrice !== undefined && body.maxPrice < 0) {
      throw new Error('Max price must be >= 0');
    }
    if (body.myPrice !== null && body.myPrice !== undefined && body.myPrice < 0) {
      throw new Error('My price must be >= 0');
    }

    // Validate min/max/my price relationship if all are set
    if (
      body.minPrice !== null && body.minPrice !== undefined &&
      body.maxPrice !== null && body.maxPrice !== undefined &&
      body.myPrice !== null && body.myPrice !== undefined
    ) {
      if (body.minPrice > body.maxPrice) {
        throw new Error('Min price must be <= Max price');
      }
      if (body.myPrice < body.minPrice || body.myPrice > body.maxPrice) {
        throw new Error('My price must be between Min price and Max price');
      }
    }

    // Update the inventory record
    const { data: updatedItem, error: updateError } = await supabase
      .from('inventory')
      .update({
        min_price: body.minPrice,
        max_price: body.maxPrice,
        my_price: body.myPrice,
      })
      .eq('id', body.inventoryId)
      .eq('user_id', user.id) // Ensure user owns this record
      .select()
      .single();

    if (updateError) {
      console.error('Update error:', updateError);
      throw updateError;
    }

    if (!updatedItem) {
      throw new Error('Inventory item not found or you do not have permission to update it');
    }

    console.log('Repricer rules saved successfully');

    return new Response(
      JSON.stringify({
        success: true,
        item: updatedItem,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    console.error('Save repricer rules error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: (error as Error).message || 'Failed to save repricer rules'
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});
