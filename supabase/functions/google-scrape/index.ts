import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// User agents for rotation
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
];

// Configuration from environment
const SCRAPE_MAX_RESULTS = parseInt(Deno.env.get('SCRAPE_MAX_RESULTS') || '8');
const SCRAPE_CACHE_TTL_HOURS = parseInt(Deno.env.get('SCRAPE_CACHE_TTL_HOURS') || '168');
const SCRAPE_BLOCK_BACKOFF_MIN = parseInt(Deno.env.get('SCRAPE_BLOCK_BACKOFF_MIN') || '30');
const SCRAPE_MIN_DELAY_MS = parseInt(Deno.env.get('SCRAPE_MIN_DELAY_MS') || '600');
const SCRAPE_MAX_DELAY_MS = parseInt(Deno.env.get('SCRAPE_MAX_DELAY_MS') || '1200');

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getRandomDelay(): number {
  return Math.floor(Math.random() * (SCRAPE_MAX_DELAY_MS - SCRAPE_MIN_DELAY_MS + 1)) + SCRAPE_MIN_DELAY_MS;
}

function absolutizeUrl(url: string): string {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return 'https://www.google.com' + url;
  return url;
}

function normalizeQuery(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, ' ');
}

interface ShoppingResult {
  title: string;
  priceText: string;
  link: string;
  image?: string;
  retailer?: string;
}

interface ScrapeResult {
  results: ShoppingResult[];
  meta: {
    mode: 'http' | 'bee' | 'cache';
    blocked?: boolean;
    url?: string;
  };
}

// Check if blocked
async function isBlocked(supabase: any): Promise<{ blocked: boolean; until?: Date }> {
  const { data } = await supabase
    .from('scrape_state')
    .select('blocked_until')
    .eq('key', 'google_block')
    .single();
  
  if (data?.blocked_until) {
    const until = new Date(data.blocked_until);
    if (until > new Date()) {
      return { blocked: true, until };
    }
  }
  return { blocked: false };
}

// Set blocked state
async function setBlocked(supabase: any) {
  const blockedUntil = new Date(Date.now() + SCRAPE_BLOCK_BACKOFF_MIN * 60 * 1000);
  await supabase
    .from('scrape_state')
    .upsert({
      key: 'google_block',
      blocked_until: blockedUntil.toISOString(),
      updated_at: new Date().toISOString()
    });
}

// Log scrape attempt
async function logScrape(supabase: any, params: {
  asin?: string;
  query: string;
  mode: string;
  status: string;
  result_count?: number;
  error?: string;
}) {
  const started_at = new Date().toISOString();
  await supabase.from('scrape_logs').insert({
    ...params,
    started_at,
    finished_at: new Date().toISOString()
  });
}

// Parse products from HTML
function parseProducts(doc: any, maxResults: number): ShoppingResult[] {
  const results: ShoppingResult[] = [];
  
  // Expanded selectors for product cards
  const cardSelectors = [
    'div.sh-dgr__grid-result',
    'div.sh-dlr__list-result',
    'div.sh-osd__offer-card',
    'div.i0X6df',
    'div.KZmu8e',
    'div.sh-pr__product-results div[data-docid]'
  ];

  let productCards: any[] = [];
  for (const selector of cardSelectors) {
    const cards = doc.querySelectorAll(selector);
    if (cards && cards.length > 0) {
      productCards = Array.from(cards);
      console.log(`[Parser] Found ${cards.length} products using: ${selector}`);
      break;
    }
  }

  for (const card of productCards.slice(0, maxResults)) {
    try {
      console.log('[Parser] Processing product card...');
      
      // Title
      const titleSels = ['h3.tAxDx', 'div.KzqGnb', 'span.Xjkr3b'];
      let title = '';
      for (const sel of titleSels) {
        const el = card.querySelector(sel);
        if (el?.textContent?.trim()) {
          title = el.textContent.trim();
          console.log(`[Parser] Found title: "${title.substring(0, 50)}..." using: ${sel}`);
          break;
        }
      }

      // Price - expanded selectors
      const priceSels = [
        'span.a8Pemb',           // Primary price span
        'span.dwRsje',           // Alternative price span
        'span.T14wmb',           // Another variant
        '[data-price]',          // Data attribute
        '.price',                // Generic price class
        'span[aria-label*="$"]', // Aria label with dollar sign
        'div.sh-pr__product-price span',
        'span.notranslate'       // Sometimes prices are in notranslate spans
      ];
      let priceText = '';
      for (const sel of priceSels) {
        const el = card.querySelector(sel);
        if (el?.textContent?.trim()) {
          const text = el.textContent.trim();
          // Check if it looks like a price (contains $ or number)
          if (text.includes('$') || /\d/.test(text)) {
            priceText = text;
            console.log(`[Parser] Found price "${priceText}" using selector: ${sel}`);
            break;
          }
        }
      }
      
      // If still no price, try data attributes
      if (!priceText) {
        const priceAttr = card.querySelector('[data-price]')?.getAttribute('data-price');
        if (priceAttr) {
          priceText = priceAttr;
          console.log(`[Parser] Found price from data-price: ${priceText}`);
        } else {
          console.log('[Parser] No price found for this card');
        }
      }

      // Retailer
      const retSels = ['.aULzUe', '.E5ocAb', '.zLPF4b'];
      let retailer = '';
      for (const sel of retSels) {
        const el = card.querySelector(sel);
        if (el?.textContent?.trim()) {
          retailer = el.textContent.trim();
          break;
        }
      }

      // Link
      const linkSels = ['a.shntl', 'a.eIuuYe', 'a.WUQGme'];
      let link = '';
      for (const sel of linkSels) {
        const el = card.querySelector(sel);
        if (el) {
          link = absolutizeUrl(el.getAttribute('href') || '');
          if (link) break;
        }
      }

      // Image
      const imgEl = card.querySelector('img[src], img[data-src]');
      let image = '';
      if (imgEl) {
        image = imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '';
      }

      if (title || priceText) {
        results.push({
          title: title || 'N/A',
          priceText: priceText || 'N/A',
          link,
          image,
          retailer: retailer || 'Unknown'
        });
      }
    } catch (error) {
      console.error('[Parser] Error extracting product:', error);
    }
  }

  return results;
}

// HTTP scraping (no JS rendering)
async function scrapeHTTP(query: string, maxResults: number): Promise<{ results: ShoppingResult[]; blocked: boolean }> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://www.google.com/search?tbm=shop&hl=en&gl=us&pccc=1&q=${encodedQuery}`;
  
  console.log('[HTTP] Fetching:', url);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cookie': 'CONSENT=YES+; SOCS=CAESHAgBEhIa; AEC=AVQBfEw;',
      },
    });

    if (!response.ok) {
      console.error('[HTTP] Failed:', response.status);
      return { results: [], blocked: true };
    }

    const html = await response.text();
    console.log(`[HTTP] Got HTML (${html.length} chars)`);

    // Check for blocking
    if (html.includes('unusual traffic') || html.includes('automated requests')) {
      console.error('[HTTP] Blocked by Google');
      return { results: [], blocked: true };
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (!doc) {
      return { results: [], blocked: false };
    }

    const results = parseProducts(doc, maxResults);
    console.log(`[HTTP] Parsed ${results.length} results`);
    return { results, blocked: results.length === 0 };
  } catch (error) {
    console.error('[HTTP] Error:', error);
    return { results: [], blocked: true };
  }
}

// ScrapingBee scraping (JS rendering)
async function scrapeBee(query: string, maxResults: number): Promise<{ results: ShoppingResult[]; blocked: boolean; url?: string }> {
  const apiKey = Deno.env.get('SCRAPINGBEE_API_KEY');
  if (!apiKey) {
    console.error('[Bee] No API key');
    return { results: [], blocked: false };
  }

  const encodedQuery = encodeURIComponent(query);
  const targetUrl = `https://www.google.com/search?tbm=shop&hl=en&gl=us&pccc=1&q=${encodedQuery}`;
  
  console.log('[Bee] Target:', targetUrl);

  const beeUrl = new URL('https://app.scrapingbee.com/api/v1');
  beeUrl.searchParams.set('api_key', apiKey);
  beeUrl.searchParams.set('url', targetUrl);
  beeUrl.searchParams.set('render_js', 'true');
  beeUrl.searchParams.set('custom_google', 'true');
  beeUrl.searchParams.set('country_code', 'us');
  beeUrl.searchParams.set('block_resources', 'true');
  beeUrl.searchParams.set('premium_proxy', 'true');
  beeUrl.searchParams.set('wait', '2000');

  try {
    const response = await fetch(beeUrl.toString());
    
    if (!response.ok) {
      const body = await response.text();
      console.error('[Bee] Failed:', response.status, body);
      return { results: [], blocked: true, url: targetUrl };
    }

    const html = await response.text();
    console.log(`[Bee] Got HTML (${html.length} chars)`);
    
    // Log HTML excerpt for debugging
    const htmlExcerpt = html.substring(0, 500);
    console.log(`[Bee] HTML preview: ${htmlExcerpt}`);

    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (!doc) {
      console.error('[Bee] Failed to parse HTML document');
      return { results: [], blocked: false };
    }

    const results = parseProducts(doc, maxResults);
    console.log(`[Bee] Parsed ${results.length} results`);
    
    // Log first result details if any
    if (results.length > 0) {
      console.log(`[Bee] First result: ${JSON.stringify(results[0])}`);
    } else {
      console.log(`[Bee] No results parsed. Checking for product cards...`);
      const cardSelectors = [
        'div.sh-dgr__grid-result',
        'div.sh-dlr__list-result',
        'div.sh-osd__offer-card',
        'div.i0X6df',
        'div.KZmu8e',
        'div.sh-pr__product-results div[data-docid]'
      ];
      for (const selector of cardSelectors) {
        const cards = doc.querySelectorAll(selector);
        console.log(`[Bee] Found ${cards?.length || 0} elements with selector: ${selector}`);
      }
    }
    
    if (results.length === 0) {
      // Save excerpt for debugging
      const excerpt = html.substring(0, 2000);
      return { results: [], blocked: true, url: targetUrl };
    }

    return { results, blocked: false };
  } catch (error) {
    console.error('[Bee] Error:', error);
    return { results: [], blocked: true, url: targetUrl };
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const { query, max, mode, asin } = await req.json();
    
    if (!query) {
      return new Response(
        JSON.stringify({ error: 'Query parameter is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const normalizedQuery = normalizeQuery(query);
    const maxResults = max || SCRAPE_MAX_RESULTS;
    const scrapeMode = mode || 'auto'; // 'auto', 'http', 'bee'

    console.log(`[Main] Query: "${query}", Mode: ${scrapeMode}, Max: ${maxResults}`);

    // Check if blocked
    const blockStatus = await isBlocked(supabase);
    if (blockStatus.blocked) {
      console.log('[Main] Currently blocked until:', blockStatus.until);
      await logScrape(supabase, {
        asin,
        query: normalizedQuery,
        mode: scrapeMode,
        status: 'blocked',
        result_count: 0,
        error: `Blocked until ${blockStatus.until}`
      });
      return new Response(
        JSON.stringify({
          results: [],
          meta: { mode: scrapeMode, blocked: true }
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check cache
    const cacheKey = normalizedQuery;
    const cacheTTL = SCRAPE_CACHE_TTL_HOURS * 60 * 60 * 1000;
    const { data: cached } = await supabase
      .from('scrape_cache')
      .select('*')
      .eq('query', cacheKey)
      .single();

    if (cached && (new Date().getTime() - new Date(cached.cached_at).getTime()) < cacheTTL) {
      console.log('[Main] Cache hit');
      await logScrape(supabase, {
        asin,
        query: normalizedQuery,
        mode: 'cache',
        status: 'cache_hit',
        result_count: cached.results.length
      });
      return new Response(
        JSON.stringify({
          results: cached.results,
          meta: { mode: 'cache' }
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let finalResults: ShoppingResult[] = [];
    let finalMode: 'http' | 'bee' = 'http';
    let blocked = false;

    // Try HTTP first if mode is 'auto' or 'http'
    if (scrapeMode === 'auto' || scrapeMode === 'http') {
      const httpResult = await scrapeHTTP(normalizedQuery, maxResults);
      if (httpResult.results.length > 0) {
        finalResults = httpResult.results;
        finalMode = 'http';
        console.log('[Main] HTTP succeeded');
      } else if (httpResult.blocked) {
        blocked = true;
        console.log('[Main] HTTP blocked, will try Bee');
      }
    }

    // Try ScrapingBee if: mode is 'bee', or 'auto' with no HTTP results
    if ((scrapeMode === 'bee' || (scrapeMode === 'auto' && finalResults.length === 0)) && blocked === false) {
      const beeResult = await scrapeBee(normalizedQuery, maxResults);
      if (beeResult.results.length > 0) {
        finalResults = beeResult.results;
        finalMode = 'bee';
        console.log('[Main] Bee succeeded');
      } else if (beeResult.blocked) {
        blocked = true;
        // Save excerpt for debugging
        await logScrape(supabase, {
          asin,
          query: normalizedQuery,
          mode: 'bee',
          status: 'blocked',
          result_count: 0,
          error: `Blocked. URL: ${beeResult.url}`
        });
        console.log('[Main] Bee blocked');
      }
    }

    // If still blocked, set block state
    if (blocked && finalResults.length === 0) {
      await setBlocked(supabase);
      await logScrape(supabase, {
        asin,
        query: normalizedQuery,
        mode: finalMode,
        status: 'blocked',
        result_count: 0
      });
      return new Response(
        JSON.stringify({
          results: [],
          meta: { mode: finalMode, blocked: true }
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Success - cache results
    if (finalResults.length > 0) {
      await supabase
        .from('scrape_cache')
        .upsert({
          query: cacheKey,
          results: finalResults,
          cached_at: new Date().toISOString()
        });

      await logScrape(supabase, {
        asin,
        query: normalizedQuery,
        mode: finalMode,
        status: 'ok',
        result_count: finalResults.length
      });
    } else {
      await logScrape(supabase, {
        asin,
        query: normalizedQuery,
        mode: finalMode,
        status: 'empty',
        result_count: 0
      });
    }

    return new Response(
      JSON.stringify({
        results: finalResults,
        meta: { mode: finalMode, blocked: false }
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[Main] Error:', error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? (error as Error).message : 'Unknown error',
        results: [],
        meta: { mode: 'auto', blocked: false }
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});