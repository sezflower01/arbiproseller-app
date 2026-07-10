import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MARKETPLACE_DOMAINS: Record<string, string> = {
  US: 'amazon.com',
  CA: 'amazon.ca',
  MX: 'amazon.com.mx',
  BR: 'amazon.com.br',
};

const toNumber = (value: unknown): number | null => {
  const num = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(num) && num > 0 ? num : null;
};

const normalizeOffers = (offers: any[] = []) => offers
  .map((offer) => {
    const price = toNumber(offer.price) ?? toNumber(offer.ListingPrice?.Amount) ?? 0;
    const shipping = toNumber(offer.shipping) ?? toNumber(offer.Shipping?.Amount) ?? 0;
    const total = toNumber(offer.total_price) ?? toNumber(offer.BuyingPrice?.LandedPrice?.Amount) ?? (price > 0 ? price + shipping : 0);
    const isFba = offer.is_fba === true || offer.fulfillment === 'FBA' || offer.IsFulfilledByAmazon === true;
    return {
      seller_id: offer.seller_id || offer.SellerId || '',
      seller_name: offer.seller_name || offer.seller_id || offer.SellerId || 'Amazon seller',
      price,
      shipping,
      total_price: total,
      is_fba: isFba,
      is_buybox_winner: offer.is_buybox_winner === true || offer.IsBuyBoxWinner === true,
      condition: offer.condition || offer.SubCondition || offer.ItemCondition || 'New',
    };
  })
  .filter((offer) => offer.total_price > 0);

const buildPayload = (input: {
  asin: string;
  marketplace: string;
  fetched_at?: string;
  buybox_price?: number | null;
  buybox_is_fba?: boolean | null;
  lowest_fba_price?: number | null;
  lowest_fbm_price?: number | null;
  lowest_overall_price?: number | null;
  offers_count?: number | null;
  fba_offer_count?: number | null;
  fbm_offer_count?: number | null;
  offers?: any[];
  source: string;
  from_cache: boolean;
}) => {
  const offers = normalizeOffers(input.offers || []);
  const fba = offers.filter((o) => o.is_fba);
  const fbm = offers.filter((o) => !o.is_fba);
  return {
    success: true,
    asin: input.asin,
    marketplace: input.marketplace,
    fetched_at: input.fetched_at || new Date().toISOString(),
    buybox_price: input.buybox_price ?? offers.find((o) => o.is_buybox_winner)?.total_price ?? null,
    buybox_is_fba: input.buybox_is_fba ?? offers.find((o) => o.is_buybox_winner)?.is_fba ?? null,
    lowest_fba_price: input.lowest_fba_price ?? (fba.length ? Math.min(...fba.map((o) => o.total_price)) : null),
    lowest_fbm_price: input.lowest_fbm_price ?? (fbm.length ? Math.min(...fbm.map((o) => o.total_price)) : null),
    lowest_overall_price: input.lowest_overall_price ?? (offers.length ? Math.min(...offers.map((o) => o.total_price)) : null),
    offers_count: input.offers_count ?? offers.length,
    fba_offer_count: input.fba_offer_count ?? fba.length,
    fbm_offer_count: input.fbm_offer_count ?? fbm.length,
    offers,
    from_cache: input.from_cache,
    source: input.source,
  };
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('No authorization header');
    const { data: { user }, error: userError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''));
    if (userError || !user) throw new Error('Unauthorized');

    const { asin, marketplace = 'US' } = await req.json();
    if (!asin) throw new Error('ASIN is required');

    // Try cached snapshot (last 60 min) regardless of who fetched it
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: cached } = await supabase
      .from('repricer_competitor_snapshots')
      .select('*')
      .eq('asin', asin)
      .eq('marketplace', marketplace)
      .gte('fetched_at', cutoff)
      .is('error', null)
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cached) {
      const payload = buildPayload({
        asin: cached.asin,
        marketplace: cached.marketplace,
        fetched_at: cached.fetched_at,
        buybox_price: cached.buybox_price,
        buybox_is_fba: cached.buybox_is_fba,
        lowest_fba_price: cached.lowest_fba_price,
        lowest_fbm_price: cached.lowest_fbm_price,
        lowest_overall_price: cached.lowest_overall_price,
        offers_count: cached.offers_count,
        offers: (cached.offers_json as any[]) || [],
        from_cache: true,
        source: 'cache',
      });
      if (payload.offers.length > 0 || payload.offers_count > 0 || payload.buybox_price || payload.lowest_fba_price || payload.lowest_fbm_price) {
        return new Response(JSON.stringify(payload), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    const authToken = authHeader.replace('Bearer ', '');

    try {
      const spResp = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/repricer-sp-api-pricing`, {
        method: 'POST',
        headers: {
          ...corsHeaders,
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ asin, marketplace, item_condition: 'New', max_retries: 1 }),
      });
      const spData = await spResp.json().catch(() => null);
      if (spResp.ok && spData?.success && spData?.data) {
        const d = spData.data;
        const payload = buildPayload({
          asin,
          marketplace,
          fetched_at: d.fetchedAt,
          buybox_price: d.buyboxPrice,
          buybox_is_fba: d.buyboxIsFba,
          lowest_fba_price: d.lowestFbaPrice,
          lowest_fbm_price: d.lowestFbmPrice,
          lowest_overall_price: d.lowestOverallPrice,
          offers_count: d.totalOfferCount,
          fba_offer_count: d.fbaOfferCount,
          fbm_offer_count: d.fbmOfferCount,
          offers: d.offerBreakdown || [],
          from_cache: false,
          source: d.pricingSource || 'sp-api',
        });

        try {
          await supabase.from('repricer_competitor_snapshots').insert({
            user_id: user.id,
            asin,
            marketplace,
            fetched_at: payload.fetched_at,
            buybox_price: payload.buybox_price,
            buybox_is_fba: payload.buybox_is_fba,
            lowest_fba_price: payload.lowest_fba_price,
            lowest_fbm_price: payload.lowest_fbm_price,
            lowest_overall_price: payload.lowest_overall_price,
            offers_count: payload.offers_count,
            offers_json: payload.offers,
            credits_used: 0,
            source: payload.source,
          });
        } catch (e) {
          console.warn('[sourcer-fetch-offers] sp-api cache insert failed', e);
        }

        return new Response(JSON.stringify(payload), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      console.warn('[sourcer-fetch-offers] SP-API fallback unavailable', spResp.status, spData?.error || spData);
    } catch (e) {
      console.warn('[sourcer-fetch-offers] SP-API fallback failed', e);
    }

    const rainforestApiKey = Deno.env.get('RAINFOREST_API_KEY');
    if (!rainforestApiKey) throw new Error('RAINFOREST_API_KEY not configured');

    const amazonDomain = MARKETPLACE_DOMAINS[marketplace] || 'amazon.com';
    const url = `https://api.rainforestapi.com/request?api_key=${rainforestApiKey}&type=offers&amazon_domain=${amazonDomain}&asin=${asin}&offers_condition_new=true&output=json`;

    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok || data.error) {
      throw new Error(data.error?.message || data.error || 'Rainforest API error');
    }

    const rawOffers = data.offers || [];
    const buyboxOffer = rawOffers.find((o: any) => o.buybox_winner === true);
    const offers = rawOffers.slice(0, 20).map((o: any) => {
      const price = o.price?.value || 0;
      const shipping = o.shipping?.raw ? parseFloat(o.shipping.raw.replace(/[^0-9.]/g, '')) || 0 : 0;
      return {
        seller_id: o.seller?.id || '',
        seller_name: o.seller?.name || 'Unknown Seller',
        price,
        shipping,
        total_price: price + shipping,
        is_fba: o.fulfilment?.type === 'FBA' || o.fulfilment?.is_fulfilled_by_amazon === true,
        is_buybox_winner: o.buybox_winner === true,
        condition: o.condition?.is_new ? 'New' : (o.condition?.title || 'New'),
      };
    });

    const fba = offers.filter((o: any) => o.is_fba);
    const fbm = offers.filter((o: any) => !o.is_fba);
    const bbPrice = buyboxOffer
      ? (buyboxOffer.price?.value || 0) + (buyboxOffer.shipping?.raw ? parseFloat(buyboxOffer.shipping.raw.replace(/[^0-9.]/g, '')) || 0 : 0)
      : null;

    // Best-effort cache write (ignore failures)
    try {
      await supabase.from('repricer_competitor_snapshots').insert({
        user_id: user.id,
        asin,
        marketplace,
        buybox_price: bbPrice,
        buybox_is_fba: buyboxOffer?.fulfilment?.type === 'FBA' || buyboxOffer?.fulfilment?.is_fulfilled_by_amazon === true,
        lowest_fba_price: fba.length ? Math.min(...fba.map((o: any) => o.total_price)) : null,
        lowest_fbm_price: fbm.length ? Math.min(...fbm.map((o: any) => o.total_price)) : null,
        lowest_overall_price: offers.length ? Math.min(...offers.map((o: any) => o.total_price)) : null,
        offers_count: offers.length,
        offers_json: offers,
        credits_used: 1,
        source: 'rainforest',
      });
    } catch (e) {
      console.warn('[sourcer-fetch-offers] cache insert failed', e);
    }

    return new Response(JSON.stringify(buildPayload({
      asin,
      marketplace,
      buybox_price: bbPrice,
      buybox_is_fba: buyboxOffer?.fulfilment?.type === 'FBA' || buyboxOffer?.fulfilment?.is_fulfilled_by_amazon === true,
      lowest_fba_price: fba.length ? Math.min(...fba.map((o: any) => o.total_price)) : null,
      lowest_fbm_price: fbm.length ? Math.min(...fbm.map((o: any) => o.total_price)) : null,
      lowest_overall_price: offers.length ? Math.min(...offers.map((o: any) => o.total_price)) : null,
      offers_count: offers.length,
      offers,
      from_cache: false,
      source: 'rainforest',
    })), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error: any) {
    console.error('[sourcer-fetch-offers] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message || 'Failed to fetch offers' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
