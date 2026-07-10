import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Token-set Jaccard similarity
function calculateTitleSimilarity(title1: string, title2: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, '').trim().split(/\s+/);
  const tokens1 = new Set(normalize(title1));
  const tokens2 = new Set(normalize(title2));
  
  const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);
  
  return union.size === 0 ? 0 : Math.round((intersection.size / union.size) * 100);
}

// Calculate ROI - NOTE: This automation page uses estimates for lead scoring only
// These estimates are acceptable here as this is for product research, not accounting
// The strict "no fallback" rule applies to Sales Report and financial tracking
function calculateROI(retailPrice: number, amazonPrice: number): { roi: number; margin: number; fees: any } {
  // For automation/lead gen, we use rough estimates (acceptable for research purposes)
  // This does NOT affect Sales Report or financial tracking which use strict mode
  const estimatedReferralRate = 0.15; // ~15% is typical for most categories
  const estimatedFbaFee = 4.50; // Rough average for standard size items
  const referralFee = amazonPrice * estimatedReferralRate;
  const fbaFee = estimatedFbaFee;
  const totalFees = referralFee + fbaFee;
  const profit = amazonPrice - retailPrice - totalFees;
  const roi = retailPrice > 0 ? (profit / retailPrice) * 100 : 0;
  const margin = amazonPrice > 0 ? (profit / amazonPrice) * 100 : 0;
  
  return {
    roi: Math.round(roi * 100) / 100,
    margin: Math.round(margin * 100) / 100,
    fees: { referral: referralFee, fba: fbaFee, total: totalFees, note: 'estimated for lead scoring' }
  };
}

async function searchGoogleShopping(query: string, supabaseUrl: string, supabaseKey: string): Promise<any[]> {
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/google-scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({ query, max: 10 }),
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
      title: r.title,
      link: r.link,
      price: r.priceText,
      source: r.retailer,
      thumbnail: r.image,
    }));
  } catch (error) {
    console.error('Google Shopping search error:', error);
    return [];
  }
}

async function searchAmazon(query: string, apiKey: string): Promise<any[]> {
  try {
    const url = `https://api.rainforestapi.com/request?api_key=${apiKey}&type=search&amazon_domain=amazon.com&search_term=${encodeURIComponent(query)}&max_page=1`;
    const response = await fetch(url);
    
    if (!response.ok) {
      if (response.status === 429) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        return searchAmazon(query, apiKey);
      }
      console.error('Rainforest API error:', response.status);
      return [];
    }
    
    const data = await response.json();
    return data.search_results || [];
  } catch (error) {
    console.error('Amazon search error:', error);
    return [];
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const rainforestKey = Deno.env.get('RAINFOREST_API_KEY')!;
    
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { run_id, page_size = 50 } = await req.json();

    // Get run details
    const { data: run, error: runError } = await supabase
      .from('automation_runs')
      .select('*')
      .eq('id', run_id)
      .eq('user_id', user.id)
      .single();

    if (runError || !run) {
      return new Response(JSON.stringify({ error: 'Run not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (run.status === 'done') {
      return new Response(JSON.stringify({ status: 'done', message: 'Run already completed' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get cursor
    const { data: cursor } = await supabase
      .from('automation_run_cursor')
      .select('last_seen_id')
      .eq('run_id', run_id)
      .single();

    // Fetch next page of products
    let query = supabase
      .from('product_catalog')
      .select('*')
      .order('id')
      .limit(page_size);

    if (cursor?.last_seen_id) {
      query = query.gt('id', cursor.last_seen_id);
    }

    const { data: products, error: productsError } = await query;

    if (productsError) {
      console.error('Products fetch error:', productsError);
      return new Response(JSON.stringify({ error: productsError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!products || products.length === 0) {
      // Mark run as done
      await supabase
        .from('automation_runs')
        .update({ status: 'done' })
        .eq('id', run_id);

      return new Response(JSON.stringify({ status: 'done', processed: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check/deduct credits (skip for admins)
    const { data: roles } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .single();

    const isAdmin = !!roles;
    const creditsNeeded = products.length * 1;

    if (!isAdmin) {
      const { error: creditError } = await supabase.rpc('deduct_credits', {
        user_id: user.id,
        amount: creditsNeeded
      });

      if (creditError) {
        await supabase
          .from('automation_runs')
          .update({ status: 'failed', error: 'Insufficient credits' })
          .eq('id', run_id);

        return new Response(JSON.stringify({ error: 'Insufficient credits' }), {
          status: 402,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Update run status to running
    await supabase
      .from('automation_runs')
      .update({ status: 'running' })
      .eq('id', run_id);

    // Process products with concurrency limit
    const concurrency = 5;
    const results = [];
    
    for (let i = 0; i < products.length; i += concurrency) {
      const batch = products.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (product) => {
          try {
            // Search Google Shopping
            const googleResults = await searchGoogleShopping(product.title, supabaseUrl, supabaseKey);
            await new Promise(resolve => setTimeout(resolve, 500)); // Rate limit delay

            // Search Amazon
            const amazonResults = await searchAmazon(product.title, rainforestKey);
            await new Promise(resolve => setTimeout(resolve, 500)); // Rate limit delay

            if (googleResults.length === 0 || amazonResults.length === 0) {
              return {
                run_id,
                catalog_id: product.id,
                input_title: product.title,
                input_asin: product.asin,
                status: 'no_results',
                error: 'No results found'
              };
            }

            // Best Google result
            const bestGoogle = googleResults[0];
            // Best Amazon result
            const bestAmazon = amazonResults[0];

            // Calculate similarity
            const titleScore = calculateTitleSimilarity(product.title, bestAmazon.title || '');
            const matchScore = titleScore; // Simplified (can add image scoring later)

            // Calculate ROI
            const googlePrice = parseFloat(bestGoogle.price?.replace(/[^0-9.]/g, '') || '0');
            const amazonPrice = parseFloat(bestAmazon.price?.value || '0');
            const { roi, margin, fees } = calculateROI(googlePrice, amazonPrice);

            return {
              run_id,
              catalog_id: product.id,
              input_title: product.title,
              input_asin: product.asin,
              g_store: bestGoogle.source || '',
              g_title: bestGoogle.title || '',
              g_price: googlePrice || null,
              g_link: bestGoogle.link || '',
              g_image: bestGoogle.thumbnail || '',
              amz_asin: bestAmazon.asin || '',
              amz_title: bestAmazon.title || '',
              amz_price: amazonPrice || null,
              amz_link: bestAmazon.link || '',
              amz_image: bestAmazon.image || '',
              title_score: titleScore,
              image_score: null,
              match_score: matchScore,
              roi,
              margin_pct: margin,
              fees_json: fees,
              status: 'done'
            };
          } catch (error) {
            console.error(`Error processing product ${product.id}:`, error);
            return {
              run_id,
              catalog_id: product.id,
              input_title: product.title,
              input_asin: product.asin,
              status: 'error',
              error: error instanceof Error ? (error as Error).message : 'Unknown error'
            };
          }
        })
      );
      
      results.push(...batchResults);
    }

    // Insert results
    if (results.length > 0) {
      const { error: insertError } = await supabase
        .from('automation_results')
        .insert(results);

      if (insertError) {
        console.error('Results insert error:', insertError);
      }
    }

    // Update cursor
    const lastProduct = products[products.length - 1];
    await supabase
      .from('automation_run_cursor')
      .update({ last_seen_id: lastProduct.id, last_updated: new Date().toISOString() })
      .eq('run_id', run_id);

    return new Response(JSON.stringify({ 
      status: 'processing', 
      processed: products.length,
      has_more: products.length === page_size
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Process automation error:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? (error as Error).message : 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});