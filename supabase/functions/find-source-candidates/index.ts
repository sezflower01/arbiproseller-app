// FIND-SOURCE-CANDIDATES
// User-triggered (the "Find source" button on a seller_watch_new_listings
// row) -- deliberately NOT run automatically on every detected listing, so
// API cost scales with intentional use, not total volume discovered.
//
// UPC-first search (falls back to brand+title when no UPC), reusing the
// same Google Custom Search primitive discover-source-candidates already
// uses, then verifies the top candidates with the same honest,
// capped-confidence posture as verify-store-scan-match: a rule-based text
// score blended with a Gemini text verdict and the shared compareImages
// vision check, hard-capped below "confirmed". The user's own "Mark as
// source" click (a separate, simple RLS-protected update) is the only
// thing that ever sets a listing to 'sourced' -- this function only ever
// produces ranked candidates for the user to verify.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { compareImages } from '../_shared/image-compare.ts';
import { acquireKeepaGlobalSlot, reportKeepaTokensLeft, KEEPA_COST } from '../_shared/keepa-rate-gate.ts';
import { getCatalogAccessToken, fetchCatalogItemDetails } from '../_shared/spapi-catalog-image.ts';

const KEEPA_DOMAIN: Record<string, number> = {
  US: 1, GB: 2, DE: 3, FR: 4, JP: 5, CA: 6, IT: 8, ES: 9, IN: 10, MX: 11, BR: 12,
};

// check-seller-watchlist's product-detail batch fetch can fail silently
// (rate-gate slot unavailable, transient Keepa error) and leave a listing
// with null title/brand/image/upc forever -- confirmed live 2026-08-15.
// Rather than hard-failing "no title or UPC to search with" on a listing
// that just needs one more Keepa call, try to backfill it here first.
async function backfillProductDetails(
  supabase: any,
  keepaKey: string,
  asin: string,
  marketplace: string,
  userId: string | null,
): Promise<{ title: string | null; brand: string | null; image: string | null; upc: string | null } | null> {
  // SP-API Catalog Items first. It returns the same four fields (title, brand,
  // image, upc) from Amazon's own catalog on a quota ~24x larger than the
  // ENTIRE Keepa daily budget -- catalog_api runs at 2 req/s where Keepa
  // refills 5 tokens/min total. Keepa stays as the fallback rather than being
  // removed: it is the older path, and this function is user-facing, so a
  // Catalog Items miss should degrade rather than return nothing.
  if (userId) {
    const token = await getCatalogAccessToken(supabase, userId, marketplace);
    if (token) {
      const sp = await fetchCatalogItemDetails(supabase, token, asin, marketplace);
      if (sp.title || sp.image) {
        return { title: sp.title, brand: sp.brand, image: sp.image, upc: sp.upc };
      }
    }
  }

  // Single-ASIN /product lookup = 1 token.
  const slot = await acquireKeepaGlobalSlot(supabase, { estimatedTokens: KEEPA_COST.productPerAsin });
  if (!slot.ok) return null;
  const domainId = KEEPA_DOMAIN[marketplace] ?? 1;
  try {
    const url = `https://api.keepa.com/product?key=${keepaKey}&domain=${domainId}&asin=${asin}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json().catch(() => ({}));
    await reportKeepaTokensLeft(supabase, json?.tokensLeft, json?.refillRate);
    if (json?.error) return null;
    const p = json?.products?.[0];
    if (!p) return null;
    const image = p?.imagesCSV ? `https://images-na.ssl-images-amazon.com/images/I/${String(p.imagesCSV).split(',')[0]}` : null;
    const upc = Array.isArray(p?.upcList) && p.upcList.length ? String(p.upcList[0]) : null;
    return { title: p?.title || null, brand: p?.brand || p?.manufacturer || null, image, upc };
  } catch (e) {
    console.warn('[find-source-candidates] product-detail backfill failed:', (e as Error).message);
    return null;
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_MODEL = 'gemini-3-flash-preview';
const MAX_CANDIDATES_SCORED = 8;
const MAX_CANDIDATES_VERIFIED = 3;
const MIN_SCORE_TO_SHOW = 15;
const CONFIDENCE_CAP = 85;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

interface RawCandidate {
  url: string;
  title: string;
  snippet: string;
  imageUrl: string | null;
}

// Same API discover-source-candidates already uses (GOOGLE_API_KEY/GOOGLE_CX_ID)
// -- a fresh, small, purpose-scoped copy rather than importing that live
// function's internals. Excludes Amazon/eBay/AliExpress IN the query text
// (same technique discover-source-candidates uses) so Google doesn't burn
// result slots on pages we're going to zero-score anyway -- popular branded
// products otherwise return an Amazon-dominated page 1 with little room
// left for genuine third-party retailers.
const QUERY_EXCLUSIONS = "-site:amazon.com -site:ebay.com -site:aliexpress.com -site:alibaba.com -site:wish.com -site:pinterest.com";

/**
 * Reject retailers that cannot serve a US arbitrage buy.
 *
 * BOTH search paths already ask for US results -- CSE sends
 * `cr=countryUS&gl=us`, SerpAPI sends `location=United+States` -- and a
 * Costa Rican cross-border reseller (tiendamia.cr) still came back as a
 * scored candidate on 2026-08-16. Those parameters are a soft classification
 * by Google, not a guarantee: a site carrying US-targeted, English product
 * content gets classified as US-relevant regardless of where it ships from.
 * Adding more search parameters cannot fix a misclassification, so the filter
 * has to be ours and deterministic.
 *
 * The rule is the TLD: a two-letter country code is a foreign storefront
 * unless it is .us. That catches .cr/.mx/.br/.de/.co.uk and everything like
 * them in one line, rather than blocklisting reseller domains one at a time
 * as they appear.
 *
 * Accepted cost: it also rejects .co/.io/.ai domains, which US companies do
 * sometimes use. For SOURCING that is the right trade -- those are vanishingly
 * rare as retail storefronts, and a missed candidate costs one search whereas
 * a foreign one costs a Gemini verdict, a vision compare, a scrape, and a
 * human working out why the price looks wrong.
 *
 * Filtered BEFORE scoring so a foreign domain never consumes verification
 * budget, same principle as user-rejected URLs.
 */
const ALLOWED_TWO_LETTER_TLDS = new Set(['us']);

function isUsServableDomain(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
    const tld = host.split('.').pop() || '';
    if (tld.length === 2) return ALLOWED_TWO_LETTER_TLDS.has(tld);
    return true;
  } catch {
    return false; // unparseable URL is not a candidate
  }
}

async function googleSearch(query: string, apiKey: string, cx: string, num = MAX_CANDIDATES_SCORED): Promise<RawCandidate[]> {
  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(`${query} ${QUERY_EXCLUSIONS}`)}&num=${num}&gl=us&cr=countryUS&lr=lang_en&hl=en`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      console.warn('[find-source-candidates] Google CSE non-OK:', r.status);
      return [];
    }
    const j = await r.json();
    const items = Array.isArray(j.items) ? j.items : [];
    return items
      .map((it: any) => ({
        url: it.link || '',
        title: it.title || '',
        snippet: it.snippet || '',
        imageUrl: it.pagemap?.cse_image?.[0]?.src || it.pagemap?.product?.[0]?.image || null,
      }))
      .filter((c: RawCandidate) => c.url);
  } catch (e) {
    console.warn('[find-source-candidates] Google CSE error:', (e as Error).message);
    return [];
  }
}

// Fallback when Google CSE is unavailable (wrong/unauthorized API project,
// quota exhausted, etc.) -- same fallback discover-source-candidates already
// relies on. SerpAPI doesn't return pagemap image data, so imageUrl stays
// null on this path; compareImages degrades gracefully (see _shared/image-compare.ts).
async function serpApiSearch(query: string, apiKey: string, num = MAX_CANDIDATES_SCORED): Promise<RawCandidate[]> {
  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(`${query} ${QUERY_EXCLUSIONS}`)}&num=${num}&api_key=${apiKey}&engine=google&gl=us&hl=en&google_domain=google.com&location=United+States`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      console.warn('[find-source-candidates] SerpAPI non-OK:', r.status);
      return [];
    }
    const j = await r.json();
    const items = Array.isArray(j.organic_results) ? j.organic_results : [];
    return items
      .map((it: any) => ({ url: it.link || '', title: it.title || '', snippet: it.snippet || '', imageUrl: null }))
      .filter((c: RawCandidate) => c.url);
  } catch (e) {
    console.warn('[find-source-candidates] SerpAPI error:', (e as Error).message);
    return [];
  }
}

async function searchAll(query: string, googleKey: string, cx: string, serpApiKey: string | undefined): Promise<RawCandidate[]> {
  const results = await googleSearch(query, googleKey, cx);
  if (results.length > 0) return results;
  if (!serpApiKey) return [];
  return serpApiSearch(query, serpApiKey);
}

const NON_RETAIL_DOMAINS = new Set([
  'pinterest.com', 'reddit.com', 'youtube.com', 'facebook.com', 'instagram.com',
  'twitter.com', 'x.com', 'tiktok.com', 'quora.com', 'wikipedia.org', 'amazon.com',
]);

// Hard exclude, not a ranking preference -- gl=us/cr=countryUS on the search
// call are only ranking hints, not filters, so a query can still surface
// foreign-TLD retailers (confirmed live: desertcart.ie, desertcart.in on a
// US-only account). ccTLD suffix check; generic TLDs (.com/.us/.net/.org/etc)
// pass through untouched.
const NON_US_TLD_SUFFIXES = [
  '.ie', '.uk', '.co.uk', '.ca', '.de', '.fr', '.it', '.es', '.nl', '.se', '.pl',
  '.jp', '.co.jp', '.in', '.au', '.com.au', '.mx', '.com.mx', '.br', '.com.br',
  '.cn', '.ru', '.sg', '.ae', '.sa', '.tr', '.com.tr', '.nz', '.co.nz', '.za',
  '.co.za', '.eu', '.ch', '.at', '.be', '.dk', '.no', '.fi', '.pt', '.gr', '.hk',
  '.tw', '.kr', '.co.kr', '.th', '.vn', '.id', '.ph', '.my', '.il', '.pk',
];

function isNonUsDomain(domain: string): boolean {
  return NON_US_TLD_SUFFIXES.some((suffix) => domain.endsWith(suffix));
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function ruleScore(c: RawCandidate, listing: { upc: string | null; brand: string | null; title: string | null }): number {
  const domain = getDomain(c.url);
  if (!domain || NON_RETAIL_DOMAINS.has(domain) || isNonUsDomain(domain)) return 0;

  const haystack = `${c.title} ${c.snippet}`.toLowerCase();
  let score = 0;

  if (listing.upc && haystack.includes(listing.upc.toLowerCase())) score += 50;
  if (listing.brand && haystack.includes(listing.brand.toLowerCase())) score += 15;

  if (listing.title) {
    const words = listing.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const matched = words.filter((w) => haystack.includes(w)).length;
    const ratio = words.length > 0 ? matched / words.length : 0;
    score += Math.round(ratio * 20);
  }

  return Math.min(70, score); // pre-AI ceiling -- rule matching alone never claims high confidence
}

async function geminiTextVerify(
  listing: { title: string | null; brand: string | null; upc: string | null },
  candidate: RawCandidate,
  apiKey: string,
): Promise<{ verdict: 'same_product' | 'same_franchise_diff_item' | 'different_product'; confidence: number } | null> {
  try {
    const resp = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You verify whether a web search result is a genuine retail listing for a specific product, for a reseller trying to find where to buy it. Compare the target product to the candidate page title and snippet. Respond ONLY via the verify tool.',
          },
          {
            role: 'user',
            content: `Target product: "${listing.title || 'unknown'}"${listing.brand ? ` (brand: ${listing.brand})` : ''}${listing.upc ? ` (UPC: ${listing.upc})` : ''}\n\nCandidate page title: "${candidate.title}"\nCandidate snippet: "${candidate.snippet}"\nCandidate domain: ${getDomain(candidate.url)}`,
          },
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'verify',
            description: 'Return whether the candidate page is selling the exact target product.',
            parameters: {
              type: 'object',
              properties: {
                verdict: { type: 'string', enum: ['same_product', 'same_franchise_diff_item', 'different_product'] },
                confidence: { type: 'integer', description: '0-100' },
              },
              required: ['verdict', 'confidence'],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: 'function', function: { name: 'verify' } },
      }),
    });
    if (!resp.ok) return null;
    const j = await resp.json();
    const call = j?.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return null;
    const args = JSON.parse(call.function?.arguments ?? '{}');
    if (!['same_product', 'same_franchise_diff_item', 'different_product'].includes(args.verdict)) return null;
    return { verdict: args.verdict, confidence: Math.max(0, Math.min(100, parseInt(String(args.confidence ?? 0), 10))) };
  } catch (e) {
    console.warn('[find-source-candidates] Gemini verify failed:', (e as Error).message);
    return null;
  }
}

function blendConfidence(rule: number, gemini: { verdict: string; confidence: number } | null, image: { verdict: string; similarity: number } | null): number {
  const signals: { value: number; weight: number }[] = [{ value: rule, weight: 0.4 }];
  if (gemini) {
    const geminiValue = gemini.verdict === 'same_product' ? gemini.confidence : gemini.verdict === 'same_franchise_diff_item' ? gemini.confidence * 0.3 : 0;
    signals.push({ value: geminiValue, weight: 0.35 });
  }
  if (image && image.verdict !== 'unavailable') {
    signals.push({ value: image.similarity * 100, weight: 0.25 });
  }
  const totalWeight = signals.reduce((s, x) => s + x.weight, 0);
  const blended = signals.reduce((s, x) => s + x.value * x.weight, 0) / totalWeight;
  return Math.min(CONFIDENCE_CAP, Math.round(blended));
}

function confidenceLabel(score: number): string {
  if (score >= 60) return 'Likely match';
  return 'Possible match';
}

function monthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const GOOGLE_API_KEY = Deno.env.get('GOOGLE_API_KEY');
    const GOOGLE_CX_ID = Deno.env.get('GOOGLE_CX_ID');
    const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
    const INTERNAL_SECRET = Deno.env.get('INTERNAL_SYNC_SECRET') || '';

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const body = await req.json().catch(() => ({}));

    // Two callers, two auth shapes.
    //
    // A user clicking through the UI presents their own JWT and the listing is
    // scoped to them. The auto-source cron has no user session, so it presents
    // the internal secret and names the user it is acting for. INTERNAL_SECRET
    // was already read here but never checked -- the internal path is what it
    // was declared for.
    //
    // The userId is still used to scope the listing lookup below in BOTH
    // cases, so an internal caller cannot reach a listing by guessing an id;
    // it has to name the owner correctly too.
    const providedSecret = req.headers.get('x-internal-secret') || '';
    const isInternal = !!INTERNAL_SECRET && providedSecret === INTERNAL_SECRET;

    let userId: string;
    if (isInternal) {
      userId = String(body.userId || '').trim();
      if (!userId) return jsonResponse({ error: 'userId is required for internal calls' }, 400);
    } else {
      const auth = req.headers.get('Authorization');
      if (!auth?.startsWith('Bearer ')) return jsonResponse({ error: 'Unauthorized' }, 401);
      const token = auth.replace('Bearer ', '').trim();
      const { data: userRes, error: userErr } = await admin.auth.getUser(token);
      if (userErr || !userRes?.user) return jsonResponse({ error: 'Unauthorized' }, 401);
      userId = userRes.user.id;
    }

    if (!GOOGLE_API_KEY || !GOOGLE_CX_ID) return jsonResponse({ error: 'Search is not configured' }, 500);
    if (!GEMINI_API_KEY) return jsonResponse({ error: 'Verification is not configured' }, 500);

    const listingId = String(body.listingId || '').trim();
    if (!listingId) return jsonResponse({ error: 'listingId is required' }, 400);

    const { data: listing, error: listingErr } = await admin
      .from('seller_watch_new_listings')
      .select('id, user_id, asin, marketplace, title, brand, image_url, upc, rejected_candidate_urls')
      .eq('id', listingId)
      .eq('user_id', userId)
      .maybeSingle();
    if (listingErr || !listing) return jsonResponse({ error: 'Listing not found' }, 404);

    if (!listing.upc && !listing.title) {
      const backfilled = await backfillProductDetails(admin, Deno.env.get('KEEPA_API_KEY') || '', listing.asin, listing.marketplace, userId);
      if (backfilled && (backfilled.title || backfilled.upc)) {
        listing.title = backfilled.title;
        listing.brand = backfilled.brand;
        listing.image_url = backfilled.image;
        listing.upc = backfilled.upc;
        await admin.from('seller_watch_new_listings').update({ title: backfilled.title, brand: backfilled.brand, image_url: backfilled.image, upc: backfilled.upc }).eq('id', listingId);
      } else {
        return jsonResponse({ error: 'No title or UPC available to search with -- Amazon/Keepa has no data for this ASIN yet. Try again shortly.' }, 400);
      }
    }

    await admin.from('seller_watch_new_listings').update({ source_status: 'sourcing', last_searched_at: new Date().toISOString() }).eq('id', listingId);

    // Usage counter -- visibility only, no hard cap for v1. Read-then-write
    // is fine here: a lost increment under concurrent clicks from the same
    // user is a low-stakes cosmetic miss, not a security boundary.
    const mKey = monthKey();
    const { data: usageRow } = await admin.from('find_source_usage').select('search_count').eq('user_id', userId).eq('month_key', mKey).maybeSingle();
    const newCount = (usageRow?.search_count || 0) + 1;
    await admin.from('find_source_usage').upsert({ user_id: userId, month_key: mKey, search_count: newCount, updated_at: new Date().toISOString() }, { onConflict: 'user_id,month_key' });

    // Run title search always, UPC search additionally when available --
    // NOT title-only-when-no-UPC. UPC search is precise but low-recall:
    // most retail pages show the product NAME prominently and never print
    // the raw UPC in indexable text, so UPC-exclusive search can miss real,
    // current US retailers entirely. Confirmed live: for a UPC that only
    // matched 2 foreign resellers, the title search alone found walmart.com
    // and bathandbodyworks.com directly.
    const titleHasBrand = listing.brand && listing.title?.toLowerCase().startsWith(listing.brand.toLowerCase());
    const titleQuery = `${listing.brand && !titleHasBrand ? listing.brand + ' ' : ''}${listing.title}`.slice(0, 120);
    const searches = listing.upc
      ? await Promise.all([searchAll(listing.upc, GOOGLE_API_KEY, GOOGLE_CX_ID, Deno.env.get('SERPAPI_API_KEY')), searchAll(titleQuery, GOOGLE_API_KEY, GOOGLE_CX_ID, Deno.env.get('SERPAPI_API_KEY'))])
      : [await searchAll(titleQuery, GOOGLE_API_KEY, GOOGLE_CX_ID, Deno.env.get('SERPAPI_API_KEY'))];
    const seenUrls = new Set<string>();
    let droppedForeign = 0;
    const raw = searches.flat().filter((c) => {
      if (seenUrls.has(c.url)) return false;
      seenUrls.add(c.url);
      if (!isUsServableDomain(c.url)) { droppedForeign++; return false; }
      return true;
    });
    if (droppedForeign) {
      console.log(`[find-source-candidates] dropped ${droppedForeign} non-US domain(s) before scoring`);
    }

    let scored = raw
      .map((c) => ({ ...c, score: ruleScore(c, listing) }))
      .filter((c) => c.score >= MIN_SCORE_TO_SHOW)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CANDIDATES_VERIFIED);

    if (scored.length === 0) {
      await admin.from('seller_watch_new_listings').update({ source_status: 'no_candidates', candidates: [] }).eq('id', listingId);
      return jsonResponse({ ok: true, status: 'no_candidates', candidates: [], usage: { searchCount: newCount, monthKey: mKey } });
    }

    // Candidates the user explicitly ruled out. Filtered BEFORE verification
    // so a rejected URL does not consume a Gemini/vision slot on its way to
    // being discarded, and cannot reappear after "Search again".
    const rejectedUrls = new Set<string>(
      Array.isArray(listing.rejected_candidate_urls) ? listing.rejected_candidate_urls : [],
    );
    if (rejectedUrls.size) {
      scored = scored.filter((c: any) => !rejectedUrls.has(c.url));
    }

    const verified = await Promise.all(scored.map(async (c) => {
      const [gemini, image] = await Promise.all([
        geminiTextVerify(listing, c, GEMINI_API_KEY),
        compareImages(c.imageUrl, listing.image_url, GEMINI_API_KEY),
      ]);
      const confidence = blendConfidence(c.score, gemini, image);

      // The reason string used to be derived from the Gemini TEXT verdict
      // alone, so a candidate with no image at all still read "Text and image
      // signals align". compareImages returns verdict 'unavailable' the moment
      // either side lacks a URL, so it had frequently not run -- candidate
      // images come only from Google CSE pagemap (cse_image / product.image),
      // which many results simply do not carry, and the SerpAPI fallback path
      // never sets one. Claiming corroborating image evidence that was never
      // gathered overstates the case for exactly the mid-confidence matches a
      // user leans on the reason to judge.
      const imageCompared = !!image && image.verdict !== 'unavailable';
      const reason = !gemini
        ? 'Based on text match only'
        : gemini.verdict === 'same_product'
          ? (imageCompared ? 'Text and image signals align' : 'Text signals align — no image to compare')
          : (imageCompared ? 'Partial match, verify carefully' : 'Partial text match — no image to compare');

      return {
        url: c.url,
        domain: getDomain(c.url),
        title: c.title,
        imageUrl: c.imageUrl,
        confidence,
        label: confidenceLabel(confidence),
        reason,
        price: null as number | null,
        currency: null as string | null,
        availability: null as string | null,
      };
    }));

    verified.sort((a, b) => b.confidence - a.confidence);

    // Live price check on only the top candidate -- keeps per-search cost
    // bounded regardless of how many candidates were verified.
    if (verified[0] && INTERNAL_SECRET) {
      try {
        const priceRes = await fetch(`${SUPABASE_URL}/functions/v1/extract-product-price`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET },
          body: JSON.stringify({ url: verified[0].url, user_id: userId }),
        });
        if (priceRes.ok) {
          const priceJson = await priceRes.json().catch(() => ({}));
          if (typeof priceJson?.price_current === 'number') {
            verified[0].price = priceJson.price_current;
            verified[0].currency = priceJson.currency || null;
            verified[0].availability = priceJson.availability_status || null;
          }
          // SerpAPI results never carry an image (no pagemap data); backfill
          // from the page itself if the search step didn't already have one.
          if (!verified[0].imageUrl && priceJson?.image_url) {
            verified[0].imageUrl = priceJson.image_url;
          }
        }
      } catch (e) {
        console.warn('[find-source-candidates] price check failed:', (e as Error).message);
      }
    }

    await admin.from('seller_watch_new_listings').update({ source_status: 'candidates_found', candidates: verified }).eq('id', listingId);

    return jsonResponse({ ok: true, status: 'candidates_found', candidates: verified, usage: { searchCount: newCount, monthKey: mKey } });
  } catch (e) {
    console.error('[find-source-candidates] error', (e as Error).message);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
