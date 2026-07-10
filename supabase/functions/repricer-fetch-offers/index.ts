import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { checkModuleAccess } from '../_shared/module-access-guard.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface FetchOffersRequest {
  asin: string;
  marketplace?: string; // US, CA, MX, BR
  forceRefresh?: boolean;
}

interface Offer {
  seller_id: string;
  seller_name: string;
  price: number;
  shipping: number;
  total_price: number;
  is_fba: boolean;
  is_buybox_winner: boolean;
  condition: string;
  rating?: number;
  rating_count?: number;
  handling_days?: number | null; // Parsed from "0 to 8 days" → 8 (max value)
  ships_from?: string | null; // Country code or name
}

interface SnapshotResult {
  id: string;
  asin: string;
  marketplace: string;
  fetched_at: string;
  buybox_price: number | null;
  buybox_is_fba: boolean | null;
  buybox_seller_id: string | null;
  buybox_seller_name: string | null;
  lowest_fba_price: number | null;
  lowest_fbm_price: number | null;
  lowest_overall_price: number | null;
  offers_count: number;
  offers: Offer[];
  credits_used: number;
  source: string;
  from_cache: boolean;
}

// Map marketplace to Amazon domain
const MARKETPLACE_DOMAINS: Record<string, string> = {
  US: 'amazon.com',
  CA: 'amazon.ca',
  MX: 'amazon.com.mx',
  BR: 'amazon.com.br',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Auth check
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    // MODULE ACCESS GUARD: fetching live offers spends API credits = repricer:run
    const access = await checkModuleAccess(supabase, user.id, 'repricer', 'run');
    if (!access.allowed) {
      console.warn(`[repricer-fetch-offers] MODULE BLOCKED user=${user.id} reason=${access.reason}`);
      return new Response(
        JSON.stringify({ success: false, error: access.reason }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const body: FetchOffersRequest = await req.json();
    const { asin, marketplace = 'US', forceRefresh = false } = body;

    if (!asin) {
      throw new Error('ASIN is required');
    }

    console.log(`[repricer-fetch-offers] User ${user.id} requesting offers for ${asin} in ${marketplace}`);

    // Get or create user settings
    let { data: settings } = await supabase
      .from('repricer_settings')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!settings) {
      const { data: newSettings, error: insertError } = await supabase
        .from('repricer_settings')
        .insert({ user_id: user.id })
        .select()
        .single();
      
      if (insertError) {
        console.error('Error creating settings:', insertError);
        throw new Error('Failed to initialize repricer settings');
      }
      settings = newSettings;
    }

    // Reset credits if new day
    const today = new Date().toISOString().split('T')[0];
    if (settings.credits_reset_at !== today) {
      await supabase
        .from('repricer_settings')
        .update({ credits_used_today: 0, credits_reset_at: today })
        .eq('user_id', user.id);
      settings.credits_used_today = 0;
    }

    // Check if we have a fresh cached snapshot
    const snapshotTtlMinutes = settings.rainforest_snapshot_ttl_minutes || 60;
    const cutoffTime = new Date(Date.now() - snapshotTtlMinutes * 60 * 1000).toISOString();

    if (!forceRefresh) {
      const { data: cachedSnapshot } = await supabase
        .from('repricer_competitor_snapshots')
        .select('*')
        .eq('user_id', user.id)
        .eq('asin', asin)
        .eq('marketplace', marketplace)
        .gte('fetched_at', cutoffTime)
        .order('fetched_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cachedSnapshot && !cachedSnapshot.error) {
        console.log(`[repricer-fetch-offers] Returning cached snapshot from ${cachedSnapshot.fetched_at}`);
        
        const offers = (cachedSnapshot.offers_json as Offer[]) || [];
        const result: SnapshotResult = {
          id: cachedSnapshot.id,
          asin: cachedSnapshot.asin,
          marketplace: cachedSnapshot.marketplace,
          fetched_at: cachedSnapshot.fetched_at,
          buybox_price: cachedSnapshot.buybox_price,
          buybox_is_fba: cachedSnapshot.buybox_is_fba,
          buybox_seller_id: cachedSnapshot.buybox_seller_id,
          buybox_seller_name: cachedSnapshot.buybox_seller_name,
          lowest_fba_price: cachedSnapshot.lowest_fba_price,
          lowest_fbm_price: cachedSnapshot.lowest_fbm_price,
          lowest_overall_price: cachedSnapshot.lowest_overall_price,
          offers_count: cachedSnapshot.offers_count || offers.length,
          offers,
          credits_used: 0,
          source: 'cache',
          from_cache: true,
        };

        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Check credit budget
    const dailyCreditCap = settings.daily_credit_cap || 100;
    if (settings.credits_used_today >= dailyCreditCap) {
      throw new Error(`Daily credit limit (${dailyCreditCap}) reached. Try again tomorrow or increase your limit.`);
    }

    // Fetch from Rainforest API
    const rainforestApiKey = Deno.env.get('RAINFOREST_API_KEY');
    if (!rainforestApiKey) {
      throw new Error('RAINFOREST_API_KEY not configured');
    }

    const amazonDomain = MARKETPLACE_DOMAINS[marketplace] || 'amazon.com';
    const rainforestUrl = `https://api.rainforestapi.com/request?api_key=${rainforestApiKey}&type=offers&amazon_domain=${amazonDomain}&asin=${asin}&offers_condition_new=true&output=json`;

    console.log(`[repricer-fetch-offers] Calling Rainforest API for ${asin} on ${amazonDomain}`);

    const rainforestResponse = await fetch(rainforestUrl);
    const rainforestData = await rainforestResponse.json();

    if (!rainforestResponse.ok || rainforestData.error) {
      const errorMsg = rainforestData.error?.message || rainforestData.error || 'Rainforest API error';
      console.error('[repricer-fetch-offers] Rainforest error:', errorMsg);

      // Store error snapshot so we don't retry immediately
      await supabase.from('repricer_competitor_snapshots').insert({
        user_id: user.id,
        asin,
        marketplace,
        error: errorMsg,
        credits_used: 1,
        source: 'rainforest',
      });

      // Increment credits used even on error
      await supabase
        .from('repricer_settings')
        .update({ credits_used_today: settings.credits_used_today + 1 })
        .eq('user_id', user.id);

      throw new Error(errorMsg);
    }

    // Parse Rainforest response
    const rawOffers = rainforestData.offers || [];
    const buyboxOffer = rawOffers.find((o: any) => o.buybox_winner === true);
    
    // Helper: Parse handling time ranges like "0 to 8 days" → 8 (use max value for conservative filtering)
    function parseHandlingDays(handlingRaw: any): number | null {
      if (handlingRaw === null || handlingRaw === undefined) return null;
      
      // If already a number
      if (typeof handlingRaw === 'number') return handlingRaw;
      
      // Parse string like "0 to 8 days", "1-2 days", "0 days", "1 day"
      const str = String(handlingRaw).toLowerCase();
      
      // Match patterns: "X to Y days" or "X-Y days" or "X days"
      const rangeMatch = str.match(/(\d+)\s*(?:to|-)\s*(\d+)/);
      if (rangeMatch) {
        // Use the MAX value for conservative filtering
        return Math.max(parseInt(rangeMatch[1], 10), parseInt(rangeMatch[2], 10));
      }
      
      // Single number
      const singleMatch = str.match(/(\d+)/);
      if (singleMatch) {
        return parseInt(singleMatch[1], 10);
      }
      
      return null;
    }

    // Normalize offers
    const offers: Offer[] = rawOffers.slice(0, 20).map((o: any) => ({
      seller_id: o.seller?.id || '',
      seller_name: o.seller?.name || 'Unknown Seller',
      price: o.price?.value || 0,
      shipping: o.shipping?.raw ? parseFloat(o.shipping.raw.replace(/[^0-9.]/g, '')) || 0 : 0,
      total_price: (o.price?.value || 0) + (o.shipping?.raw ? parseFloat(o.shipping.raw.replace(/[^0-9.]/g, '')) || 0 : 0),
      is_fba: o.fulfilment?.type === 'FBA' || o.fulfilment?.is_fulfilled_by_amazon === true,
      is_buybox_winner: o.buybox_winner === true,
      condition: o.condition?.is_new ? 'New' : (o.condition?.title || 'New'),
      rating: o.seller?.rating,
      rating_count: o.seller?.ratings_total,
      // NEW: Parse handling time (use max of range for conservative filtering)
      handling_days: parseHandlingDays(o.delivery?.fulfillment_time?.raw || o.delivery?.max_days || null),
      // NEW: Ships from location
      ships_from: o.delivery?.ships_from?.country || o.ships_from || null,
    }));

    // Calculate aggregates
    const fbaOffers = offers.filter(o => o.is_fba);
    const fbmOffers = offers.filter(o => !o.is_fba);
    
    const lowestFbaPrice = fbaOffers.length > 0 
      ? Math.min(...fbaOffers.map(o => o.total_price))
      : null;
    
    const lowestFbmPrice = fbmOffers.length > 0 
      ? Math.min(...fbmOffers.map(o => o.total_price))
      : null;
    
    const lowestOverallPrice = offers.length > 0 
      ? Math.min(...offers.map(o => o.total_price))
      : null;

    const snapshotData = {
      user_id: user.id,
      asin,
      marketplace,
      buybox_price: buyboxOffer ? (buyboxOffer.price?.value || 0) + (buyboxOffer.shipping?.raw ? parseFloat(buyboxOffer.shipping.raw.replace(/[^0-9.]/g, '')) || 0 : 0) : null,
      buybox_is_fba: buyboxOffer?.fulfilment?.type === 'FBA' || buyboxOffer?.fulfilment?.is_fulfilled_by_amazon === true,
      buybox_seller_id: buyboxOffer?.seller?.id || null,
      buybox_seller_name: buyboxOffer?.seller?.name || null,
      lowest_fba_price: lowestFbaPrice,
      lowest_fbm_price: lowestFbmPrice,
      lowest_overall_price: lowestOverallPrice,
      offers_count: offers.length,
      offers_json: offers,
      credits_used: 1,
      source: 'rainforest',
    };

    // Insert snapshot
    const { data: newSnapshot, error: snapshotError } = await supabase
      .from('repricer_competitor_snapshots')
      .insert(snapshotData)
      .select()
      .single();

    if (snapshotError) {
      console.error('[repricer-fetch-offers] Error saving snapshot:', snapshotError);
      throw new Error('Failed to save competitor snapshot');
    }

    // Increment credits used
    await supabase
      .from('repricer_settings')
      .update({ credits_used_today: settings.credits_used_today + 1 })
      .eq('user_id', user.id);

    console.log(`[repricer-fetch-offers] Saved snapshot with ${offers.length} offers, buybox: $${snapshotData.buybox_price}`);

    const result: SnapshotResult = {
      id: newSnapshot.id,
      asin: newSnapshot.asin,
      marketplace: newSnapshot.marketplace,
      fetched_at: newSnapshot.fetched_at,
      buybox_price: newSnapshot.buybox_price,
      buybox_is_fba: newSnapshot.buybox_is_fba,
      buybox_seller_id: newSnapshot.buybox_seller_id,
      buybox_seller_name: newSnapshot.buybox_seller_name,
      lowest_fba_price: newSnapshot.lowest_fba_price,
      lowest_fbm_price: newSnapshot.lowest_fbm_price,
      lowest_overall_price: newSnapshot.lowest_overall_price,
      offers_count: newSnapshot.offers_count || offers.length,
      offers,
      credits_used: 1,
      source: 'rainforest',
      from_cache: false,
    };

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[repricer-fetch-offers] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message || 'Failed to fetch offers' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
