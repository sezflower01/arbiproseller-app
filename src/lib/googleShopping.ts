import { supabase } from '@/integrations/supabase/client';

export interface ShoppingResult {
  title: string;
  priceText: string;
  link: string;
  image?: string;
  retailer?: string;
}

// Normalize query for caching
function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Check if we're currently blocked
async function isBlocked(): Promise<{ blocked: boolean; until?: Date }> {
  const { data } = await supabase
    .from('scrape_state')
    .select('blocked_until')
    .eq('key', 'google_block')
    .maybeSingle();
  
  if (!data?.blocked_until) {
    return { blocked: false };
  }
  
  const blockedUntil = new Date(data.blocked_until);
  if (blockedUntil > new Date()) {
    return { blocked: true, until: blockedUntil };
  }
  
  return { blocked: false };
}

// Set blocked state
async function setBlocked() {
  const backoffMin = parseInt(import.meta.env.VITE_SCRAPE_BLOCK_BACKOFF_MIN || '30');
  const blockedUntil = new Date(Date.now() + backoffMin * 60 * 1000);
  
  await supabase
    .from('scrape_state')
    .upsert({
      key: 'google_block',
      blocked_until: blockedUntil.toISOString(),
      updated_at: new Date().toISOString(),
    });
}

// Log scraping attempt
async function logScrape(params: {
  asin?: string;
  query: string;
  mode: string;
  status: string;
  resultCount: number;
  error?: string;
}): Promise<void> {
  const finishedAt = new Date().toISOString();
  
  await supabase.from('scrape_logs').insert({
    asin: params.asin,
    query: params.query,
    mode: params.mode,
    status: params.status,
    result_count: params.resultCount,
    error: params.error,
    started_at: new Date().toISOString(),
    finished_at: finishedAt,
  });
}

// Main orchestrator function
export async function fetchGoogleShoppingResults(
  query: string,
  asin?: string,
  mode: 'auto' | 'http' | 'bee' = 'auto'
): Promise<ShoppingResult[]> {
  const normalized = normalizeQuery(query);
  
  // Check if blocked
  const blockStatus = await isBlocked();
  if (blockStatus.blocked) {
    console.warn(`[Scraper] Currently blocked until ${blockStatus.until}`);
    await logScrape({
      asin,
      query: normalized,
      mode: 'http',
      status: 'blocked',
      resultCount: 0,
      error: `Blocked until ${blockStatus.until?.toISOString()}`,
    });
    return [];
  }
  
  // Check cache
  const cacheTtlHours = parseInt(import.meta.env.VITE_SCRAPE_CACHE_TTL_HOURS || '168');
  const cacheExpiry = new Date(Date.now() - cacheTtlHours * 60 * 60 * 1000);
  
  const { data: cachedData } = await supabase
    .from('scrape_cache')
    .select('results, cached_at')
    .eq('query', normalized)
    .gte('cached_at', cacheExpiry.toISOString())
    .maybeSingle();
  
  if (cachedData) {
    console.log(`[Scraper] Cache hit for query: ${normalized}`);
    const results = (Array.isArray(cachedData.results) ? cachedData.results : []) as unknown as ShoppingResult[];
    
    await logScrape({
      asin,
      query: normalized,
      mode: 'cache_hit',
      status: 'ok',
      resultCount: results.length,
    });
    
    return results;
  }
  
  // No cache, call edge function
  console.log(`[Scraper] Cache miss, calling edge function for: ${normalized}, mode: ${mode}`);
  
  try {
    const maxResults = parseInt(import.meta.env.VITE_SCRAPE_MAX_RESULTS || '8');
    
    const { data, error } = await supabase.functions.invoke('google-scrape', {
      body: { query: normalized, max: maxResults, mode, asin },
    });
    
    if (error) {
      await logScrape({
        asin,
        query: normalized,
        mode: 'http',
        status: 'error',
        resultCount: 0,
        error: error.message,
      });
      console.error('[Scraper] Edge function error:', error);
      return [];
    }
    
    const results: ShoppingResult[] = data?.results || [];
    const scrapeMode = data?.meta?.mode || mode;
    const blocked: boolean = data?.meta?.blocked || false;
    
    if (blocked) {
      console.warn('[Scraper] Google is blocking requests');
      await setBlocked();
      await logScrape({
        asin,
        query: normalized,
        mode: scrapeMode,
        status: 'blocked',
        resultCount: 0,
        error: 'Google detected unusual traffic',
      });
      return [];
    }
    
    if (results.length > 0) {
      // Cache the results
      await supabase.from('scrape_cache').upsert({
        query: normalized,
        results: results as any,
        cached_at: new Date().toISOString(),
      });
      
      await logScrape({
        asin,
        query: normalized,
        mode: scrapeMode,
        status: 'ok',
        resultCount: results.length,
      });
    } else {
      await logScrape({
        asin,
        query: normalized,
        mode: scrapeMode,
        status: 'empty',
        resultCount: 0,
      });
    }
    
    return results;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Scraper] Exception:', errorMsg);
    
    await logScrape({
      asin,
      query: normalized,
      mode: 'http',
      status: 'error',
      resultCount: 0,
      error: errorMsg,
    });
    
    return [];
  }
}

// Helper to parse price from text
export function parsePriceFromText(priceText: string): number {
  const match = priceText.match(/[\d,]+\.?\d*/);
  if (match) {
    return parseFloat(match[0].replace(/,/g, ''));
  }
  return 0;
}

// Title similarity (Jaccard)
export function calculateTitleSimilarity(title1: string, title2: string): number {
  const words1 = new Set(title1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const words2 = new Set(title2.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  
  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);
  
  if (union.size === 0) return 0;
  return Math.round((intersection.size / union.size) * 100);
}
