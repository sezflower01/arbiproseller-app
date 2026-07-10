import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function isAdmin(email: string): boolean {
  const adminEmails = Deno.env.get('ADMIN_EMAILS')?.split(',').map(e => e.trim().toLowerCase()) || [];
  return adminEmails.includes(email.toLowerCase());
}

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenSetScore(a: string, b: string) {
  const A = new Set(norm(a).split(' '));
  const B = new Set(norm(b).split(' '));
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size;
  return Math.round((inter / Math.max(1, uni)) * 100);
}

function feesFor(salePrice: number, referralPct = 0.15, fbaFlat = 4.5) {
  const referral = salePrice * referralPct;
  const fba = fbaFlat;
  return { referral, fba, total: referral + fba };
}

function roiFrom(salePrice: number, buyCost: number, referralPct = 0.15, fbaFlat = 4.5) {
  const f = feesFor(salePrice, referralPct, fbaFlat);
  const net = salePrice - f.total - buyCost;
  const roi = buyCost > 0 ? (net / buyCost) * 100 : 0;
  const margin = salePrice > 0 ? (net / salePrice) * 100 : 0;
  return { roiPct: Number(roi.toFixed(2)), marginPct: Number(margin.toFixed(2)), fees: f };
}

async function searchGoogleShopping(query: string, supabaseUrl: string, supabaseKey: string, limit = 10) {
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/google-scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({ query, max: limit }),
    });

    if (!response.ok) {
      console.error('Google scrape error:', response.status);
      return [];
    }

    const data = await response.json();
    if (data.blocked) {
      console.warn('Google is blocking requests');
      return [];
    }

    const results = data.results || [];
    return results.map((r: any) => ({
      source: r.retailer || 'Unknown',
      title: r.title || '',
      extracted_price: parsePrice(r.priceText),
      price: r.priceText || '',
      link: r.link || '',
      thumbnail: r.image || '',
    }));
  } catch (error) {
    console.error('Google Shopping search error:', error);
    return [];
  }
}

async function searchGoogleWeb(query: string, supabaseUrl: string, supabaseKey: string, limit = 10) {
  // For web search, we'll use the shopping scraper as fallback
  // since we don't have a dedicated web scraper
  try {
    const results = await searchGoogleShopping(query, supabaseUrl, supabaseKey, limit);
    return results.map((r: any) => ({
      link: r.link,
      title: r.title,
    }));
  } catch (error) {
    console.error('Google Web search error:', error);
    return [];
  }
}

function parsePrice(priceText: string): number {
  const match = priceText?.match(/[\d,]+\.?\d*/);
  if (match) {
    return parseFloat(match[0].replace(/,/g, ''));
  }
  return 0;
}

async function searchAmazon(query: string, apiKey: string, limit = 10) {
  const url = `https://api.rainforestapi.com/request?api_key=${apiKey}&type=search&amazon_domain=amazon.com&search_term=${encodeURIComponent(query)}&max_page=1`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Rainforest error: ${response.status}`);
  const data = await response.json();
  return data.search_results || [];
}

async function getAmazonProduct(asin: string, apiKey: string) {
  const url = `https://api.rainforestapi.com/request?api_key=${apiKey}&type=product&amazon_domain=amazon.com&asin=${asin}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Rainforest product error: ${response.status}`);
  return await response.json();
}

async function processItem(
  item: any,
  supabaseUrl: string,
  supabaseKey: string,
  rainforestKey: string,
  useGoogleShopping: boolean,
  useGoogleWeb: boolean,
  referralPct: number,
  fbaFlat: number
) {
  try {
    let searchTitle = item.title;

    // If no title but has ASIN, fetch from Amazon
    if (!searchTitle && item.asin) {
      const productData = await getAmazonProduct(item.asin, rainforestKey);
      searchTitle = productData.product?.title || '';
    }

    if (!searchTitle) {
      return { error: 'No title available for search' };
    }

    // Search retailers
    const retailerResults: any[] = [];
    
    if (useGoogleShopping) {
      const shoppingResults = await searchGoogleShopping(searchTitle, supabaseUrl, supabaseKey);
      retailerResults.push(...shoppingResults.map((r: any) => ({
        store: r.source || 'Unknown',
        title: r.title || '',
        price: r.extracted_price || r.price || 0,
        link: r.link || '',
        image: r.thumbnail || '',
        source: 'shopping'
      })));
    }

    if (useGoogleWeb) {
      const webResults = await searchGoogleWeb(searchTitle, supabaseUrl, supabaseKey);
      retailerResults.push(...webResults.map((r: any) => ({
        store: new URL(r.link).hostname.replace('www.', ''),
        title: r.title || '',
        price: 0, // Web results don't have prices
        link: r.link || '',
        image: '',
        source: 'web'
      })));
    }

    // Search Amazon
    const amazonResults = await searchAmazon(searchTitle, rainforestKey);
    
    // Find best retailer match
    let bestRetailer = null;
    let bestRetailerScore = 0;

    for (const retailer of retailerResults) {
      if (!retailer.title) continue;
      const score = tokenSetScore(searchTitle, retailer.title);
      if (score > bestRetailerScore) {
        bestRetailerScore = score;
        bestRetailer = retailer;
      }
    }

    // Find best Amazon match
    let bestAmazon = null;
    let bestAmazonScore = 0;

    for (const amz of amazonResults) {
      if (!amz.title) continue;
      const score = tokenSetScore(searchTitle, amz.title);
      if (score > bestAmazonScore) {
        bestAmazonScore = score;
        bestAmazon = amz;
      }
    }

    // If original ASIN provided, prefer that
    if (item.asin) {
      const asinMatch = amazonResults.find((a: any) => a.asin === item.asin);
      if (asinMatch) {
        bestAmazon = asinMatch;
        bestAmazonScore = tokenSetScore(searchTitle, asinMatch.title || '');
      }
    }

    if (!bestRetailer || !bestAmazon) {
      return { error: 'No matches found' };
    }

    const titleScore = Math.round((bestRetailerScore + bestAmazonScore) / 2);
    const matchScore = titleScore; // Simplified without image scoring

    const amazonPrice = bestAmazon.price?.value || 0;
    const retailerPrice = bestRetailer.price || 0;

    let roi = 0;
    let marginPct = 0;
    let fees = null;

    if (amazonPrice > 0 && retailerPrice > 0) {
      const calc = roiFrom(amazonPrice, retailerPrice, referralPct, fbaFlat);
      roi = calc.roiPct;
      marginPct = calc.marginPct;
      fees = calc.fees;
    }

    return {
      g_store: bestRetailer.store,
      g_title: bestRetailer.title,
      g_price: retailerPrice,
      g_link: bestRetailer.link,
      g_image: bestRetailer.image,
      amz_asin: bestAmazon.asin || item.asin,
      amz_title: bestAmazon.title || '',
      amz_price: amazonPrice,
      amz_link: `https://www.amazon.com/dp/${bestAmazon.asin || item.asin}`,
      amz_image: bestAmazon.image || '',
      title_score: titleScore,
      match_score: matchScore,
      roi,
      margin_pct: marginPct,
      fees_json: fees,
      status: 'done',
    };
  } catch (error) {
    console.error('Process item error:', error);
    return { error: error instanceof Error ? (error as Error).message : String(error), status: 'error' };
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get('Authorization')!;
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!isAdmin(user.email!)) {
      return new Response(JSON.stringify({ error: 'Forbidden: Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { batch_id, page_size = 200, general = true, shopping = true } = await req.json();

    const rainforestKey = Deno.env.get('RAINFOREST_API_KEY')!;
    const referralPct = parseFloat(Deno.env.get('REFERRAL_FEE_PCT') || '0.15');
    const fbaFlat = parseFloat(Deno.env.get('FBA_FEE_FLAT') || '4.50');

    // Fetch queued items
    const { data: items, error: itemsError } = await supabase
      .from('keepa_items')
      .select('*')
      .eq('batch_id', batch_id)
      .eq('status', 'queued')
      .order('idx')
      .limit(page_size);

    if (itemsError) {
      return new Response(JSON.stringify({ error: itemsError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!items || items.length === 0) {
      // Mark batch as done
      await supabase
        .from('keepa_batches')
        .update({ status: 'done' })
        .eq('id', batch_id);

      return new Response(JSON.stringify({
        processed: 0,
        remaining: 0,
        status: 'done',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Mark batch as running
    await supabase
      .from('keepa_batches')
      .update({ status: 'running' })
      .eq('id', batch_id);

    // Process items with concurrency control
    const concurrency = 10;
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    
    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);
      
      await Promise.all(batch.map(async (item) => {
        const result = await processItem(
          item,
          supabaseUrl,
          supabaseKey,
          rainforestKey,
          shopping,
          general,
          referralPct,
          fbaFlat
        );

        await supabase
          .from('keepa_items')
          .update(result)
          .eq('id', item.id);

        await supabase
          .from('keepa_batches')
          .update({ processed_rows: supabase.rpc('increment') })
          .eq('id', batch_id);
      }));

      // Rate limiting delay
      if (i + concurrency < items.length) {
        await delay(500);
      }
    }

    // Check if more items remain
    const { count } = await supabase
      .from('keepa_items')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batch_id)
      .eq('status', 'queued');

    const status = (count || 0) === 0 ? 'done' : 'running';
    
    await supabase
      .from('keepa_batches')
      .update({ status })
      .eq('id', batch_id);

    return new Response(JSON.stringify({
      processed: items.length,
      remaining: count || 0,
      status,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Process error:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? (error as Error).message : String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});