import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper functions
function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenSetScore(a: string, b: string) {
  const A = new Set(norm(a).split(' '));
  const B = new Set(norm(b).split(' '));
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return Math.round((inter / uni) * 100);
}

function feesAndRoi(amzPrice: number, buyCost: number, referralPct = 15, fbaFlat = 4.5) {
  const referral = amzPrice * (referralPct / 100);
  const totalFees = referral + fbaFlat;
  const profit = amzPrice - totalFees - buyCost;
  const roi = buyCost > 0 ? (profit / buyCost) * 100 : 0;
  const margin = amzPrice > 0 ? (profit / amzPrice) * 100 : 0;
  return {
    roiPct: +roi.toFixed(2),
    marginPct: +margin.toFixed(2),
    fees: { referralFee: referral, fbaFee: fbaFlat, total: totalFees }
  };
}

// AWS Signature V4 signing
async function signRequest(
  method: string,
  url: string,
  accessToken: string,
  region: string,
  body?: string
) {
  const awsAccessKey = Deno.env.get('AWS_ACCESS_KEY_ID');
  const awsSecretKey = Deno.env.get('AWS_SECRET_ACCESS_KEY');
  
  const urlObj = new URL(url);
  const host = urlObj.hostname;
  const canonicalUri = urlObj.pathname;
  const canonicalQuerystring = urlObj.search.slice(1);
  
  const amzDate = new Date().toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  
  // Canonical headers
  const canonicalHeaders = 
    `host:${host}\n` +
    `x-amz-access-token:${accessToken}\n` +
    `x-amz-date:${amzDate}\n`;
  
  const signedHeaders = 'host;x-amz-access-token;x-amz-date';
  
  // Hash payload
  const encoder = new TextEncoder();
  const payloadHash = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(body || '')
  );
  const payloadHashHex = Array.from(new Uint8Array(payloadHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  // Canonical request
  const canonicalRequest =
    `${method}\n${canonicalUri}\n${canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHashHex}`;
  
  // String to sign
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/execute-api/aws4_request`;
  
  const canonicalRequestHash = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(canonicalRequest)
  );
  const canonicalRequestHashHex = Array.from(new Uint8Array(canonicalRequestHash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  const stringToSign =
    `${algorithm}\n${amzDate}\n${credentialScope}\n${canonicalRequestHashHex}`;
  
  // Calculate signature
  async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
    return new Uint8Array(signature);
  }
  
  let kDate = await hmac(encoder.encode(`AWS4${awsSecretKey}`), dateStamp);
  let kRegion = await hmac(kDate, region);
  let kService = await hmac(kRegion, 'execute-api');
  let kSigning = await hmac(kService, 'aws4_request');
  let signature = await hmac(kSigning, stringToSign);
  
  const signatureHex = Array.from(signature)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  // Authorization header
  const authorizationHeader =
    `${algorithm} Credential=${awsAccessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signatureHex}`;
  
  return {
    'Authorization': authorizationHeader,
    'x-amz-access-token': accessToken,
    'x-amz-date': amzDate,
    'Content-Type': 'application/json',
  };
}

// Get LWA access token for SP-API
async function getLWAAccessToken() {
  const clientId = Deno.env.get('SPAPI_LWA_CLIENT_ID');
  const clientSecret = Deno.env.get('SPAPI_LWA_CLIENT_SECRET');
  const refreshToken = Deno.env.get('SPAPI_REFRESH_TOKEN');
  
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken!,
      client_id: clientId!,
      client_secret: clientSecret!,
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`LWA token error: ${response.status} - ${error}`);
  }
  
  const data = await response.json();
  return data.access_token;
}

async function enrichAsinWithSPAPI(asin: string): Promise<any> {
  const accessToken = await getLWAAccessToken();
  const marketplaceId = Deno.env.get('SPAPI_MARKETPLACE_ID');
  const region = Deno.env.get('SPAPI_AWS_REGION') || 'us-east-1';
  
  // Use Catalog Items API 2022-04-01 to get product details (include productTypes for category)
  const catalogUrl = `https://sellingpartnerapi-na.amazon.com/catalog/2022-04-01/items/${asin}?marketplaceIds=${marketplaceId}&includedData=summaries,images,salesRanks,productTypes`;
  
  const catalogHeaders = await signRequest('GET', catalogUrl, accessToken, region);
  
  const response = await fetch(catalogUrl, {
    method: 'GET',
    headers: catalogHeaders,
  });
  
  if (response.status === 429) {
    console.warn(`Rate limited for ${asin} (catalog). Returning null data.`);
    return { amz_title: null, amz_price: null, amz_image: null, amz_link: `https://www.amazon.com/dp/${asin}`, category: null };
  }
  
  if (!response.ok) {
    const error = await response.text();
    console.error(`SP-API catalog error for ${asin}:`, response.status, error);
    return { amz_title: null, amz_price: null, amz_image: null, amz_link: `https://www.amazon.com/dp/${asin}`, category: null };
  }
  
  const data = await response.json();
  const summaries = data.summaries?.[0];
  const images = data.images?.[0]?.images?.[0]?.link;
  
  // Extract category from productTypes (only main category, not subcategory)
  let category = '';
  if (data.productTypes && data.productTypes.length > 0) {
    const fullCategory = data.productTypes[0].productType || '';
    // Extract main category only (before underscore)
    category = fullCategory.split('_')[0];
  }
  
  // For price, we need to call Product Pricing API
  let price = null;
  try {
    const priceUrl = `https://sellingpartnerapi-na.amazon.com/products/pricing/v0/items/${asin}/offers?MarketplaceId=${marketplaceId}&ItemCondition=New`;
    const priceHeaders = await signRequest('GET', priceUrl, accessToken, region);
    
    const priceResponse = await fetch(priceUrl, {
      method: 'GET',
      headers: priceHeaders,
    });
    
    if (priceResponse.status === 429) {
      console.warn(`Rate limited on pricing for ${asin}. Skipping retry per no-delay requirement`);
    }
    
    if (priceResponse.ok) {
      const priceData = await priceResponse.json();
      const buyBoxPrice = priceData.payload?.Summary?.BuyBoxPrices?.[0];
      if (buyBoxPrice?.LandedPrice?.Amount) {
        price = parseFloat(buyBoxPrice.LandedPrice.Amount);
      }
    } else {
      console.warn(`Could not fetch price for ${asin}:`, priceResponse.status);
    }
  } catch (error) {
    console.warn('Could not fetch price from SP-API:', error);
  }
  
  return {
    amz_title: summaries?.itemName || null,
    amz_price: price,
    amz_image: images || null,
    amz_link: `https://www.amazon.com/dp/${asin}`,
    category: category || null,
  };
}

async function searchGoogleShopping(query: string) {
  const apiKey = Deno.env.get('GOOGLE_API_KEY');
  const cx = Deno.env.get('GOOGLE_CX_ID');
  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=5`;
  
  if (!apiKey || !cx) {
    console.error('Missing GOOGLE_API_KEY or GOOGLE_CX_ID');
    return [];
  }

  // Add delay before API call to prevent rate limiting
  await delay(150);
  
  const response = await fetch(url);
  if (!response.ok) {
    const errText = await response.text();
    console.error(`Google Custom Search API error: ${response.status} - ${errText}`);
    return [];
  }
  
  const data = await response.json();
  const results = (data.items || []).map((item: any) => {
    const title = item.title || '';
    const link = item.link || '';
    const snippet = item.snippet || '';
    const image = item.pagemap?.cse_image?.[0]?.src || '';
    
    // Extract price from snippet using regex
    const priceMatch = snippet.match(/\$\s?([0-9]+(?:\.[0-9]{2})?)/);
    const price = priceMatch ? parseFloat(priceMatch[1]) : 0;
    
    // Extract store name from link domain
    const storeName = link ? new URL(link).hostname.replace('www.', '') : 'Unknown';
    
    return {
      store: storeName,
      title,
      price,
      link,
      image,
      source: 'shopping',
    };
  }).filter((r: any) => r.link && !r.link.includes('google.com')); // Filter out Google redirect URLs
  
  console.log(`Google Custom Search found ${results.length} results for "${query.substring(0, 50)}..."`);
  return results;
}

async function searchGoogleWeb(query: string) {
  const apiKey = Deno.env.get('GOOGLE_API_KEY');
  const cx = Deno.env.get('GOOGLE_CX_ID');
  const retailers = ['walmart.com', 'target.com', 'bestbuy.com', 'homedepot.com', 'lowes.com'];
  const siteQuery = retailers.map(r => `site:${r}`).join(' OR ');
  const fullQuery = `"${query}" ${siteQuery}`;
  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(fullQuery)}&num=5`;
  
  if (!apiKey || !cx) {
    console.error('Missing GOOGLE_API_KEY or GOOGLE_CX_ID');
    return [];
  }

  // Add delay before API call to prevent rate limiting
  await delay(150);
  
  const response = await fetch(url);
  if (!response.ok) {
    const errText = await response.text();
    console.error(`Google Custom Search API error: ${response.status} - ${errText}`);
    return [];
  }
  
  const data = await response.json();
  const results = (data.items || []).map((item: any) => {
    const link = item.link || '';
    const snippet = item.snippet || '';
    
    // Extract price from snippet using regex
    const priceMatch = snippet.match(/\$\s?([0-9]+(?:\.[0-9]{2})?)/);
    const price = priceMatch ? parseFloat(priceMatch[1]) : 0;
    
    return {
      store: link ? new URL(link).hostname.replace('www.', '') : 'Unknown',
      title: item.title || '',
      price,
      link,
      image: item.pagemap?.cse_image?.[0]?.src || '',
      source: 'google',
    };
  }).filter((r: any) => r.link && retailers.some(domain => r.link.includes(domain)));
  
  console.log(`Google Custom Search found ${results.length} retailer results for "${query.substring(0, 50)}..."`);
  return results;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    // Treat calls signed with the service role key as internal (for self-continue)
    const isInternal = token && token === serviceKey;
    let isAdmin = false;

    if (!isInternal) {
      const { data: { user } } = await supabaseClient.auth.getUser(token);
      const adminEmails = (Deno.env.get('ADMIN_EMAILS') || '').split(',').map(e => e.trim());
      isAdmin = !!user?.email && adminEmails.includes(user.email);

      if (!user?.email) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (!isAdmin) {
        return new Response(JSON.stringify({ error: 'Admin access required' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    const { batch_id, page_size = 100, useShopping = true, useGoogle = true } = await req.json();
    // Reduce batch size to prevent database lock contention and CPU overload
    const effectivePageSize = Math.min(page_size, 5);

    // Update batch status
    await supabaseClient
      .from('asin_batches')
      .update({ status: 'running' })
      .eq('id', batch_id);

    // Get next queued items
    const { data: items } = await supabaseClient
      .from('asin_items')
      .select('*')
      .eq('batch_id', batch_id)
      .eq('status', 'queued')
      .order('idx')
      .limit(effectivePageSize);

    if (!items || items.length === 0) {
      await supabaseClient
        .from('asin_batches')
        .update({ status: 'done' })
        .eq('id', batch_id);

      return new Response(
        JSON.stringify({ processed: 0, remaining: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const referralPct = parseFloat(Deno.env.get('REFERRAL_FEE_PCT') || '15');
    const fbaFlat = parseFloat(Deno.env.get('FBA_FEE_FLAT') || '4.5');
    const matchReviewMin = parseInt(Deno.env.get('MATCH_REVIEW_MIN') || '70');

    // Track processed count to update live
    const { count: initialProcessedCount } = await supabaseClient
      .from('asin_items')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batch_id)
      .neq('status', 'queued');
    let processedSoFar = initialProcessedCount || 0;

    // Process items with time budget to avoid timeouts
    const startTime = Date.now();
    for (const item of items) {
      if (Date.now() - startTime > 48000) {
        break;
      }
      
      // Add delay between items to reduce CPU load and prevent rate limiting
      await delay(200 + Math.random() * 100); // 200-300ms delay with jitter
      
      try {
        // Check for cancel request before processing each item
        const { data: batchStatus } = await supabaseClient
          .from('asin_batches')
          .select('status, total')
          .eq('id', batch_id)
          .single();
        if (batchStatus?.status === 'canceled') {
          const remainingNow = (batchStatus.total || 0) - processedSoFar;
          return new Response(
            JSON.stringify({ processed: 0, remaining: remainingNow, canceled: true }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        await supabaseClient
          .from('asin_items')
          .update({ status: 'running' })
          .eq('id', item.id);
        
        // Enrich ASIN with SP-API (now returns null data instead of throwing on rate limit)
        const amazon = await enrichAsinWithSPAPI(item.asin);
        
        if (!amazon.amz_title || !amazon.amz_price) {
          // Mark as queued (not done) - rate limited or data unavailable
          await supabaseClient
            .from('asin_items')
            .update({
              status: 'queued',
              error: 'Rate limited or data unavailable',
              ...amazon,
            })
            .eq('id', item.id);
        } else {

          // Search retailers
          let results: any[] = [];
          if (useShopping) {
            const shopping = await searchGoogleShopping(amazon.amz_title);
            results = [...results, ...shopping];
          }
          if (useGoogle) {
            const web = await searchGoogleWeb(amazon.amz_title);
            results = [...results, ...web];
          }

          // If Google API returned no results, fallback to ScrapingBee
          if (results.length === 0) {
            console.log(`Google API returned 0 results for "${amazon.amz_title}". Trying ScrapingBee fallback...`);
            try {
              const { data: beeResults, error: beeError } = await supabaseClient.functions.invoke('google-scrape', {
                body: {
                  title: amazon.amz_title,
                  force_bee: true,
                  max_results: 5
                }
              });

              if (beeError) {
                console.error('ScrapingBee fallback error:', beeError);
              } else if (beeResults?.results && beeResults.results.length > 0) {
                console.log(`ScrapingBee found ${beeResults.results.length} results`);
                results = beeResults.results;
              }
            } catch (e) {
              console.error('ScrapingBee fallback exception:', e);
            }
          }

          if (results.length === 0) {
            await supabaseClient
              .from('asin_items')
              .update({
                status: 'done',
                ...amazon,
                error: 'No retailer matches found (Google + ScrapingBee)',
              })
              .eq('id', item.id);
          } else {
            // Score and pick best match
            const scored = results
              .map(r => ({
                ...r,
                title_score: tokenSetScore(amazon.amz_title, r.title),
              }))
              .filter(r => r.title_score >= matchReviewMin)
              .sort((a, b) => {
                // Prefer results with prices, then by title score
                if (a.price > 0 && b.price === 0) return -1;
                if (a.price === 0 && b.price > 0) return 1;
                return b.title_score - a.title_score;
              });

            if (scored.length === 0) {
              await supabaseClient
                .from('asin_items')
                .update({
                  status: 'done',
                  ...amazon,
                  error: 'No matches above threshold',
                })
                .eq('id', item.id);
            } else {
              const best = scored[0];
              const economics = best.price > 0 
                ? feesAndRoi(amazon.amz_price, best.price, referralPct, fbaFlat)
                : { roiPct: null, marginPct: null, fees: null };

              // Save category to database if it doesn't exist
              if (amazon.category) {
                try {
                  await supabaseClient
                    .from('categories')
                    .insert({ name: amazon.category })
                    .select();
                } catch (e) {
                  // Ignore errors - category might already exist due to UNIQUE constraint
                  console.log(`Category '${amazon.category}' already exists or error saving:`, e);
                }
              }
              
              // Save retailer to database if it doesn't exist
              if (best.store) {
                try {
                  await supabaseClient
                    .from('retailers')
                    .insert({ name: best.store })
                    .select();
                } catch (e) {
                  // Ignore errors - retailer might already exist due to UNIQUE constraint
                  console.log(`Retailer '${best.store}' already exists or error saving:`, e);
                }
              }

              await supabaseClient
                .from('asin_items')
                .update({
                  ...amazon,
                  category: amazon.category,
                  g_store: best.store,
                  g_title: best.title,
                  g_price: best.price,
                  g_link: best.link,
                  g_image: best.image,
                  source: best.source,
                  title_score: best.title_score,
                  match_score: best.title_score, // Simplified: title-only scoring
                  roi: economics.roiPct,
                  margin_pct: economics.marginPct,
                  fees_json: economics.fees,
                  status: 'done',
                })
                .eq('id', item.id);
            }
          }
        }

      } catch (error: any) {
        console.error(`Error processing item ${item.id}:`, error);
        await supabaseClient
          .from('asin_items')
          .update({ status: 'error', error: (error as Error).message })
          .eq('id', item.id);
      }
      
      // Always increment processed count after each item (success or failure)
      processedSoFar++;
      
      // Only update batch progress every 2 items to reduce database writes
      if (processedSoFar % 2 === 0 || processedSoFar === items.length) {
        await supabaseClient
          .from('asin_batches')
          .update({ processed: processedSoFar })
          .eq('id', batch_id);
      }
    }

    // Update batch progress
    const { data: batch } = await supabaseClient
      .from('asin_batches')
      .select('total, processed')
      .eq('id', batch_id)
      .single();

    const { count: processedCount } = await supabaseClient
      .from('asin_items')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batch_id)
      .neq('status', 'queued');

    // Ensure we never regress the processed counter due to any read lag
    const nextProcessed = Math.max(processedSoFar, processedCount || 0);

    await supabaseClient
      .from('asin_batches')
      .update({ processed: nextProcessed })
      .eq('id', batch_id);

    const remaining = (batch?.total || 0) - nextProcessed;
    
    console.log(`Batch ${batch_id}: processed ${items.length} items this pass, ${remaining} remaining, ${nextProcessed}/${batch?.total} total`);

    if (remaining === 0) {
      await supabaseClient
        .from('asin_batches')
        .update({ status: 'done' })
        .eq('id', batch_id);
    } else {
      // Continue processing in background by invoking self with delay to prevent thundering herd
      console.log(`Continuing batch ${batch_id} with ${remaining} items remaining...`);
      (globalThis as any).EdgeRuntime?.waitUntil(
        (async () => {
          try {
            // Add 1-2 second delay before continuing to next batch
            await delay(1000 + Math.random() * 1000);
            await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/admin-process-asin-batch`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
              },
              body: JSON.stringify({
                batch_id,
                page_size: effectivePageSize,
                useShopping,
                useGoogle,
              }),
            });
          } catch (error) {
            console.error('Error continuing batch:', error);
          }
        })()
      );
    }

    return new Response(
      JSON.stringify({ processed: items.length, remaining }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    console.error('Process error:', error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
