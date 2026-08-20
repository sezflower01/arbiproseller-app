import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Call the new google-scrape function using Supabase client
async function scrapeGoogleShopping(title: string, sb: any, forceBee = false): Promise<any[]> {
  console.log(`[Scraper] Calling google-scrape for title: ${title.substring(0, 50)}... (mode: ${forceBee ? 'bee' : 'auto'})`);
  
  try {
    const { data, error } = await sb.functions.invoke('google-scrape', {
      body: {
        query: title,
        max: parseInt(Deno.env.get('SCRAPE_MAX_RESULTS') || '8'),
        mode: forceBee ? 'bee' : 'auto',  // Force ScrapingBee if requested
      },
    });

    if (error) {
      console.error('[Scraper] Edge function error:', error);
      return [];
    }

    if (data?.blocked) {
      console.warn('[Scraper] Google is blocking requests');
      return [];
    }

    const results = data?.results || [];
    console.log(`[Scraper] Received ${results.length} results`);
    
    // Convert to our format
    return results.map((r: any) => ({
      title: r.title,
      price: parsePrice(r.priceText),
      link: r.link,
      image: r.image || '',
      store: r.retailer || '',
    }));
  } catch (err) {
    console.error('[Scraper] Error:', err);
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

function calculateTitleSimilarity(title1: string, title2: string): number {
  const words1 = new Set(title1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const words2 = new Set(title2.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  
  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);
  
  if (union.size === 0) return 0;
  return Math.round((intersection.size / union.size) * 100);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Verify user authentication
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    const { batch_id, force_bee } = await req.json();
    
    if (!batch_id) {
      throw new Error('batch_id is required');
    }

    console.log(`[Scraper] Starting scrape for batch: ${batch_id}`);

    // Get batch details
    const { data: batch, error: batchError } = await supabase
      .from('asin_batches')
      .select('*')
      .eq('id', batch_id)
      .single();

    if (batchError || !batch) {
      throw new Error('Batch not found');
    }

    // Get items to process (queued or failed)
    const { data: items, error: itemsError } = await supabase
      .from('asin_items')
      .select('*')
      .eq('batch_id', batch_id)
      .in('status', ['queued', 'failed'])
      .order('idx')
      .limit(50); // Process 50 items at a time

    if (itemsError) {
      throw new Error(`Error fetching items: ${itemsError.message}`);
    }

    if (!items || items.length === 0) {
      // No items queued/failed; update batch progress based on non-queued items
      const { data: allItems } = await supabase
        .from('asin_items')
        .select('status')
        .eq('batch_id', batch_id);

      const totalCount = allItems?.length || 0;
      const processedCount = allItems?.filter(i => i.status !== 'queued').length || 0;
      const allDone = processedCount === totalCount;

      await supabase
        .from('asin_batches')
        .update({
          processed: processedCount,
          status: allDone ? 'done' : 'running',
        })
        .eq('id', batch_id);

      return new Response(
        JSON.stringify({ message: 'No items to process', processed: processedCount, remaining: totalCount - processedCount }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[Scraper] Processing ${items.length} items (force_bee: ${force_bee || false})`);

    let processed = 0;
    let successful = 0;

    // Update batch status to running
    await supabase
      .from('asin_batches')
      .update({ status: 'running' })
      .eq('id', batch_id);

    for (const item of items) {
      try {
        if (!item.amz_title) {
          await supabase
            .from('asin_items')
            .update({
              status: 'failed',
              error: 'Missing Amazon title',
              source_type: 'scraper',
            })
            .eq('id', item.id);
          processed++;
          continue;
        }

        // Scrape results - pass force_bee flag
        const results = await scrapeGoogleShopping(item.amz_title, supabase, force_bee || false);
        
        // Small delay between scrapes
        await delay(500);

        if (results.length > 0) {
          // Store ALL matching results with title similarity > 30%
          const MIN_TITLE_MATCH = 30;
          let matchCount = 0;
          
          for (const result of results) {
            const titleScore = calculateTitleSimilarity(item.amz_title || '', result.title);
            
            // Only store results with decent title match
            if (titleScore >= MIN_TITLE_MATCH) {
              // Create a new item for each matching retailer
              await supabase
                .from('asin_items')
                .insert({
                  batch_id: item.batch_id,
                  asin: item.asin || '',
                  amz_title: item.amz_title || '',
                  amz_price: item.amz_price || null,
                  amz_link: item.amz_link || null,
                  amz_image: item.amz_image || null,
                  g_title: result.title,
                  g_price: result.price,
                  g_link: result.link,
                  g_image: result.image,
                  g_store: result.store,
                  title_score: titleScore,
                  match_score: titleScore,
                  source_type: 'scraper',
                  status: 'done',
                  category: item.category || null,
                  idx: item.idx || null,
                });
              
              matchCount++;
            }
          }
          
          console.log(`[Scraper] Found ${matchCount} matching retailers for ASIN ${item.asin}`);
          
          // Mark original item as done
          await supabase
            .from('asin_items')
            .update({
              status: 'done',
              error: matchCount > 0 ? `Found ${matchCount} retailers` : null,
              source_type: 'scraper',
            })
            .eq('id', item.id);

          successful++;
        } else {
          await supabase
            .from('asin_items')
            .update({
              status: 'failed',
              error: 'No results found',
              source_type: 'scraper',
            })
            .eq('id', item.id);
        }

        processed++;
      } catch (err) {
        console.error(`[Scraper] Error processing item ${item.id}:`, err);
        await supabase
          .from('asin_items')
          .update({
            status: 'failed',
            error: err instanceof Error ? err.message : 'Unknown error',
            source_type: 'scraper',
          })
          .eq('id', item.id);
        processed++;
      }
    }

    // Update batch progress
    const { data: allItems } = await supabase
      .from('asin_items')
      .select('status')
      .eq('batch_id', batch_id);

    const totalCount = allItems?.length || 0;
    const processedCount = allItems?.filter(i => i.status !== 'queued').length || 0;
    const allDone = processedCount === totalCount;

    await supabase
      .from('asin_batches')
      .update({
        processed: processedCount,
        status: allDone ? 'done' : 'running',
      })
      .eq('id', batch_id);

    return new Response(
      JSON.stringify({
        success: true,
        processed,
        successful,
        remaining: totalCount - processedCount,
        message: `Processed ${processed} items, ${successful} successful`,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('[Scraper] Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
