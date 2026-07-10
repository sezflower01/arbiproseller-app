import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

/**
 * Clear Inflated Prices
 * 
 * Clears estimated_price values for pending orders so the UI falls back to live inventory prices.
 * This fixes the "inflated Month-to-Date" problem caused by stale/wrong estimated prices.
 * 
 * Parameters:
 * - scope: 'period' (current date range) | 'all' (all historical)
 * - startDate: ISO date string (required for period scope)
 * - endDate: ISO date string (required for period scope)
 * - dryRun: if true, just report what would be cleared without making changes
 */

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

  // Get auth header for user identification
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Create client with user's auth to get their ID
  const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
  if (userError || !user) {
    console.error('[clear-inflated-prices] Auth error:', userError);
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const userId = user.id;
  console.log(`[clear-inflated-prices] Starting for user ${userId}`);

  // Parse request body
  let scope: 'period' | 'all' = 'period';
  let startDate: string | null = null;
  let endDate: string | null = null;
  let dryRun = false;

  try {
    const body = await req.json();
    scope = body.scope || 'period';
    startDate = body.startDate || null;
    endDate = body.endDate || null;
    dryRun = body.dryRun === true;
  } catch {
    // Use defaults
  }

  console.log(`[clear-inflated-prices] Scope: ${scope}, dryRun: ${dryRun}`);
  if (startDate && endDate) {
    console.log(`[clear-inflated-prices] Date range: ${startDate} to ${endDate}`);
  }

  // Service role client for database operations
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // Query orders with potentially inflated prices.
    // Strategy: Target both pending orders AND shipped orders with suspicious pricing.
    // Shipped orders with price_source containing 'inventory' or very high estimated_price 
    // are likely bugs from historical data.
    
    // First, get pending-like orders
    const PENDING_STATUSES = ['Pending', 'Unshipped', 'PendingAvailability', 'PartiallyShipped'];
    
    let pendingQuery = supabase
      .from('sales_orders')
      .select('id, order_id, asin, estimated_price, sold_price, total_sale_amount, order_status, price_source, order_date')
      .eq('user_id', userId)
      .in('order_status', PENDING_STATUSES)
      .or('estimated_price.not.is.null,sold_price.gt.0,total_sale_amount.gt.0');

    // Apply date filter for 'period' scope
    if (scope === 'period' && startDate && endDate) {
      pendingQuery = pendingQuery.gte('order_date', startDate).lte('order_date', endDate);
    }
    
    // Also get shipped orders with inflated prices (price_source indicates bad data)
    let shippedQuery = supabase
      .from('sales_orders')
      .select('id, order_id, asin, estimated_price, sold_price, total_sale_amount, order_status, price_source, order_date')
      .eq('user_id', userId)
      .eq('order_status', 'Shipped')
      .or('price_source.eq.inventory_refresh,price_source.eq.pricing_api_mx,price_source.eq.pricing_api_ca,price_source.eq.pricing_api_br')
      .gt('sold_price', 100); // Only target obviously inflated prices
      
    if (scope === 'period' && startDate && endDate) {
      shippedQuery = shippedQuery.gte('order_date', startDate).lte('order_date', endDate);
    }

    const [pendingResult, shippedResult] = await Promise.all([
      pendingQuery,
      shippedQuery
    ]);

    if (pendingResult.error) {
      console.error('[clear-inflated-prices] Failed to fetch pending orders:', pendingResult.error);
      return new Response(JSON.stringify({ error: 'Failed to fetch pending orders' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    
    if (shippedResult.error) {
      console.error('[clear-inflated-prices] Failed to fetch shipped orders:', shippedResult.error);
      return new Response(JSON.stringify({ error: 'Failed to fetch shipped orders' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const pendingOrders = pendingResult.data || [];
    const shippedOrders = shippedResult.data || [];
    const allOrders = [...pendingOrders, ...shippedOrders];

    console.log(
      `[clear-inflated-prices] Found ${pendingOrders.length} pending + ${shippedOrders.length} shipped inflated = ${allOrders.length} total orders to clear`
    );

    if (dryRun) {
      return new Response(JSON.stringify({
        success: true,
        dryRun: true,
        pendingCount: pendingOrders.length,
        shippedCount: shippedOrders.length,
        count: allOrders.length,
        message: `Would clear ${pendingOrders.length} pending + ${shippedOrders.length} shipped inflated orders`,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (allOrders.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        cleared: 0,
        message: 'No orders with inflated pricing found',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Clear in batches
    const BATCH_SIZE = 100;
    let cleared = 0;
    let failed = 0;

    for (let i = 0; i < allOrders.length; i += BATCH_SIZE) {
      const batch = allOrders.slice(i, i + BATCH_SIZE);
      const ids = batch.map(o => o.id);

      const { error: updateError } = await supabase
        .from('sales_orders')
        .update({
           // Clear all stored pricing so UI falls back to snapshot/inventory live pricing
           estimated_price: null,
           sold_price: 0,
           total_sale_amount: 0,
           price_source: 'cleared_estimated',
        })
        .in('id', ids);

      if (updateError) {
        console.error(`[clear-inflated-prices] Batch update error:`, updateError);
        failed += batch.length;
      } else {
        cleared += batch.length;
        console.log(`[clear-inflated-prices] Cleared batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} orders`);
      }
    }

    console.log(`[clear-inflated-prices] Complete: ${cleared} cleared, ${failed} failed`);

    return new Response(JSON.stringify({
      success: true,
      cleared,
      failed,
      message: `Cleared stored pricing for ${cleared} pending-like orders. UI will now fall back to snapshot/live inventory prices.`,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[clear-inflated-prices] Fatal error:', error);
    return new Response(JSON.stringify({
      error: (error as Error).message || 'Unknown error',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
