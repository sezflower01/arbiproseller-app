// Phase 2 — Store Scan (category-URL mode)
// Single edge function pipeline: crawl page(s) → collect product URLs → extract → match Amazon
// Strict caps + Firecrawl-only scraping (ScrapingBee removed — subscription expired).
// Reuses extract-product-price for product detail.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
const INTERNAL_SYNC_SECRET = Deno.env.get("INTERNAL_SYNC_SECRET") ?? "";

// SP-API Catalog Search (free — replaces Rainforest)
const SPAPI_REFRESH_TOKEN = Deno.env.get("SPAPI_REFRESH_TOKEN") ?? "";
const SPAPI_LWA_CLIENT_ID = Deno.env.get("SPAPI_LWA_CLIENT_ID") ?? Deno.env.get("LWA_CLIENT_ID") ?? "";
const SPAPI_LWA_CLIENT_SECRET = Deno.env.get("SPAPI_LWA_CLIENT_SECRET") ?? Deno.env.get("LWA_CLIENT_SECRET") ?? "";
const SPAPI_MARKETPLACE_ID = Deno.env.get("SPAPI_MARKETPLACE_ID") ?? "ATVPDKIKX0DER"; // US default
const SPAPI_ENDPOINT = "https://sellingpartnerapi-na.amazon.com";

// Token cache (module-scoped, lives for warm function invocations)
let _spapiToken: { value: string; expiresAt: number } | null = null;
async function getSpApiToken(): Promise<string | null> {
  if (!SPAPI_REFRESH_TOKEN || !SPAPI_LWA_CLIENT_ID || !SPAPI_LWA_CLIENT_SECRET) {
    console.warn("[store-scan] SP-API credentials missing (SPAPI_REFRESH_TOKEN / LWA_CLIENT_ID / LWA_CLIENT_SECRET)");
    return null;
  }
  const now = Date.now();
  if (_spapiToken && _spapiToken.expiresAt > now + 60_000) return _spapiToken.value;
  try {
    const res = await fetch("https://api.amazon.com/auth/o2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: SPAPI_REFRESH_TOKEN,
        client_id: SPAPI_LWA_CLIENT_ID,
        client_secret: SPAPI_LWA_CLIENT_SECRET,
      }).toString(),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.access_token) {
      console.warn(`[store-scan] LWA token failed status=${res.status} body=${JSON.stringify(data).slice(0, 200)}`);
      return null;
    }
    _spapiToken = {
      value: data.access_token,
      expiresAt: now + (data.expires_in ?? 3600) * 1000,
    };
    return _spapiToken.value;
  } catch (e: any) {
    console.warn(`[store-scan] LWA token exception: ${e?.message ?? e}`);
    return null;
  }
}

// ===== Title normalization & matching =====
const STOP_WORDS = new Set([
  "the","a","an","and","or","of","for","by","with","to","in","on","at","from",
  "this","that","is","are","was","be","new","brand","official","authentic",
  "edition","ed","vol","volume","series","set","pack","piece","pieces","pcs",
  "size","color","colour","style","model","item","product","case","cover",
  "small","medium","large","xl","xxl","mini","plus","pro","max","ultra",
  "free","shipping","amazon","prime","best","bestseller","seller",
]);

// Format/binding noise — strip in pass 1 so books/vinyl/CDs match base product
const FORMAT_WORDS = new Set([
  "paperback","hardcover","hardback","softcover","kindle","ebook","audiobook",
  "vinyl","cd","dvd","bluray","blu-ray","mp3","cassette","lp","ep",
  "boxset","box-set","deluxe","collector","collectors","limited","reissue",
  "remastered","import","explicit","clean","unabridged","abridged",
]);

// Generic merchandising / page-noise words that should never outrank true
// identity signals like brand, model, MPN, or rare product-name phrases.
const GENERIC_QUERY_WORDS = new Set([
  "commercial","shop","supplies","supply","sku","mpn","usually","ships","shipping",
  "business","days","free","cart","learn","more","discover","design","services",
  "details","detail","specifications","weight","construction","manufacturer","downloads",
  "manual","maintenance","care","returns","assorted","colors","lightweight","durable",
  "compact","footprint","saves","space","offers","offer","simple","twist","operation",
  "control","kitchen","plastic","minute","minutes","each","month",
  "supplies","essentials","usually","brand","products","product",
]);

const STRONG_PRODUCT_TYPE_WORDS = new Set([
  "timer","timers","countdown","alarm","clock","thermometer","scale","measuring",
  "cups","cup","knife","sharpener","board","grater","peeler","opener","strainer",
  "whisk","spatula","tongs","lamp","bulb","charger","cable","case",
]);

// Supplier/distributor brand prefixes that should be stripped before searching
// Amazon. These rarely appear on Amazon listings (where the actual product
// brand — e.g. "Joie" — is what's indexed), so leaving them in the query
// drowns out the real identity signal.
const SUPPLIER_BRAND_NOISE = new Set([
  "harold","import","imports","webstaurantstore","webstaurant","restaurantware",
  "katom","tundra","wholesale","wholesaler","distributor","culinary","depot",
  "depotinc","inc","llc","corp","corporation","co","company","intl","international",
  "global","group","trading","trade","supplier","supply","supplies","sales",
]);

// Common publisher / "by X" noise — extend as we learn suppliers
const PUBLISHER_HINTS = /\bby\s+[a-z0-9 .&\-']+?(?=\s*[\-\(:|]|$)/gi;

const uniqueOrdered = (values: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

const isModelLikeToken = (token: string): boolean => /\d/.test(token) && token.length >= 4;

function buildIdentityPhrases(tokens: string[]): string[] {
  const identity = tokens.filter((t) => !GENERIC_QUERY_WORDS.has(t));
  const phrases: string[] = [];
  for (let i = 0; i < identity.length - 1 && phrases.length < 4; i++) {
    const a = identity[i];
    const b = identity[i + 1];
    if (!a || !b) continue;
    if (isModelLikeToken(a) && isModelLikeToken(b)) continue;
    phrases.push(`${a} ${b}`);
  }
  return uniqueOrdered(phrases);
}

// Size-unit tokens that poison Amazon keyword search when slightly different
// across retailers (e.g. supplier "3.95-in" vs Amazon "3.75 Inches"). We KEEP
// them on the original title for the verifier (which uses range tolerance), but
// REMOVE them from search queries so the listing actually surfaces.
const SIZE_TOKEN_RE = /\b\d+(?:\.\d+)?\s*-?\s*(?:in|inch|inches|cm|mm|ft|feet|"|'')\b/gi;

// Abbreviation pairs — when one form appears in the supplier title, also try
// queries built with the other form. Bidirectional. Keeps query count small
// by only expanding when the token actually appears.
const ABBREVIATION_PAIRS: Array<[string, string]> = [
  ["television", "tv"],
  ["figurine", "figure"],
  ["volume", "vol"],
  ["edition", "ed"],
];

function expandAbbreviations(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const variants = new Set<string>([text]);
  for (const [long, short] of ABBREVIATION_PAIRS) {
    const longRe = new RegExp(`\\b${long}\\b`, "gi");
    const shortRe = new RegExp(`\\b${short}\\b`, "gi");
    if (longRe.test(lower)) variants.add(text.replace(longRe, short));
    if (shortRe.test(lower)) variants.add(text.replace(shortRe, long));
  }
  return [...variants];
}

function normalizeTitle(raw: string): { cleaned: string; tokens: string[]; isbn: string | null; author: string | null } {
  if (!raw) return { cleaned: "", tokens: [], isbn: null, author: null };
  let s = String(raw)
    // HTML entity decode (basic)
    .replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

  // ISBN-13 / ISBN-10 detection (very useful for books)
  const isbnMatch = s.match(/\b(?:97[89][\- ]?\d{1,5}[\- ]?\d{1,7}[\- ]?\d{1,7}[\- ]?[\dX]|\d{9}[\dX])\b/i);
  const isbn = isbnMatch ? isbnMatch[0].replace(/[\s-]/g, "") : null;

  // Capture "by Author" before stripping it
  let author: string | null = null;
  const byMatch = s.match(/\bby\s+([A-Za-z][A-Za-z .'\-]{2,60})/);
  if (byMatch) author = byMatch[1].trim().replace(/\s+/g, " ");

  // Strip "by Publisher/Author" phrases, parenthetical bits, and bracket noise
  s = s.replace(PUBLISHER_HINTS, " ");
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.replace(/\[[^\]]*\]/g, " ");
  // Strip retailer size measurements that vary across listings (poisons search)
  s = s.replace(SIZE_TOKEN_RE, " ");
  s = s.replace(/[:|–—\-]+/g, " ");

  // Lowercase + strip punctuation
  s = s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();

  const rawTokens = s.split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  for (const t of rawTokens) {
    if (t.length < 2) continue;
    if (STOP_WORDS.has(t)) continue;
    if (FORMAT_WORDS.has(t)) continue;
    if (/^\d{1,2}$/.test(t)) continue; // tiny numbers usually noise
    tokens.push(t);
  }

  // Preserve title order and explicitly prioritize identity signals over long but
  // generic merchandising words. The old length-based sort was dropping short,
  // critical phrases like "joie meow" or model tokens like "12444".
  const deduped = uniqueOrdered(tokens);
  const prioritized = [
    ...deduped.filter(isModelLikeToken),
    ...deduped.filter((t) => !isModelLikeToken(t) && !GENERIC_QUERY_WORDS.has(t)),
    ...deduped.filter((t) => !isModelLikeToken(t) && GENERIC_QUERY_WORDS.has(t)),
  ].slice(0, 12);
  const cleaned = prioritized.join(" ");
  return { cleaned, tokens: prioritized, isbn, author };
}

// ─────────────────────────────────────────────────────────────────────────────
// Category-specific high-recall query builders
// ─────────────────────────────────────────────────────────────────────────────
// Some product families are indexed on Amazon around a tight identity pattern
// (e.g. Funko POP listings = "funko pop <character> <franchise>"). When we
// detect such a pattern in the supplier title, we PREPEND a hand-crafted
// Tier-1 query so retrieval succeeds even when the full retail title would
// otherwise return zero hits (size tokens, "Television" vs "TV", colon noise).
function buildTier1Queries(rawSourceTitle: string, tokens: string[]): string[] {
  const out: string[] = [];
  const lower = rawSourceTitle.toLowerCase();

  // ---- Funko POP detector ----
  // Strong indicator: brand "funko" + line "pop". Pull the character & franchise.
  if (/\bfunko\b/i.test(lower) && /\bpop\b/i.test(lower)) {
    // Tokens left after normalization usually include character + franchise.
    // Drop generic line/category words to leave the high-signal identity tokens.
    const FUNKO_GENERIC = new Set([
      "funko", "pop", "vinyl", "figure", "figurine", "collectible", "collectable",
      "television", "tv", "movies", "movie", "games", "game", "animation",
      "exclusive", "bobble", "head",
    ]);
    // Keep MORE identity tokens (was 4 → 6) so the character name isn't dropped
    // in titles like "Funko POP! Television: Arcane: League of Legends Jinx ...".
    // Here ["arcane","league","legends","jinx"] used to lose "jinx" when sliced
    // to 3 inside the joined query. Funko titles follow "<franchise> <character>",
    // so the LAST identity token is usually the character — the highest-signal word.
    const identity = tokens.filter((t) => !FUNKO_GENERIC.has(t)).slice(0, 6);
    if (identity.length >= 1) {
      const character = identity[identity.length - 1]; // last token = character (e.g. "jinx")
      const franchiseHead = identity[0];                // first token = franchise root (e.g. "arcane")

      // Tier-1A: brand + character + franchise root (highest precision + recall)
      // e.g. "funko pop jinx arcane" — almost always surfaces the correct ASIN.
      if (identity.length >= 2 && character !== franchiseHead) {
        out.push(`funko pop ${character} ${franchiseHead}`.trim());
        out.push(`funko ${character} ${franchiseHead}`.trim());
      }

      // Tier-1B: brand + character ONLY (high recall safety net)
      out.push(`funko pop ${character}`.trim());
      out.push(`funko ${character}`.trim());

      // Tier-1C: full identity sequence (legacy pattern, kept for non-character-last titles)
      out.push(`funko pop ${identity.slice(0, 4).join(" ")}`.trim());
      out.push(`funko ${identity.slice(0, 4).join(" ")}`.trim());

      // Tier-1D: franchise root + character (no brand) — last-resort character-led search
      if (identity.length >= 2 && character !== franchiseHead) {
        out.push(`${character} ${franchiseHead}`.trim());
      }
    }
  }

  // ---- Generic collectibles brand detector ----
  // Other major collectibles brands follow the same "brand + character" pattern.
  const COLLECTIBLE_BRANDS = ["pop mart", "popmart", "labubu", "hot toys", "mcfarlane", "neca", "bandai", "tamashii", "kotobukiya", "good smile", "nendoroid", "figma"];
  for (const brand of COLLECTIBLE_BRANDS) {
    if (lower.includes(brand)) {
      const brandTokens = new Set(brand.split(" "));
      const GENERIC = new Set([
        ...brandTokens,
        "figure", "figurine", "collectible", "collectable", "vinyl",
        "exclusive", "limited", "edition", "series", "scale", "inch", "in",
      ]);
      const identity = tokens.filter((t) => !GENERIC.has(t)).slice(0, 4);
      if (identity.length >= 1) {
        out.push(`${brand} ${identity.slice(0, 3).join(" ")}`.trim());
        out.push(`${brand} ${identity[0]}`.trim());
        if (identity.length >= 2) {
          out.push(`${brand} ${identity[0]} ${identity[identity.length - 1]}`.trim());
        }
      }
      break;
    }
  }

  return uniqueOrdered(out.filter((q) => q && q.length >= 5));
}

// Build a SIMPLIFIED set of last-resort queries used when the primary
// retrieval pass returns zero candidates. We strip everything except the
// strongest 1-2 identity signals (brand/character/model) so generic Amazon
// search can still surface the listing.
function buildSimplifiedFallbackQueries(
  rawSourceTitle: string,
  identityTokens: string[],
  modelTokens: string[],
  identityPhrases: string[],
): string[] {
  const out: string[] = [];
  const lower = rawSourceTitle.toLowerCase();

  // Detect a known collectible brand once — we use it to expand
  // brand+character / brand+character+franchise permutations.
  const KNOWN_BRANDS = ["funko pop", "funko", "pop mart", "popmart", "labubu", "neca", "mcfarlane", "bandai", "hot toys", "kotobukiya"];
  let detectedBrand: string | null = null;
  for (const b of KNOWN_BRANDS) {
    if (lower.includes(b)) { detectedBrand = b; break; }
  }

  // Strip brand tokens out of identityTokens so "character" slots are clean.
  const brandTokenSet = new Set((detectedBrand ?? "").split(/\s+/));
  const cleanIdentity = identityTokens.filter((t) => !brandTokenSet.has(t));

  // ── Brand-aware permutations (collectibles: Funko, etc.) ──────────
  if (detectedBrand && cleanIdentity.length >= 1) {
    // For collectible titles like "Funko POP! Television: Arcane: League of Legends Jinx",
    // the CHARACTER is the LAST identity token, not the first. The franchise
    // tokens come first because of the colon-prefixed line ("Television: Arcane:").
    // Funko brand → character-last; other brands → character-first (legacy).
    const isCharacterLastBrand = /^funko/.test(detectedBrand);
    const character = isCharacterLastBrand
      ? cleanIdentity[cleanIdentity.length - 1]
      : cleanIdentity[0];
    const franchise = isCharacterLastBrand
      ? cleanIdentity[0]
      : (cleanIdentity.length >= 2 ? cleanIdentity[cleanIdentity.length - 1] : null);
    // Most specific → least specific
    if (franchise && franchise !== character) {
      out.push(`${detectedBrand} ${character} ${franchise}`);
      out.push(`${character} ${franchise}`); // character + franchise alone
    }
    out.push(`${detectedBrand} ${character}`);  // brand + character ONLY (high recall)
    out.push(`${character}`);                   // character ONLY (last resort)
  }

  // ── Generic permutations (used when no known brand detected) ──────
  // 1) Top identity phrase alone (e.g. "joie meow", "rare bear")
  if (identityPhrases[0]) out.push(identityPhrases[0]);

  // 2) Top 2 identity tokens (no franchise/extras)
  if (cleanIdentity.length >= 2) {
    out.push(cleanIdentity.slice(0, 2).join(" "));
  }

  // 3) Character + franchise (last token often = franchise)
  if (cleanIdentity.length >= 3) {
    out.push(`${cleanIdentity[0]} ${cleanIdentity[cleanIdentity.length - 1]}`);
  }

  // 4) Single strongest identity token
  if (cleanIdentity[0]) out.push(cleanIdentity[0]);

  // 5) Model/UPC token alone (very high precision when present)
  if (modelTokens[0]) out.push(modelTokens[0]);

  return uniqueOrdered(out.filter((q) => q && q.length >= 3)).slice(0, 6);
}


// Token-set Jaccard similarity (operates on normalized tokens)
function jaccardSim(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a), sb = new Set(b);
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return Math.round((inter / union) * 100);
}

// Token containment — how many source tokens appear in candidate (asymmetric)
function containment(source: string[], candidate: string[]): number {
  if (!source.length) return 0;
  const sc = new Set(candidate);
  const hits = source.filter((t) => sc.has(t)).length;
  return Math.round((hits / source.length) * 100);
}

function bandConfidence(score: number): "high" | "medium" | "low" | "none" {
  if (score >= 75) return "high";
  if (score >= 55) return "medium";
  if (score >= 35) return "low";
  return "none";
}

// ─── PRICE-SANITY GUARD ───────────────────────────────────────────────────
// Detects matches where the supplier and Amazon prices are so far apart
// that the candidate is almost certainly wrong (different product, bundle,
// variant, or accessory). Used as a SIGNAL, not a hard reject — the row
// still surfaces, but it is routed to the Review bucket and its confidence
// score is reduced.
type PriceSanity = "ok" | "too_low" | "too_high" | "unknown";
function evaluatePriceSanity(
  supplierPrice: number | null | undefined,
  amazonPrice: number | null | undefined,
): { state: PriceSanity; ratio: number | null } {
  if (
    !supplierPrice || supplierPrice <= 0 ||
    !amazonPrice || amazonPrice <= 0 ||
    !Number.isFinite(supplierPrice) || !Number.isFinite(amazonPrice)
  ) {
    return { state: "unknown", ratio: null };
  }
  const ratio = amazonPrice / supplierPrice;
  // Amazon < 30% of supplier price → suspicious (likely wrong/sub-product)
  if (ratio < 0.3) return { state: "too_low", ratio };
  // Amazon > 5× supplier price → suspicious (likely bundle / collectible /
  // wrong listing). Real arbitrage rarely exceeds 5×; flag for review.
  if (ratio > 5) return { state: "too_high", ratio };
  return { state: "ok", ratio };
}

// ─── COMPOSITE CONFIDENCE SCORE (0–100) ───────────────────────────────────
// Combines retrieval/text quality, engine/AI verdict, price sanity and
// verification depth into a single trust score. Bands map onto UI buckets:
//   ≥70 → trusted   (auto-show)
//   40–69 → review  (route to Review bucket)
//   <40 → rejected  (hide unless user toggles "show all")
type ConfidenceBand = "trusted" | "review" | "rejected";
type QualitySignals = {
  text_score: number | null;       // 0-100 retrieval score
  engine_verdict: string | null;   // exact_match / likely_match / etc
  engine_confidence: number | null; // 0-100 from verifier
  price_sanity: PriceSanity;
  price_ratio: number | null;
  verification_depth: "full" | "listing_fallback" | "none";
  has_amazon_price: boolean;
  image_mismatch: boolean;
};
function scoreMatchConfidence(s: QualitySignals): { score: number; band: ConfidenceBand } {
  // Start from text retrieval score (0-100) — the strongest single signal.
  let score = Math.max(0, Math.min(100, Math.round(s.text_score ?? 0)));

  // Identity-anchor: a perfect text match + exact_match verdict is the strongest
  // possible signal. Soft penalties (listing_fallback, no_amazon_price, mild
  // image uncertainty) must NOT push it below Trusted. Only HARD conflicts
  // (image mismatch, bad price sanity) can override identity.
  const isPerfectIdentity =
    s.engine_verdict === "exact_match" &&
    typeof s.text_score === "number" && s.text_score >= 95;

  // Engine verdict strongly shapes trust (positive AND negative).
  switch (s.engine_verdict) {
    case "exact_match":
      score = Math.max(score, 88);
      break;
    case "same_base_product_different_pack":
      score = Math.max(score, 70);
      break;
    case "likely_match":
      // Blend with engine_confidence if present so high-confidence likely
      // matches still land in the trusted band.
      if (typeof s.engine_confidence === "number") {
        score = Math.max(score, Math.round(s.engine_confidence * 0.85));
      } else {
        score = Math.max(score, 55);
      }
      break;
    case "not_match":
      score = Math.min(score, 25);
      break;
    default:
      // No verdict → cap at 70 so unverified matches never feel "trusted".
      score = Math.min(score, 70);
  }

  // Price sanity penalty — never a hard reject, only a confidence hit.
  if (s.price_sanity === "too_low") score = Math.min(score - 25, 55);
  else if (s.price_sanity === "too_high") score = Math.min(score - 20, 60);

  // Listing-fallback verification (PDP blocked) → cap at 75.
  // Skipped for perfect identity matches (text=100% + exact_match): identity
  // is the strongest signal, fallback is a soft signal.
  if (s.verification_depth === "listing_fallback" && !isPerfectIdentity) {
    score = Math.min(score, 75);
  }

  // No Amazon price means we can't compute ROI → cap at 60 (review bucket).
  // Same identity exception: if we know it's the right product, missing live
  // price is a data-availability issue, not a trust issue.
  if (!s.has_amazon_price && !isPerfectIdentity) {
    score = Math.min(score, 60);
  }

  // Strong visual disagreement should never remain Trusted. Image mismatch
  // alone routes to Review; combined with bad price sanity it becomes Rejected.
  // This OVERRIDES identity — image_mismatch is a hard conflict signal.
  if (s.image_mismatch) {
    score = Math.min(score, s.price_sanity === "ok" || s.price_sanity === "unknown" ? 84 : 39);
  }

  // Identity floor: perfect identity matches with no hard conflicts must
  // remain Trusted (≥85). Soft signals can shave off but never demote.
  if (isPerfectIdentity && !s.image_mismatch && s.price_sanity !== "too_low" && s.price_sanity !== "too_high") {
    score = Math.max(score, 88);
  }

  score = Math.max(0, Math.min(100, score));
  let band: ConfidenceBand =
    score >= 85 ? "trusted" :
    score >= 40 ? "review" :
    "rejected";

  if (s.image_mismatch && (s.price_sanity === "too_low" || s.price_sanity === "too_high")) {
    band = "rejected";
  } else if (s.image_mismatch) {
    band = "review";
  }

  return { score, band };
}

// Amazon search via SP-API Catalog Items (free — uses our SP-API connection).
// Returns a list of { asin, title, image, price?, link } shaped like the old Rainforest results
// so the downstream scoring code is unchanged.
interface AmazonSearchOptions {
  pageSize?: number;
  pageLimit?: number;
}

async function searchAmazon(query: string, options: AmazonSearchOptions = {}): Promise<any[]> {
  if (!query) return [];
  const token = await getSpApiToken();
  if (!token) {
    console.warn(`[store-scan searchAmazon] no SP-API token — skipping query="${query.slice(0, 60)}"`);
    return [];
  }
  const pageSize = Math.max(1, Math.min(options.pageSize ?? 10, 20));
  const pageLimit = Math.max(1, Math.min(options.pageLimit ?? 1, 3));
  try {
    const seen = new Set<string>();
    const merged: any[] = [];
    let nextToken: string | null = null;
    let fetchedPages = 0;

    for (let page = 1; page <= pageLimit; page++) {
      const url = new URL("/catalog/2022-04-01/items", SPAPI_ENDPOINT);
      url.searchParams.set("marketplaceIds", SPAPI_MARKETPLACE_ID);
      url.searchParams.set("keywords", query);
      url.searchParams.set("includedData", "summaries,images,identifiers");
      url.searchParams.set("pageSize", String(pageSize));
      if (nextToken) url.searchParams.set("pageToken", nextToken);

      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "x-amz-access-token": token,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`[store-scan searchAmazon] SP-API HTTP ${res.status} for query="${query.slice(0, 60)}" body=${body.slice(0, 200)}`);
        break;
      }

      const data = await res.json();
      const items = data?.items ?? [];
      fetchedPages++;

      const normalized = items.map((it: any) => {
        const summary = (it?.summaries ?? []).find((s: any) => s?.marketplaceId === SPAPI_MARKETPLACE_ID) ?? it?.summaries?.[0] ?? {};
        const imgGroups = it?.images ?? [];
        const firstImage = imgGroups?.[0]?.images?.[0]?.link ?? null;
        return {
          asin: it?.asin ?? null,
          title: summary?.itemName ?? null,
          image: firstImage,
          price: null,
          link: it?.asin ? `https://www.amazon.com/dp/${it.asin}` : null,
        };
      }).filter((r: any) => r.asin && r.title);

      for (const row of normalized) {
        if (seen.has(row.asin)) continue;
        seen.add(row.asin);
        merged.push(row);
      }

      nextToken = data?.pagination?.nextToken ?? data?.nextToken ?? null;
      if (!nextToken || items.length === 0) break;
    }

    console.log(`[store-scan searchAmazon] SP-API query="${query.slice(0, 60)}" returned=${merged.length} usable across ${fetchedPages} page(s)`);
    return merged;
  } catch (e: any) {
    console.warn(`[store-scan searchAmazon] exception query="${query.slice(0, 60)}" err=${e?.message ?? e}`);
    return [];
  }
}

// Shared service-role client for invoking sibling edge functions and reading caches.
const _priceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ── Buy-box cache fallback (populated by calculate-roi). When SP-API is throttled
// or returns no offers, fall back to the most recent cached price for this ASIN.
async function fetchPriceFromCache(asin: string): Promise<number | null> {
  if (!asin) return null;
  try {
    const { data } = await _priceClient
      .from("buy_box_cache")
      .select("price, fetched_at")
      .eq("asin", asin)
      .eq("marketplace_id", SPAPI_MARKETPLACE_ID)
      .order("fetched_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const p = Number(data?.price);
    if (Number.isFinite(p) && p > 0) {
      console.log(`[store-scan fetchPriceFromCache] HIT asin=${asin} price=$${p} fetched_at=${data?.fetched_at}`);
      return p;
    }
    return null;
  } catch (e: any) {
    console.warn(`[store-scan fetchPriceFromCache] err asin=${asin}: ${e?.message ?? e}`);
    return null;
  }
}

interface RoiPayload {
  price: number | null;
  totalFees: number | null;
  roi: number | null;
  margin: number | null;
  source: string; // "calculate-roi" | "fetch-product-price" | "cache" | "estimate" | "none"
}

// Fetch live ROI/price/fees for a single ASIN with multi-tier fallback:
//   1) calculate-roi (preferred — uses the same engine as the per-row Refresh button,
//      includes proper SP-API offers + Product Fees API + buy_box_cache + retries)
//   2) fetch-product-price (lighter SP-API call as a backup)
//   3) buy_box_cache (last-known good price)
//   4) heuristic fee estimate when only a price is recoverable
// Always returns a payload — never throws — so a transient SP-API hiccup never
// leaves a scanned row with ROI=n/a when we have any usable signal.
async function fetchRoiForAsin(
  asin: string,
  buyCost: number,
  ownerUserId: string | null,
): Promise<RoiPayload> {
  const empty: RoiPayload = { price: null, totalFees: null, roi: null, margin: null, source: "none" };
  if (!asin || !Number.isFinite(buyCost) || buyCost <= 0) return empty;

  const isQuotaError = (msg: string) => /429|quota|rate.?limit/i.test(msg);

  // ── Tier 1: calculate-roi (with one retry on 429) ────────────────────────
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { data, error } = await _priceClient.functions.invoke("calculate-roi", {
        body: { asin, cost: buyCost, marketplace: "US", userId: ownerUserId ?? undefined },
      });
      const errMsg = String((error as any)?.message ?? (data as any)?.error ?? "");
      if ((error || (data as any)?.error) && isQuotaError(errMsg) && attempt === 1) {
        const wait = 1500 + Math.random() * 1000;
        console.warn(`[store-scan fetchRoiForAsin] 429 from calculate-roi asin=${asin}, retry in ${Math.round(wait)}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (error || (data as any)?.error) {
        console.warn(`[store-scan fetchRoiForAsin] calculate-roi err asin=${asin} err=${errMsg.slice(0, 200)}`);
        break;
      }
      const calc = (data as any)?.calculation ?? {};
      const price = Number((data as any)?.price);
      if (Number.isFinite(price) && price > 0) {
        const roi = Number.isFinite(Number(calc.roi)) ? Number(calc.roi) : null;
        const margin = Number.isFinite(Number(calc.margin)) ? Number(calc.margin) : null;
        const totalFees = Number.isFinite(Number(calc.totalFees)) ? Number(calc.totalFees) : null;
        console.log(`[store-scan fetchRoiForAsin] calculate-roi OK asin=${asin} price=$${price} roi=${roi}%`);
        return { price, totalFees, roi, margin, source: "calculate-roi" };
      }
      console.log(`[store-scan fetchRoiForAsin] calculate-roi no price asin=${asin}`);
      break;
    } catch (e: any) {
      console.warn(`[store-scan fetchRoiForAsin] calculate-roi exception asin=${asin}: ${e?.message ?? e}`);
      break;
    }
  }

  // ── Tier 2: fetch-product-price (lighter call; sometimes succeeds when calc-roi flow fails) ──
  let price: number | null = null;
  let totalFees: number | null = null;
  try {
    const { data, error } = await _priceClient.functions.invoke("fetch-product-price", {
      body: { asin, marketplaceId: SPAPI_MARKETPLACE_ID },
    });
    if (!error && data && !(data as any).error) {
      const p = Number((data as any).price);
      if (Number.isFinite(p) && p > 0) {
        price = p;
        const f = Number((data as any).totalFees);
        if (Number.isFinite(f) && f > 0) totalFees = f;
        console.log(`[store-scan fetchRoiForAsin] fetch-product-price OK asin=${asin} price=$${p} fees=${totalFees ?? "?"}`);
      }
    }
  } catch (e: any) {
    console.warn(`[store-scan fetchRoiForAsin] fetch-product-price exception asin=${asin}: ${e?.message ?? e}`);
  }

  // ── Tier 3: buy_box_cache (last-known good price) ────────────────────────
  if (price == null) {
    const cached = await fetchPriceFromCache(asin);
    if (cached) {
      price = cached;
    }
  }

  if (price == null || price <= 0) return empty;

  // ── Tier 4: heuristic fee estimate when fee API didn't return one ────────
  // 15% referral + ~$4.50 FBA — same baseline used elsewhere in the scan.
  if (totalFees == null) totalFees = price * 0.15 + 4.5;
  const profit = price - buyCost - totalFees;
  const roi = Math.round((profit / buyCost) * 100 * 100) / 100;
  const margin = Math.round((profit / price) * 100 * 100) / 100;
  console.log(`[store-scan fetchRoiForAsin] estimated asin=${asin} price=$${price} roi=${roi}%`);
  return { price, totalFees, roi, margin, source: totalFees && totalFees !== price * 0.15 + 4.5 ? "fetch-product-price" : "estimate" };
}

// Backwards-compatible thin wrapper: only used when we just need a price (no ROI ctx).
async function fetchAsinPrice(asin: string): Promise<number | null> {
  const r = await fetchRoiForAsin(asin, 1, null); // dummy cost so the helper still resolves a price
  return r.price;
}

interface AmzCandidate {
  asin: string | null;
  title: string | null;
  price: number | null;
  image: string | null;
  link: string | null;
  score: number;
  confidence: "high" | "medium" | "low" | "none";
  // Smart-engine + AI verdict (added per candidate so the UI can group
  // results into Exact / Likely / Review buckets without a follow-up RPC).
  verdict?: "exact_match" | "likely_match" | "same_base_product_different_pack" | "not_match" | null;
  engine_confidence?: number | null;
  decision_signal?: string | null;
  verdict_source?: "engine" | "ai" | "hybrid" | null;
  verdict_reason?: string | null;
  verification_evidence?: Record<string, unknown> | null;
}

async function matchAmazon(sourceTitle: string, sourcePrice: number | null, ownerUserId: string | null): Promise<{
  asin: string | null;
  title: string | null;
  price: number | null;
  image: string | null;
  score: number;
  method: string;
  confidence: "high" | "medium" | "low" | "none";
  roi: number | null;
  margin: number | null;
  candidates: AmzCandidate[];
  query: string;
  feesJson: any | null;
}> {
  const empty = (method: string, query = "") => ({
    asin: null, title: null, price: null, image: null,
    score: 0, method, confidence: "none" as const,
    roi: null, margin: null, candidates: [], query, feesJson: null,
  });
  if (!sourceTitle) return empty("no_title");

  const rawSourceTitle = String(sourceTitle).replace(/\s+/g, " ").trim();
  const rawSourceTitleLower = rawSourceTitle.toLowerCase();
  const norm = normalizeTitle(sourceTitle);
  console.log(`[matchAmazon] source="${sourceTitle.slice(0, 80)}" → cleaned="${norm.cleaned}" isbn=${norm.isbn ?? "-"} author=${norm.author ?? "-"} tokens=${norm.tokens.length} source=spapi`);

  if (!norm.cleaned && !norm.isbn) return empty("no_keywords");

  // Build search queries: ISBN first if present, then phrase-priority queries
  // that strip supplier-brand noise (e.g. "Harold Import") so distinctive
  // identity signals (e.g. "Joie Meow") dominate the Amazon keyword search.
  const queries: string[] = [];
  const identityTokens = norm.tokens.filter((t) => !GENERIC_QUERY_WORDS.has(t));
  const cleanIdentityTokens = identityTokens.filter((t) => !SUPPLIER_BRAND_NOISE.has(t));
  const modelTokens = cleanIdentityTokens.filter(isModelLikeToken);
  const phraseTokens = cleanIdentityTokens.filter((t) => !isModelLikeToken(t));
  const strongTypeHints = uniqueOrdered(
    norm.tokens.filter((t) => STRONG_PRODUCT_TYPE_WORDS.has(t) || /^\d{1,3}(?:-minute)?$/.test(t)),
  ).slice(0, 2);
  const identityPhrases = buildIdentityPhrases(
    norm.tokens.filter((t) => !SUPPLIER_BRAND_NOISE.has(t))
  );

  if (norm.isbn) queries.push(norm.isbn);

  // ── TIER 1: category-aware high-recall queries ─────────────────────────────
  // Run BEFORE the raw supplier title. For known patterns (e.g. Funko POP),
  // these almost always surface the correct ASIN even when the full retail
  // title fails because of size/punctuation/abbreviation noise.
  for (const tier1 of buildTier1Queries(rawSourceTitle, norm.tokens)) {
    queries.push(tier1);
  }

  // Always run the exact supplier title first. The current bug is specifically
  // that manual Amazon searches using the raw supplier title return the correct
  // listing, while our derived/normalized queries surface a wrong sibling SKU.
  // Preserve the raw query before we strip supplier/distributor words.
  if (rawSourceTitle.length >= 8) {
    queries.push(rawSourceTitle);
    // Abbreviation-expanded variants (e.g. "Television" ↔ "TV") so the search
    // surfaces listings that use the alternate form. Cheap — only adds when
    // the trigger word is actually present.
    for (const variant of expandAbbreviations(rawSourceTitle)) {
      if (variant !== rawSourceTitle) queries.push(variant);
    }
  }

  const productTypeHints = strongTypeHints;

  // 1) MPN-priority queries — when supplier exposes a model token (e.g. "12444"),
  //    pair it with brand and product-type hints so the correct SKU surfaces
  //    even when generic phrase queries return a wrong family member.
  if (modelTokens.length > 0) {
    const mpn = modelTokens[0];
    for (const hint of productTypeHints) {
      queries.push(`${mpn} ${hint}`.trim());
    }
    if (productTypeHints.length > 0) {
      queries.push(`${phraseTokens[0] ?? identityPhrases[0] ?? ""} ${mpn} ${productTypeHints[0]}`.trim());
    }
    // Brand-token + MPN (e.g. "joie 12444")
    if (phraseTokens.length > 0) {
      queries.push(`${phraseTokens[0]} ${mpn}`.trim());
    }
    // Identity phrase + MPN (e.g. "joie meow 12444")
    if (identityPhrases.length > 0) {
      queries.push(`${identityPhrases[0]} ${mpn}`.trim());
    }
    queries.push(mpn);
  }
  // 2) Phrase + product-type word (e.g. "joie meow timer")
  for (const phrase of identityPhrases.slice(0, 2)) {
    for (const hint of productTypeHints) {
      queries.push(`${phrase} ${hint}`.trim());
    }
  }
  // 3) Strongest signal: rare 2-word identity phrase alone (e.g. "joie meow")
  for (const phrase of identityPhrases.slice(0, 2)) {
    queries.push(phrase);
  }
  // 4) Phrase tokens + model
  if (modelTokens.length > 0 && phraseTokens.length > 0) {
    queries.push(`${phraseTokens.slice(0, 3).join(" ")} ${modelTokens[0]}`.trim());
  }
  // 5) Top identity tokens (no supplier brand)
  if (cleanIdentityTokens.length >= 2) {
    queries.push(cleanIdentityTokens.slice(0, 4).join(" "));
  }
  // 6) Original cleaned fallback (still includes supplier brand if present)
  if (norm.cleaned) queries.push(norm.cleaned);
  if (norm.tokens.length > 4) queries.push(norm.tokens.slice(0, 4).join(" "));
  const finalQueries = uniqueOrdered(queries.filter((q) => q && q.length >= 3)).slice(0, 10);
  const mpnFocusedQueries = modelTokens.length > 0
    ? uniqueOrdered([
        phraseTokens[0] && productTypeHints[0] ? `"${phraseTokens[0]} ${modelTokens[0]} ${productTypeHints[0]}"` : "",
        identityPhrases[0] && productTypeHints[0] ? `"${identityPhrases[0]} ${modelTokens[0]} ${productTypeHints[0]}"` : "",
        identityPhrases[0] ? `"${identityPhrases[0]} ${modelTokens[0]}"` : "",
        phraseTokens[0] ? `"${phraseTokens[0]} ${modelTokens[0]}"` : "",
        productTypeHints[0] ? `"${modelTokens[0]} ${productTypeHints[0]}"` : "",
        phraseTokens.length > 0 && productTypeHints.length > 0 ? `"${phraseTokens[0]} ${modelTokens[0]} ${productTypeHints[0]}"` : "",
        `"${modelTokens[0]}"`,
      ].filter((q) => q.length >= 3)).slice(0, 6)
    : [];

  console.log(`[matchAmazon] trying ${finalQueries.length} queries: ${finalQueries.map(q => `"${q.slice(0, 50)}"`).join(" | ")}`);

  // Multi-pass retrieval: instead of stopping at the first non-empty query,
  // run the top queries and merge candidates by ASIN. This dramatically
  // increases the odds the correct listing makes it into the candidate set
  // even when one query alone (e.g. brand-heavy) misses it.
  //
  // Target pool: ~20 unique candidates (vs. previous 12). Larger pool catches
  // long-tail correct matches that earlier queries miss (e.g. supplier MPN
  // buried in title, only surfaced by query #5).
  const merged = new Map<string, any>();
  let usedQuery = "";
  let queriesRun = 0;
  for (const q of finalQueries) {
    if (queriesRun >= 10) break; // hard cap to control SP-API spend
    const lowerQuery = q.toLowerCase();
    const isRawSupplierTitleQuery = rawSourceTitleLower.length >= 8 && lowerQuery === rawSourceTitleLower;
    const isDeepIntentQuery = isRawSupplierTitleQuery || (modelTokens.length > 0 && modelTokens.some((token) => lowerQuery.includes(token.toLowerCase())));
    const r = await searchAmazon(q, isDeepIntentQuery ? { pageSize: 20, pageLimit: 3 } : { pageSize: 10, pageLimit: 1 });
    queriesRun++;
    if (!r.length) continue;
    if (!usedQuery) usedQuery = q;
    for (const item of r) {
      if (!item?.asin) continue;
      if (!merged.has(item.asin)) merged.set(item.asin, item);
    }
    // Once we have a healthy pool that already includes an MPN-style hit, stop early.
    const hasStrongHit = [...merged.values()].some((item: any) => {
      const title = String(item?.title ?? "").toLowerCase();
      const hasModel = modelTokens.length === 0 || modelTokens.some((token) => title.includes(token.toLowerCase()));
      const hasType = productTypeHints.length === 0 || productTypeHints.some((hint) => title.includes(hint.toLowerCase()));
      const hasRawPhrase = isRawSupplierTitleQuery
        ? phraseTokens.filter((token) => token.length >= 3).some((token) => title.includes(token.toLowerCase()))
        : true;
      return hasModel && hasType && hasRawPhrase;
    });
    if (merged.size >= 30 && hasStrongHit) break;
  }
  const results = [...merged.values()];
  const hasInitialMpnLikeHit = modelTokens.length > 0 && results.some((row) => {
    const title = String(row?.title ?? "").toLowerCase();
    const hasModel = modelTokens.some((token) => title.includes(token.toLowerCase()));
    const hasTypeHint = productTypeHints.length === 0 || productTypeHints.some((hint) => title.includes(hint.toLowerCase()));
    const hasBrandHint = phraseTokens.length === 0 || phraseTokens.some((token) => title.includes(token.toLowerCase()));
    return hasModel && hasTypeHint && hasBrandHint;
  });
  const shouldRunMpnFallback = modelTokens.length > 0 && (results.length < 20 || !hasInitialMpnLikeHit);
  if (shouldRunMpnFallback) {
    console.log(`[matchAmazon] MPN fallback triggered for model=${modelTokens[0]} after ${results.length} initial candidates`);
    for (const q of mpnFocusedQueries) {
      const r = await searchAmazon(q, { pageSize: 20, pageLimit: 3 });
      queriesRun++;
      if (!r.length) continue;
      for (const item of r) {
        if (!item?.asin) continue;
        if (!merged.has(item.asin)) merged.set(item.asin, item);
      }
      if (merged.size >= 50) break;
    }
  }
  const mergedResults = [...merged.values()];

  // ── SECOND-PASS SIMPLIFIED RETRY ─────────────────────────────────────────
  // If the primary retrieval pass returned nothing, retry with stripped-down
  // queries (brand-only, character-only, model-only). This recovers a large
  // share of collectibles / specialty items where the full title is too noisy.
  if (!mergedResults.length) {
    const simplified = buildSimplifiedFallbackQueries(
      rawSourceTitle,
      cleanIdentityTokens,
      modelTokens,
      identityPhrases,
    );
    if (simplified.length > 0) {
      console.log(`[matchAmazon] no_results — running simplified retry: ${simplified.map((q) => `"${q}"`).join(" | ")}`);
      for (const q of simplified) {
        const r = await searchAmazon(q, { pageSize: 15, pageLimit: 1 });
        queriesRun++;
        if (!r.length) continue;
        if (!usedQuery) usedQuery = q;
        for (const item of r) {
          if (!item?.asin) continue;
          if (!merged.has(item.asin)) merged.set(item.asin, item);
        }
        if (merged.size >= 15) break;
      }
    }
    const retryResults = [...merged.values()];
    if (!retryResults.length) return empty("no_results", finalQueries[0] ?? "");
    console.log(`[matchAmazon] simplified retry recovered ${retryResults.length} candidates (query="${usedQuery.slice(0,50)}")`);
    mergedResults.push(...retryResults);
  } else {
    console.log(`[matchAmazon] merged ${mergedResults.length} unique candidates from ${queriesRun} queries (first hit="${usedQuery.slice(0,50)}")`);
  }


  // Score top 20 candidates with identity-weighted retrieval. Distinctive phrases
  // and model/MPN-like tokens must dominate generic category overlap.
  const scored: AmzCandidate[] = [];
  const sourceIdentitySet = new Set(identityTokens);
  const sourcePhraseSet = new Set(identityPhrases);
  for (const r of mergedResults.slice(0, 50)) {
    const candNorm = normalizeTitle(r?.title ?? "");
    const j = jaccardSim(norm.tokens, candNorm.tokens);
    const c = containment(norm.tokens, candNorm.tokens);
    const candSet = new Set(candNorm.tokens);
    const sharedIdentity = [...sourceIdentitySet].filter((t) => candSet.has(t)).length;
    const identityContainment = sourceIdentitySet.size > 0
      ? Math.round((sharedIdentity / sourceIdentitySet.size) * 100)
      : 0;
    const modelHit = modelTokens.some((token) => candSet.has(token));
    const phraseHit = [...sourcePhraseSet].some((phrase) => candNorm.cleaned.includes(phrase));

    let score = Math.round(0.35 * j + 0.2 * c + 0.45 * identityContainment);
    if (phraseHit) score += 20;
    if (modelHit) score += 18;
    if (sharedIdentity >= 2) score += 10;
    if (sourceIdentitySet.size >= 2 && sharedIdentity === 0) score = Math.min(score, 20);
    // Author bonus: if source has author and candidate title contains it, +10 (cap 100)
    if (norm.author && (r?.title ?? "").toLowerCase().includes(norm.author.toLowerCase().split(" ")[0])) {
      score = Math.min(100, score + 10);
    }
    // ISBN exact-match bonus
    if (norm.isbn && (r?.asin ?? "").toUpperCase() === norm.isbn.toUpperCase()) {
      score = 100;
    }
    score = Math.max(0, Math.min(100, score));
    const amzPrice = typeof r?.price?.value === "number" ? r.price.value : null;
    scored.push({
      asin: r?.asin ?? null,
      title: r?.title ?? null,
      price: amzPrice,
      image: r?.image ?? null,
      link: r?.link ?? null,
      score,
      confidence: bandConfidence(score),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  // Persist a deeper candidate pool (was: top 3) so the UI can show every
  // viable Amazon listing grouped by verdict — Exact / Likely / Review.
  const topPool = scored.slice(0, 20);

  // ── Smart-engine classification on EVERY candidate ───────────────────
  // We call verify-store-scan-match with engineOnly=true to run the
  // deterministic Match Intelligence Engine on all 20 candidates without
  // firing the AI per row (cost control). Any candidate the engine flags
  // as `review_needed` then gets a follow-up AI second-opinion call.
  let acceptedScored: AmzCandidate | null = null;
  try {
    const verifyItems = topPool
      .filter((c) => !!c.asin)
      .map((c) => ({
        source_url: `supplier://${ownerUserId ?? "anon"}/${encodeURIComponent(sourceTitle).slice(0, 200)}`,
        asin: c.asin as string,
        source_title: sourceTitle,
        source_price: sourcePrice,
        amz_title: c.title,
        amz_image_url: c.image,
        amz_price: c.price,
      }));

    const callVerify = async (engineOnly: boolean): Promise<Record<string, any>> => {
      const internalSecret = Deno.env.get("INTERNAL_SYNC_SECRET") ?? "";
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/verify-store-scan-match`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${anonKey}`,
            "x-internal-secret": internalSecret,
          },
          body: JSON.stringify({
            items: verifyItems,
            userId: ownerUserId ?? undefined,
            engineOnly,
            // Always re-evaluate during a fresh scan so we don't carry stale
            // verdicts from earlier engine versions.
            force: true,
          }),
        });
        if (!res.ok) {
          console.warn(`[matchAmazon] verify HTTP ${res.status} engineOnly=${engineOnly}`);
          return {};
        }
        const data = await res.json().catch(() => ({}));
        return (data?.verifications ?? {}) as Record<string, any>;
      } catch (e: any) {
        console.warn(`[matchAmazon] verify exception engineOnly=${engineOnly}: ${e?.message ?? e}`);
        return {};
      }
    };

    const engineVerdicts = await callVerify(true);

    // Collect ASINs the engine left as review_needed → second pass with AI.
    const reviewKeys: { key: string; asin: string; sourceUrl: string }[] = [];
    for (const it of verifyItems) {
      const key = `${normalizeUrlForVerifyKey(it.source_url)}::${it.asin.toUpperCase()}`;
      const v = engineVerdicts[key];
      if (v?.verdict === "likely_match" && (v?.confidence ?? 0) < 75) {
        reviewKeys.push({ key, asin: it.asin, sourceUrl: it.source_url });
      }
    }
    let aiVerdicts: Record<string, any> = {};
    if (reviewKeys.length > 0) {
      // Re-run only the review_needed survivors through the full pipeline
      // (engine + AI fallback). Cap at 8 to control cost.
      const subset = verifyItems.filter((it) =>
        reviewKeys.some((rk) => rk.asin === it.asin),
      ).slice(0, 8);
      if (subset.length > 0) {
        const subsetVerdicts = await (async () => {
          const internalSecret = Deno.env.get("INTERNAL_SYNC_SECRET") ?? "";
          const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
          try {
            const res = await fetch(`${SUPABASE_URL}/functions/v1/verify-store-scan-match`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${anonKey}`,
                "x-internal-secret": internalSecret,
              },
               body: JSON.stringify({ items: subset, userId: ownerUserId ?? undefined, engineOnly: false, force: true }),
            });
            if (!res.ok) return {};
            const d = await res.json().catch(() => ({}));
            return (d?.verifications ?? {}) as Record<string, any>;
          } catch { return {}; }
        })();
        aiVerdicts = subsetVerdicts;
      }
    }

    // Merge verdicts onto each persisted candidate
    for (const c of topPool) {
      if (!c.asin) continue;
      const sourceUrlKey = `supplier://${ownerUserId ?? "anon"}/${encodeURIComponent(sourceTitle).slice(0, 200)}`;
      const k = `${normalizeUrlForVerifyKey(sourceUrlKey)}::${c.asin.toUpperCase()}`;
      const v = aiVerdicts[k] ?? engineVerdicts[k];
      if (!v) continue;
      c.verdict = v.verdict ?? null;
      c.engine_confidence = typeof v.confidence === "number" ? v.confidence : null;
      c.decision_signal = v.decision_signal ?? null;
      c.verdict_reason = typeof v.reason === "string" ? v.reason.slice(0, 240) : null;
      c.verdict_source = v.source === "rule" ? "engine" : v.source === "ai" ? "ai" : "hybrid";
      c.verification_evidence = v.evidence && typeof v.evidence === "object"
        ? v.evidence as Record<string, unknown>
        : null;
    }

    // Pick "accepted" by verdict tier (exact > pack-conv > likely > raw score),
    // not just score — this is the whole point of multi-candidate exploration.
    const tier = (vd?: string | null): number => {
      if (vd === "exact_match") return 4;
      if (vd === "same_base_product_different_pack") return 3;
      if (vd === "likely_match") return 2;
      if (vd === "not_match") return 0;
      return 1; // unclassified / no engine output
    };
    const ranked = [...topPool].sort((a, b) => {
      const t = tier(b.verdict) - tier(a.verdict);
      if (t !== 0) return t;
      const ec = (b.engine_confidence ?? 0) - (a.engine_confidence ?? 0);
      if (ec !== 0) return ec;
      return b.score - a.score;
    });
    acceptedScored = ranked[0] ?? null;
    // Reject if not_match, low score, OR if the engine flagged a product
    // family conflict (e.g. timer vs measuring cup). Family conflicts mean
    // the candidate is the wrong product type entirely — never accept it
    // as the top match even if its title-similarity score is high.
    const hasFamilyConflict = (c: AmzCandidate | null) =>
      !!c && (
        c.verdict === "not_match" ||
        (c.decision_signal === "hard_conflict" && (c.verdict_reason || "").toLowerCase().includes("family"))
      );
    if (acceptedScored && (acceptedScored.verdict === "not_match" || acceptedScored.score < 35 || hasFamilyConflict(acceptedScored))) {
      acceptedScored = null;
    }
  } catch (engineErr: any) {
    console.warn(`[matchAmazon] engine classification failed: ${engineErr?.message ?? engineErr}`);
    // Never force a raw-score fallback here: if verification/classification
    // fails, returning a "best available" candidate recreates the exact bug
    // we're trying to avoid (wrong-family matches when no valid Amazon item
    // was actually confirmed). Surface a true no-match state instead.
    acceptedScored = null;
  }

  const accepted = acceptedScored;
  const best = topPool[0];

  // ── Live ROI: route through the resilient multi-tier helper (calculate-roi
  // → fetch-product-price → buy_box_cache → estimate) so a single SP-API
  // hiccup never leaves the row with ROI=n/a.
  let roi: number | null = null, margin: number | null = null, feesJson: any = null;
  if (accepted?.asin && sourcePrice && sourcePrice > 0) {
    const r = await fetchRoiForAsin(accepted.asin, sourcePrice, ownerUserId);
    if (r.price && r.price > 0) {
      accepted.price = r.price;
      const idx = topPool.findIndex((c) => c.asin === accepted.asin);
      if (idx >= 0) topPool[idx].price = r.price;
      roi = r.roi;
      margin = r.margin;
      feesJson = { totalFees: r.totalFees, source: r.source };
      console.log(`[matchAmazon] roi resolved asin=${accepted.asin} price=$${r.price} roi=${roi}% via=${r.source}`);
    } else {
      console.log(`[matchAmazon] no price/roi for asin=${accepted.asin} after all fallbacks — row will show n/a until refresh`);
    }
  } else if (accepted?.asin && (!sourcePrice || sourcePrice <= 0)) {
    const livePrice = await fetchAsinPrice(accepted.asin);
    if (livePrice && livePrice > 0) {
      accepted.price = livePrice;
      const idx = topPool.findIndex((c) => c.asin === accepted.asin);
      if (idx >= 0) topPool[idx].price = livePrice;
    }
  }

  return {
    asin: accepted?.asin ?? null,
    title: accepted?.title ?? null,
    price: accepted?.price ?? null,
    image: accepted?.image ?? null,
    score: best?.score ?? 0,
    method: accepted
      ? (accepted.verdict ? `engine_${accepted.verdict}` : `spapi_${accepted.confidence}`)
      : (topPool.some((c) => c.verdict === "not_match")
        ? "no_valid_match"
        : "no_verified_match"),
    confidence: best?.confidence ?? "none",
    roi, margin,
    candidates: topPool,
    query: usedQuery,
    feesJson,
  };
}

// Mirror of verify-store-scan-match's normalizeUrl so we can rebuild cache keys.
function normalizeUrlForVerifyKey(raw: string): string {
  if (!raw) return "";
  let v = String(raw).trim().toLowerCase();
  v = v.replace(/#.*$/, "");
  v = v.replace(/^https?:\/\//, "");
  v = v.replace(/^www\./, "");
  v = v.replace(/\?.*$/, "");
  v = v.replace(/\/+$/, "");
  return v;
}

interface StartBody {
  profile_id?: string;
  supplier_domain: string;
  category_urls: string[]; // user-provided category/collection URLs
  max_products?: number;   // user-requested cap, bounded only by a hard safety limit
  category_id?: string;    // optional link to scan_categories so user-facing browse sees results
  mode?: "start" | "process_chunk" | "resume"; // internal orchestration modes
  run_id?: string;          // internal: required when mode = process_chunk
}

// Chunk size for self-recursive processing. Each chunk must complete well within
// the edge function wall-time limit even when sites are slow / anti-bot heavy.
// 8 items × ~15s each ≈ 120s leaves headroom under the ~150s limit.
const CHUNK_SIZE = 8;

// ── Domain-specific throttling profiles ──────────────────────────────
// Walmart and similar high-friction sites apply press-and-hold / fingerprint
// challenges even when we route through a scraping API. We treat them as a
// "slow lane": lower concurrency, smaller chunk size, longer human-like
// jitter delay between requests. Everything else uses the default fast lane.
type ThrottleProfile = {
  concurrency: number;
  chunkSize: number;
  delayMinMs: number;
  delayMaxMs: number;
};
const DEFAULT_THROTTLE: ThrottleProfile = {
  concurrency: 2,
  chunkSize: CHUNK_SIZE,
  delayMinMs: 250,
  delayMaxMs: 450,
};
const SLOW_LANE_DOMAINS = ["walmart.com", "target.com", "homedepot.com", "lowes.com", "bestbuy.com"];
function getThrottleProfile(supplierDomain: string | null | undefined): ThrottleProfile {
  const d = (supplierDomain ?? "").toLowerCase();
  if (SLOW_LANE_DOMAINS.some((dom) => d.includes(dom))) {
    return { concurrency: 2, chunkSize: 6, delayMinMs: 800, delayMaxMs: 1600 };
  }
  return DEFAULT_THROTTLE;
}
function jitterDelay(min: number, max: number): Promise<void> {
  const ms = min + Math.floor(Math.random() * Math.max(1, max - min));
  return new Promise((r) => setTimeout(r, ms));
}

// Detect anti-bot challenge pages from the extractor result. These look like
// "successful" extractions to a naive parser (HTTP 200, some HTML) but contain
// no real product data and usually trigger the "press and hold" UI on Walmart.
function isAntiBotBlocked(r: any): boolean {
  if (!r) return false;
  const fr: string = String(r.final_resolution ?? "").toLowerCase();
  const provider: string = String(r.block_provider ?? "").toLowerCase();
  const accessFailure = fr.startsWith("blocked") || [
    "phase2_timeout",
    "phase2_render_failed",
    "phase2_extract_failed",
    "fetch_error",
  ].includes(fr);

  if (fr === "price_extracted") return false;
  if (accessFailure) return true;
  if (!fr && provider) return true; // legacy extractor responses without final_resolution

  const title: string = String(r.title ?? "").toLowerCase();
  if (/press\s*&?\s*hold|robot|verify\s+you\s+are\s+human|are\s+you\s+a\s+human|access\s+denied|captcha/.test(title)) {
    return true;
  }
  return false;
}
// Lease window for a chunk worker — if it doesn't complete in this window we let
// another invocation pick the same items back up.
const CHUNK_LEASE_SECONDS = 180;

function normDomain(input: string): string {
  return (input || "")
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

function urlDomain(u: string): string | null {
  try { return normDomain(new URL(u).hostname); } catch { return null; }
}

function isBlockedHtml(html: string): boolean {
  const lower = String(html ?? "").toLowerCase();
  return /attention required|cloudflare|captcha|cf-error-details|you were blocked|verify you are human/.test(lower);
}

async function fetchDirectHtml(url: string, timeoutMs = 15000): Promise<{ html: string | null; status: number; via: string }> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ArbiSellerBot/1.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    const html = await res.text().catch(() => "");
    clearTimeout(t);
    if (isBlockedHtml(html)) {
      return { html: null, status: res.status, via: "direct_blocked_cloudflare" };
    }
    if (res.ok && html && html.length > 1000) {
      return { html, status: res.status, via: "direct" };
    }
    return { html: null, status: res.status, via: "direct_err" };
  } catch (_e) {
    return { html: null, status: 0, via: "direct_throw" };
  }
}

async function fetchHtml(url: string, timeoutMs = 15000): Promise<{ html: string | null; status: number; via: string }> {
  const direct = await fetchDirectHtml(url, timeoutMs);
  if (direct.html || direct.via === "direct_blocked_cloudflare") return direct;

  if (!FIRECRAWL_API_KEY) return { html: null, status: direct.status, via: direct.via === "direct_err" ? "no_key" : direct.via };
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["html"],
        onlyMainContent: false,
        waitFor: 1500,
      }),
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const html = data?.data?.html || data?.html || null;
      if (html && !isBlockedHtml(html)) return { html, status: res.status, via: "firecrawl" };
      return { html: null, status: res.status, via: "firecrawl_empty" };
    }
    return { html: null, status: res.status, via: "firecrawl_err" };
  } catch (_e) {
    return { html: null, status: 0, via: "firecrawl_throw" };
  }
}

// Category page fetcher: uses Firecrawl with extended waitFor for JS-rendered grids (Target, Walmart, etc.).
// Falls back to plain fetchHtml if Firecrawl is unavailable.
// NOTE: Firecrawl v2 `actions` schema rejects `{type:"scroll", direction:"down"}` — it requires
// either `selector` or omitted direction, and the API returns 500 for invalid action shapes.
// We rely on a long `waitFor` instead, which works for most lazy-loaded grids.
async function fetchCategoryHtml(url: string): Promise<{ html: string | null; status: number; via: string; links?: string[] }> {
  // 1) Firecrawl with long wait — best for lazy-loaded React grids.
  // Also requesting `links` format gives us a structured anchor list as a robust
  // fallback for sites whose product cards use non-standard markup (e.g. GameStop
  // renders <a> tags inside React components our regex sometimes misses).
  if (FIRECRAWL_API_KEY) {
    try {
      const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          formats: ["html", "links"],
          onlyMainContent: false,
          waitFor: 5000,
        }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        const html = data?.data?.html || data?.html || null;
        const links: string[] = Array.isArray(data?.data?.links)
          ? data.data.links
          : Array.isArray(data?.links) ? data.links : [];
        if (html && html.length > 1500) {
          return { html, status: 200, via: "firecrawl_js", links };
        }
        const fallback = await fetchDirectHtml(url);
        if (fallback.html) return { html: fallback.html, status: fallback.status, via: `${fallback.via}_after_firecrawl_empty`, links };
        if (fallback.via.includes("blocked")) return { ...fallback, links };
        return { html: null, status: 200, via: "firecrawl_empty", links };
      }
      const errBody = await res.text().catch(() => "");
      console.warn(`[store-scan] firecrawl status=${res.status} body=${errBody.slice(0, 200)}`);
      const fallback = await fetchDirectHtml(url);
      if (fallback.html) return { html: fallback.html, status: fallback.status, via: `${fallback.via}_after_firecrawl_${res.status}` };
      if (fallback.via.includes("blocked")) return fallback;
      return { html: null, status: res.status, via: "firecrawl_err" };
    } catch (e) {
      console.warn(`[store-scan] firecrawl threw: ${(e as Error).message}`);
      const fallback = await fetchDirectHtml(url);
      if (fallback.html) return { html: fallback.html, status: fallback.status, via: `${fallback.via}_after_firecrawl_throw` };
      if (fallback.via.includes("blocked")) return fallback;
      return { html: null, status: 0, via: "firecrawl_throw" };
    }
  }

  // 2) Last resort: plain fetch (works for sites without aggressive bot protection)
  return await fetchHtml(url);
}

// Build a paged category URL. Target uses ?Nao=N (offset, increments of 24).
// Most others use page=N. Profile can override with pagination_param + pagination_step.
function buildPagedUrl(baseUrl: string, pageNum: number, supplierDomain: string, profile: any): string {
  if (pageNum <= 1) return baseUrl;
  const sep = baseUrl.includes("?") ? "&" : "?";

  // Target uses Nao offset (0, 24, 48, ...)
  if (supplierDomain.includes("target.com")) {
    const offset = (pageNum - 1) * 24;
    return `${baseUrl}${sep}Nao=${offset}`;
  }

  // Profile-driven (offset or page)
  const param = profile?.pagination_param || "page";
  const step = profile?.pagination_step;
  if (step && Number(step) > 0) {
    const offset = (pageNum - 1) * Number(step);
    return `${baseUrl}${sep}${param}=${offset}`;
  }
  return `${baseUrl}${sep}${param}=${pageNum}`;
}

function estimateProductsPerPage(supplierDomain: string): number {
  if (supplierDomain.includes("target.com")) return 24;
  if (supplierDomain.includes("walmart.com")) return 40;
  if (supplierDomain.includes("bestbuy.com")) return 24;
  if (supplierDomain.includes("homedepot.com")) return 24;
  if (supplierDomain.includes("costco.com")) return 24;
  return 24;
}

function getCategoryCrawlPageBudget(supplierDomain: string, configuredMaxPages: number, maxProducts: number): number {
  const HARD_MAX_PAGES = 100;
  const minimumDepth = supplierDomain.includes("target.com") || supplierDomain.includes("walmart.com") ? 10 : 5;
  const pagesNeededForCap = Math.ceil(maxProducts / Math.max(estimateProductsPerPage(supplierDomain), 1));

  return Math.min(
    HARD_MAX_PAGES,
    Math.max(configuredMaxPages, minimumDepth, pagesNeededForCap),
  );
}

// ─── URL identity helpers (shared discovery logic) ───────────────────────
// Single canonicalizer used everywhere. Bump URL_KEY_VERSION whenever the
// canonicalization rules change so we can detect drift and migrate stored
// keys. The format stored in store_scan_items.url_key is purely the canonical
// string (no version prefix) so equality lookups stay simple, but we log the
// version on every run to aid debugging.
const URL_KEY_VERSION = 2;
const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "ref", "ref_", "tag", "linkCode", "psc", "gclid", "fbclid", "afid",
  "ascsubtag", "source", "lnk", "clkid", "trkid", "preselect",
  "sid", "scid", "sscid", "cm_mmc", "cm_sp", "icid", "intcmp",
  // Additional common drift sources
  "mc_cid", "mc_eid", "mkt_tok", "_branch_match_id", "_ga", "_gl",
  "yclid", "msclkid", "dclid", "igshid", "spm", "pf_rd_p", "pf_rd_r",
  "pd_rd_w", "pd_rd_wg", "pd_rd_r", "pd_rd_i", "th", "qid", "sr",
];
function normalizeUrlKey(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    // 1) Strip known tracking params
    TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));
    // 2) Sort remaining params deterministically (key, then value)
    const entries = [...u.searchParams.entries()].sort(([ak, av], [bk, bv]) => {
      if (ak === bk) return av.localeCompare(bv);
      return ak.localeCompare(bk);
    });
    const search = entries.length > 0
      ? `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`
      : "";
    // 3) Normalize host (lowercase, strip www.) and path (strip trailing slash)
    let path = (u.pathname || "/").replace(/\/+$/g, "");
    if (!path) path = "/";
    const host = u.host.toLowerCase().replace(/^www\./, "");
    return `${host}${path}${search}`;
  } catch {
    // Fallback: lowercase + trim hash + trim trailing slash
    return String(raw ?? "")
      .trim()
      .toLowerCase()
      .replace(/#.*$/, "")
      .replace(/\/+$/g, "");
  }
}

// Extract a stable supplier-side product ID where possible. Used as a
// secondary dedupe key so URL shape changes don't fragment a product.
function extractProductId(absUrl: string, supplierDomain: string): string | null {
  try {
    const u = new URL(absUrl);
    const path = u.pathname;
    // target.com — /p/<slug>/-/A-77586172
    if (supplierDomain.includes("target.com")) {
      const m = path.match(/\/-\/A-(\d+)\b/i);
      if (m) return `target:A-${m[1]}`;
    }
    // walmart.com — /ip/<slug>/<numeric-id>
    if (supplierDomain.includes("walmart.com")) {
      const m = path.match(/\/ip\/[^/]+\/(\d{5,})\b/i);
      if (m) return `walmart:${m[1]}`;
    }
    // bestbuy.com — /site/<slug>/<numeric-id>.p
    if (supplierDomain.includes("bestbuy.com")) {
      const m = path.match(/\/(\d{5,})\.p\b/i);
      if (m) return `bestbuy:${m[1]}`;
    }
    // homedepot.com — /p/<slug>/<numeric-id>
    if (supplierDomain.includes("homedepot.com")) {
      const m = path.match(/\/p\/[^/]+\/(\d{5,})\b/i);
      if (m) return `homedepot:${m[1]}`;
    }
    // costco.com — /<slug>.product.<numeric-id>.html
    if (supplierDomain.includes("costco.com")) {
      const m = path.match(/\.product\.(\d{5,})\.html\b/i);
      if (m) return `costco:${m[1]}`;
    }
    // Generic fallback: last numeric chunk of length >= 5 in the path.
    const generic = path.match(/(\d{6,})(?:\D*)$/);
    if (generic) return `${supplierDomain}:${generic[1]}`;
    return null;
  } catch {
    return null;
  }
}

// Card-level data captured directly from the category page. Even when the
// PDP fetch is later blocked (HTTP 403, anti-bot), these fields keep the row
// usable: matching can still run and the UI never shows an empty card.
export type CategoryCard = {
  url: string;
  url_key: string;
  product_id: string | null;
  card_title: string | null;
  card_image: string | null;
  card_price: number | null;
  card_currency: string | null;
};

// Decode a small set of common HTML entities so card titles read cleanly.
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, code) => {
      try { return String.fromCharCode(parseInt(code, 10)); } catch { return ""; }
    });
}

// Best-effort price parser for a small chunk of HTML (a single product card).
// Looks at common price markup (data-price, $X.YY, currency-prefixed values).
function parseCardPrice(html: string): { price: number | null; currency: string | null } {
  if (!html) return { price: null, currency: null };
  // 1) data-price="12.34" attributes
  const attr = html.match(/data-(?:price|product-price|sale-price)=["']?\s*\$?\s*([\d,.]+)/i);
  if (attr) {
    const n = Number(attr[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return { price: n, currency: "USD" };
  }
  // 2) $12.34 / £12.34 / €12.34 / CA$12.34
  const sym = html.match(/(CA\$|US\$|\$|£|€|¥)\s*([\d]{1,5}(?:[,.\s]\d{3})*(?:[.,]\d{1,2}))/);
  if (sym) {
    const raw = sym[2].replace(/\s/g, "");
    // If both . and , exist, the last one is the decimal sep; strip the other.
    let normalized = raw;
    const lastDot = raw.lastIndexOf(".");
    const lastComma = raw.lastIndexOf(",");
    if (lastDot >= 0 && lastComma >= 0) {
      const decSep = lastDot > lastComma ? "." : ",";
      const thouSep = decSep === "." ? "," : ".";
      normalized = raw.split(thouSep).join("");
      if (decSep === ",") normalized = normalized.replace(",", ".");
    } else if (lastComma >= 0 && lastDot < 0) {
      // Assume comma is decimal if exactly 1-2 digits follow
      const tail = raw.slice(lastComma + 1);
      if (tail.length === 1 || tail.length === 2) normalized = raw.replace(",", ".");
      else normalized = raw.replace(/,/g, "");
    }
    const n = Number(normalized);
    if (Number.isFinite(n) && n > 0) {
      const sigil = sym[1];
      const currency = sigil === "£" ? "GBP" : sigil === "€" ? "EUR" : sigil === "¥" ? "JPY" : sigil === "CA$" ? "CAD" : "USD";
      return { price: n, currency };
    }
  }
  return { price: null, currency: null };
}

// Pick a usable image URL from a card chunk. Prefers explicit data-src /
// data-original (lazy-loaded grids) before falling back to the literal src.
function parseCardImage(html: string, baseUrl: string): string | null {
  if (!html) return null;
  const candidates: string[] = [];
  const dataSrc = html.match(/<img[^>]+(?:data-src|data-original|data-lazy-src|data-srcset|data-image)=["']([^"']+)["']/i);
  if (dataSrc) candidates.push(dataSrc[1].split(/\s+/)[0]);
  const src = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (src) candidates.push(src[1].split(/\s+/)[0]);
  for (const raw of candidates) {
    if (!raw) continue;
    if (raw.startsWith("data:")) continue;
    try { return new URL(raw, baseUrl).toString(); } catch { /* skip */ }
  }
  return null;
}

// Extract a card-level title near the product link. Tries common alt text,
// aria-label, title attribute, or the first heading inside the card chunk.
function parseCardTitle(html: string): string | null {
  if (!html) return null;
  const aria = html.match(/aria-label=["']([^"']{6,200})["']/i);
  if (aria) return decodeEntities(aria[1]).trim();
  const title = html.match(/title=["']([^"']{6,200})["']/i);
  if (title) return decodeEntities(title[1]).trim();
  const alt = html.match(/<img[^>]+alt=["']([^"']{6,200})["']/i);
  if (alt) return decodeEntities(alt[1]).trim();
  const heading = html.match(/<h[1-4][^>]*>([\s\S]{4,200}?)<\/h[1-4]>/i);
  if (heading) return decodeEntities(heading[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
  return null;
}

// Find a chunk of HTML around the anchor href so we can pull image/title/price
// from the surrounding card. We grab a window of ~1500 chars on each side —
// enough for most card layouts without ballooning regex work.
function getCardWindow(html: string, hrefMatchIndex: number): string {
  const start = Math.max(0, hrefMatchIndex - 1500);
  const end = Math.min(html.length, hrefMatchIndex + 1500);
  return html.slice(start, end);
}

// Extract product links + card data from a category page. Returns canonical
// url_key (not raw URL) and any title/image/price we could harvest from the
// card markup. Dedupe on (productId || url_key) so /p/...-A-12345 and
// /p/...-A-12345?ref=foo collapse.
//
// The card data is the listing-level fallback referenced by the chunk worker:
// when the PDP fetch is blocked, these fields keep the row usable end-to-end
// (Amazon match, ROI, UI display) instead of leaving an empty "skipped" row.
function collectProductUrls(html: string, baseUrl: string, supplierDomain: string, extraLinks: string[] = []): CategoryCard[] {
  const seenKeys = new Set<string>();
  const out: CategoryCard[] = [];

  const finalize = (abs: string, cardHtml: string | null) => {
    try {
      const dom = urlDomain(abs);
      if (!dom || !dom.endsWith(supplierDomain)) return;
      if (!(/\/(p|ip|dp|product|products|item)\//i.test(abs) || /-\d{5,}\b/.test(abs) || /\/\d{5,}\.html?\b/i.test(abs))) return;
      const url_key = normalizeUrlKey(abs);
      const product_id = extractProductId(abs, supplierDomain);
      const dedupeKey = product_id ?? url_key;
      if (seenKeys.has(dedupeKey)) return;
      seenKeys.add(dedupeKey);

      let card_title: string | null = null;
      let card_image: string | null = null;
      let card_price: number | null = null;
      let card_currency: string | null = null;
      if (cardHtml) {
        card_title = parseCardTitle(cardHtml);
        card_image = parseCardImage(cardHtml, baseUrl);
        const priceParsed = parseCardPrice(cardHtml);
        card_price = priceParsed.price;
        card_currency = priceParsed.currency;
      }

      out.push({
        url: abs.split("#")[0],
        url_key,
        product_id,
        card_title,
        card_image,
        card_price,
        card_currency,
      });
    } catch { /* skip */ }
  };

  // Pass 1: regex over <a href="..."> with surrounding card window so we can
  // extract title/image/price from the card markup.
  const linkRe = /<a[^>]+href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1];
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
    let abs: string;
    try { abs = new URL(href, baseUrl).toString(); } catch { continue; }
    const cardHtml = getCardWindow(html, m.index);
    finalize(abs, cardHtml);
  }

  // Pass 2: hrefs Firecrawl gave us as a structured list — no surrounding
  // card markup, so card fields stay null. Still useful to capture the URL
  // (the carry-over / chunk worker may recover data from a previous run).
  for (const href of extraLinks) {
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
    let abs: string;
    try { abs = new URL(href, baseUrl).toString(); } catch { continue; }
    finalize(abs, null);
  }

  return out;
}

function isMissingOnConflictConstraintError(error: unknown): boolean {
  const message = String((error as { message?: string } | null)?.message ?? "");
  return /no unique or exclusion constraint matching the ON CONFLICT specification/i.test(message);
}

async function persistScanQueueRowsByKey(
  sb: ReturnType<typeof createClient>,
  runId: string,
  rows: Record<string, any>[],
  keyField: "url_key" | "source_url",
): Promise<string | null> {
  if (rows.length === 0) return null;

  const conflictTarget = keyField === "url_key" ? "run_id,url_key" : "run_id,source_url";
  const { error: upErr } = await sb
    .from("store_scan_items")
    .upsert(rows, { onConflict: conflictTarget, ignoreDuplicates: false });

  if (!upErr) return null;
  if (!isMissingOnConflictConstraintError(upErr)) return upErr.message;

  console.warn(
    `[store-scan ${runId}] ${keyField} upsert conflict target unavailable — falling back to select+update/insert`
  );

  const keyValues = Array.from(new Set(
    rows
      .map((row) => String(row[keyField] ?? "").trim())
      .filter(Boolean)
  ));
  if (keyValues.length === 0) return null;

  const { data: existingRows, error: existingErr } = await sb
    .from("store_scan_items")
    .select(`id, ${keyField}`)
    .eq("run_id", runId)
    .in(keyField, keyValues);
  if (existingErr) return existingErr.message;

  const existingIdByKey = new Map<string, string>();
  for (const existing of existingRows ?? []) {
    const key = String((existing as Record<string, any>)[keyField] ?? "").trim();
    const id = String((existing as { id?: string } | null)?.id ?? "").trim();
    if (key && id && !existingIdByKey.has(key)) existingIdByKey.set(key, id);
  }

  const toInsert: Record<string, any>[] = [];
  const toUpdate: Array<{ id: string; payload: Record<string, any> }> = [];
  for (const row of rows) {
    const key = String(row[keyField] ?? "").trim();
    const existingId = existingIdByKey.get(key);
    if (existingId) {
      toUpdate.push({ id: existingId, payload: row });
    } else {
      toInsert.push(row);
    }
  }

  if (toInsert.length > 0) {
    const { error: insertErr } = await sb.from("store_scan_items").insert(toInsert);
    if (insertErr) return insertErr.message;
  }

  for (const row of toUpdate) {
    const { error: updateErr } = await sb
      .from("store_scan_items")
      .update(row.payload)
      .eq("id", row.id);
    if (updateErr) return updateErr.message;
  }

  return null;
}

async function extractProduct(productUrl: string, userId: string, userAuthHeader: string): Promise<any> {
  // Reuse existing extractor using the caller's user JWT so auth/RLS matches normal UI behavior.
  // Retry on Supabase function-to-function rate limits (429 + "Rate limit exceeded ... Retry after Nms")
  // so we don't surface them as worker exceptions.
  const MAX_ATTEMPTS = 4;
  let lastErr: any = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/extract-product-price`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": userAuthHeader,
          "x-internal-secret": INTERNAL_SYNC_SECRET,
        },
        body: JSON.stringify({ url: productUrl, user_id: userId, force: true }),
      });

      if (res.status === 429) {
        const text = await res.text().catch(() => "");
        const m = text.match(/Retry after (\d+)ms/i);
        // Cap retry wait so a single URL can't stall the whole run
        const waitMs = Math.min(m ? parseInt(m[1], 10) : 2000 * attempt, 8000);
        console.warn(`[extractProduct] 429 rate-limit on attempt ${attempt}/${MAX_ATTEMPTS}, waiting ${waitMs}ms — ${productUrl.slice(0, 100)}`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { error: `extractor_${res.status}`, error_detail: text.slice(0, 200) };
      }
      return await res.json();
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      // Supabase internal rate-limit surfaces as a thrown error with this exact phrasing
      if (/rate limit exceeded/i.test(msg)) {
        const m = msg.match(/Retry after (\d+)ms/i);
        const waitMs = Math.min(m ? parseInt(m[1], 10) : 2000 * attempt, 8000);
        console.warn(`[extractProduct] thrown rate-limit on attempt ${attempt}/${MAX_ATTEMPTS}, waiting ${waitMs}ms`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      // Non-rate-limit network error — surface as a clean extractor_network reason instead of throwing
      return { error: `extractor_network`, error_detail: msg.slice(0, 200) };
    }
  }
  // Exhausted retries — return a structured error instead of throwing so it lands as a clean status
  return { error: `extractor_rate_limited`, error_detail: String(lastErr?.message ?? lastErr ?? "rate_limited") };
}

// ─────────────────────────────────────────────────────────────────────
// Chunked self-recursive pipeline
//
// Phase 1 (crawl):  fetch category pages → collect product URLs → insert as
//                   `pending` rows in store_scan_items → trigger first chunk.
// Phase 2 (chunk):  claim CHUNK_SIZE pending rows for this run, process them,
//                   then self-invoke for the next chunk. When no pending rows
//                   remain, mark the run done and aggregate counters.
//
// Why: a single edge function invocation cannot reliably process 100+ items
// when sites like Walmart hit each item with a 10–30 s anti-bot delay; we
// were timing out around the 22nd item. Chunking + self-recursion keeps every
// invocation safely under the wall-clock limit while preserving progress.
// ─────────────────────────────────────────────────────────────────────

async function runCrawlPhase(
  sb: ReturnType<typeof createClient>,
  runId: string,
  userId: string,
  userAuthHeader: string,
  supplierDomain: string,
  categoryUrls: string[],
  maxProducts: number,
  maxPages: number,
  profile: any,
) {
  console.log(`[store-scan ${runId}] crawl-phase start: domain=${supplierDomain} urls=${categoryUrls.length} cap=${maxProducts}`);
  try {
    // ── Crawl ──
    // Map keyed by dedupe key (product_id || url_key) so the same product
    // never enters the queue twice across multiple pages or category URLs.
    const productMap = new Map<string, CategoryCard>();
    let pagesCrawled = 0;
    const crawlErrors: string[] = [];
    const maxPagesPerCategory = getCategoryCrawlPageBudget(supplierDomain, maxPages, maxProducts);

    // Streaming state — products that have been discovered but not yet flushed
    // to store_scan_items. We flush after every page so the UI starts showing
    // results almost immediately instead of waiting for the entire crawl.
    const pendingFlush: CategoryCard[] = [];
    let totalDiscoveredFlushed = 0;
    let totalNewFlushed = 0;
    let firstChunkKicked = false;

    // Pre-load this user's known url_keys/product_ids so each page-flush can
    // decide is_new without an extra round-trip per page. We also cache the
    // FULL prior row for each known key so we can carry data forward without
    // re-extracting on rescans of the same category.
    //
    // Lookup priority:
    //   1) category_id (strongest — same admin-managed category)
    //   2) supplier_domain LIKE on source_url (legacy fallback)
    //
    // We keep the most recent matched row per (url_key | product_id).
    const knownUrlKeys = new Set<string>();
    const knownProductIds = new Set<string>();
    type PriorRow = {
      url_key: string | null;
      product_id: string | null;
      source_url: string | null;
      source_title: string | null;
      source_price: number | null;
      source_image_url: string | null;
      source_currency: string | null;
      source_brand: string | null;
      source_upc: string | null;
      source_availability: string | null;
      source_availability_status: string | null;
      matched_asin: string | null;
      amz_title: string | null;
      amz_price: number | null;
      amz_image_url: string | null;
      amz_candidates: any;
      match_score: number | null;
      match_method: string | null;
      match_confidence: string | null;
      normalized_query: string | null;
      roi: number | null;
      margin_pct: number | null;
      fees_json: any;
      status: string | null;
      created_at: string;
    };
    const priorByKey = new Map<string, PriorRow>();
    const rememberPrior = (r: PriorRow) => {
      const keys: string[] = [];
      if (r.url_key) keys.push(`k:${r.url_key}`);
      if (r.product_id) keys.push(`p:${r.product_id}`);
      for (const k of keys) {
        const existing = priorByKey.get(k);
        // Prefer most recently created row, with matched rows winning ties.
        if (!existing) { priorByKey.set(k, r); continue; }
        const existingTs = Date.parse(existing.created_at) || 0;
        const candidateTs = Date.parse(r.created_at) || 0;
        const existingMatched = !!existing.matched_asin;
        const candidateMatched = !!r.matched_asin;
        if (candidateMatched && !existingMatched) priorByKey.set(k, r);
        else if (candidateMatched === existingMatched && candidateTs > existingTs) priorByKey.set(k, r);
      }
      if (r.url_key) knownUrlKeys.add(r.url_key);
      if (r.product_id) knownProductIds.add(r.product_id);
    };
    try {
      const PRIOR_SELECT = "url_key, product_id, source_url, source_title, source_price, source_image_url, source_currency, source_brand, source_upc, source_availability, source_availability_status, matched_asin, amz_title, amz_price, amz_image_url, amz_candidates, match_score, match_method, match_confidence, normalized_query, roi, margin_pct, fees_json, status, created_at";
      // Look up this run's category_id (if any) so we can prefer items from
      // prior runs of the SAME admin-managed category over a domain-wide scan.
      const { data: thisRun } = await sb
        .from("store_scan_runs")
        .select("category_id")
        .eq("id", runId)
        .maybeSingle();
      const categoryId = (thisRun as { category_id?: string | null } | null)?.category_id ?? null;
      // Strongest scope: items belonging to runs of the same category_id.
      let loadedFromCategory = 0;
      if (categoryId) {
        const { data: catRunIds } = await sb
          .from("store_scan_runs")
          .select("id")
          .eq("user_id", userId)
          .eq("category_id", categoryId)
          .neq("id", runId)
          .order("created_at", { ascending: false })
          .limit(20);
        const runIds = (catRunIds ?? []).map((r: any) => r.id).filter(Boolean);
        if (runIds.length > 0) {
          const { data: catRows } = await sb
            .from("store_scan_items")
            .select(PRIOR_SELECT)
            .eq("user_id", userId)
            .in("run_id", runIds)
            .limit(10000);
          (catRows ?? []).forEach((r: any) => rememberPrior(r as PriorRow));
          loadedFromCategory = (catRows ?? []).length;
        }
      }
      // Fallback / supplement: supplier-domain match for any rows the
      // category-scoped query missed (or runs created before category_id
      // existed). Skipped if we already loaded a healthy prior set.
      if (loadedFromCategory < 50) {
        const { data: priorRows } = await sb
          .from("store_scan_items")
          .select(PRIOR_SELECT)
          .eq("user_id", userId)
          .like("source_url", `%${supplierDomain}%`)
          .order("created_at", { ascending: false })
          .limit(5000);
        (priorRows ?? []).forEach((r: any) => rememberPrior(r as PriorRow));
      }
      console.log(`[store-scan ${runId}] preloaded ${knownUrlKeys.size} url_keys + ${knownProductIds.size} product_ids (category_rows=${loadedFromCategory}, url_key_v=${URL_KEY_VERSION}) for is_new diff`);
    } catch (e: any) {
      console.warn(`[store-scan ${runId}] is_new prefetch failed (will fallback per page):`, e?.message ?? e);
    }

    const flushPendingPage = async () => {
      if (pendingFlush.length === 0) return;
      const slice = pendingFlush.splice(0, pendingFlush.length);

      // Catch any url_keys/product_ids the prefetch missed (>5000 prior rows).
      const unknownUrlKeys = slice.map((c) => c.url_key).filter((k) => !knownUrlKeys.has(k));
      const unknownProductIds = slice
        .map((c) => c.product_id)
        .filter((x): x is string => !!x && !knownProductIds.has(x));
      if (unknownUrlKeys.length > 0) {
        const PRIOR_SELECT = "url_key, product_id, source_url, source_title, source_price, source_image_url, source_currency, source_brand, source_upc, source_availability, source_availability_status, matched_asin, amz_title, amz_price, amz_image_url, amz_candidates, match_score, match_method, match_confidence, normalized_query, roi, margin_pct, fees_json, status, created_at";
        const { data } = await sb
          .from("store_scan_items")
          .select(PRIOR_SELECT)
          .eq("user_id", userId)
          .in("url_key", unknownUrlKeys);
        (data ?? []).forEach((r: any) => rememberPrior(r as PriorRow));
      }
      if (unknownProductIds.length > 0) {
        const PRIOR_SELECT = "url_key, product_id, source_url, source_title, source_price, source_image_url, source_currency, source_brand, source_upc, source_availability, source_availability_status, matched_asin, amz_title, amz_price, amz_image_url, amz_candidates, match_score, match_method, match_confidence, normalized_query, roi, margin_pct, fees_json, status, created_at";
        const { data } = await sb
          .from("store_scan_items")
          .select(PRIOR_SELECT)
          .eq("user_id", userId)
          .in("product_id", unknownProductIds);
        (data ?? []).forEach((r: any) => rememberPrior(r as PriorRow));
      }

      let pageNew = 0;
      const allRows = slice.map((c) => {
        const priorByUrlKey = priorByKey.get(`k:${c.url_key}`);
        const priorByProductId = c.product_id ? priorByKey.get(`p:${c.product_id}`) : undefined;
        const prior = priorByUrlKey ?? priorByProductId ?? null;
        const isKnown = !!prior;
        const is_new = !isKnown;
        if (is_new) pageNew++;
        // Mark this card as known so future pages in the same run dedupe correctly.
        knownUrlKeys.add(c.url_key);
        if (c.product_id) knownProductIds.add(c.product_id);

        // CARRY-OVER: for known items, copy the prior matched/extracted state
        // forward into this run's row so the admin UI does not see a blank
        // reset. The chunk worker may still re-extract / re-match later, but
        // the row is never empty between crawl and chunk completion.
        const carry = prior && prior.matched_asin ? {
          status: "matched",
          source_title: prior.source_title,
          source_price: prior.source_price,
          source_image_url: prior.source_image_url,
          source_currency: prior.source_currency,
          source_brand: prior.source_brand,
          source_upc: prior.source_upc,
          source_availability: prior.source_availability,
          source_availability_status: prior.source_availability_status ?? "unknown",
          matched_asin: prior.matched_asin,
          amz_title: prior.amz_title,
          amz_price: prior.amz_price,
          amz_image_url: prior.amz_image_url,
          amz_candidates: prior.amz_candidates,
          match_score: prior.match_score,
          match_method: prior.match_method ?? "carried_over",
          match_confidence: prior.match_confidence,
          normalized_query: prior.normalized_query,
          roi: prior.roi,
          margin_pct: prior.margin_pct,
          fees_json: prior.fees_json,
        } : prior ? {
          // Prior existed but was never matched — keep its extracted source
          // fields so the rescan does not show an empty row.
          status: prior.status ?? "pending",
          source_title: prior.source_title,
          source_price: prior.source_price,
          source_image_url: prior.source_image_url,
          source_currency: prior.source_currency,
          source_brand: prior.source_brand,
          source_upc: prior.source_upc,
          source_availability: prior.source_availability,
          source_availability_status: prior.source_availability_status ?? "unknown",
        } : { status: "pending" };

        // CARD-LEVEL SEED: even with no prior row, capture title/image/price
        // harvested directly from the category page card. This is the listing
        // fallback's primary source — when the PDP fetch is later blocked
        // (HTTP 403, anti-bot), the row already has enough data to attempt
        // an Amazon match and never appears as an empty "skipped" row.
        const cardSeed: Record<string, any> = {};
        if (c.card_title && !((carry as any).source_title)) cardSeed.source_title = c.card_title;
        if (c.card_image && !((carry as any).source_image_url)) cardSeed.source_image_url = c.card_image;
        if (typeof c.card_price === "number" && c.card_price > 0 && !((carry as any).source_price)) {
          cardSeed.source_price = c.card_price;
        }
        if (c.card_currency && !((carry as any).source_currency)) cardSeed.source_currency = c.card_currency;

        return {
          run_id: runId,
          user_id: userId,
          source_url: c.url,
          url_key: c.url_key,
          product_id: c.product_id,
          is_new,
          match_method: carry.status === "matched" ? (carry as any).match_method ?? "carried_over" : "queued",
          // DB column source_availability_status is NOT NULL with default 'unknown'.
          // For brand-new rows (no prior), the carry object doesn't set it, so we
          // explicitly default here. The ...carry spread below will override when
          // prior data exists.
          source_availability_status: "unknown",
          // Stamp created_at = now() on every crawl-phase write. With upsert,
          // this updates touched rows so the finalizeRun cleanup (which deletes
          // rows with created_at < startedAt) only removes products the rescan
          // never re-encountered (true removals).
          created_at: new Date().toISOString(),
          ...carry,
          ...cardSeed,
        };
      });

      // ── DEDUPE WITHIN BATCH ─────────────────────────────────────────
      // A single category page can surface the same product twice (variant
      // tiles, sponsored re-listings). Collapse to one row per url_key so
      // the upsert below doesn't conflict against itself in the same batch.
      const seenKeys = new Set<string>();
      const rows: any[] = [];
      for (const r of allRows) {
        const dedupKey = r.url_key ? `k:${r.url_key}` : `u:${r.source_url}`;
        if (seenKeys.has(dedupKey)) continue;
        seenKeys.add(dedupKey);
        rows.push(r);
      }

      // ── UPSERT (not insert) ────────────────────────────────────────
      // Recycled runs re-crawl the same category, so the same (run_id,
      // url_key) tuple may already exist from the previous scan. Use the
      // partial unique indexes uq_store_scan_items_run_urlkey and
      // uq_store_scan_items_run_sourceurl so the row is updated in place
      // instead of duplicated. Split rows into the two conflict groups so
      // each upsert hits exactly one unique index.
      const rowsWithUrlKey = rows.filter((r) => !!r.url_key);
      const rowsWithoutUrlKey = rows.filter((r) => !r.url_key);

      if (rowsWithUrlKey.length > 0) {
        const upErr = await persistScanQueueRowsByKey(sb, runId, rowsWithUrlKey, "url_key");
        if (upErr) {
          console.warn(`[store-scan ${runId}] streaming upsert error (url_key):`, upErr);
          return;
        }
      }
      if (rowsWithoutUrlKey.length > 0) {
        const upErr2 = await persistScanQueueRowsByKey(sb, runId, rowsWithoutUrlKey, "source_url");
        if (upErr2) {
          console.warn(`[store-scan ${runId}] streaming upsert error (source_url):`, upErr2);
          return;
        }
      }
      totalDiscoveredFlushed += rows.length;
      totalNewFlushed += pageNew;

      // Update run-level progress counters so the UI sees movement immediately.
      await sb.from("store_scan_runs").update({
        pages_crawled: pagesCrawled,
        products_found: totalDiscoveredFlushed,
        products_new: totalNewFlushed,
        status: "crawling",
      }).eq("id", runId);

      // Kick the first chunk worker as soon as we have something to process —
      // matching/extraction now runs in parallel with the remaining crawl.
      if (!firstChunkKicked && totalDiscoveredFlushed > 0) {
        firstChunkKicked = true;
        triggerNextChunk(runId, userAuthHeader).catch((err) =>
          console.warn(`[store-scan ${runId}] early chunk kick failed:`, err?.message ?? err)
        );
      }
    };

    for (const catUrl of categoryUrls) {
      const dom = urlDomain(catUrl);
      if (!dom || !dom.endsWith(supplierDomain)) {
        crawlErrors.push(`bad_domain:${catUrl}`);
        continue;
      }
      const productsPerPage = estimateProductsPerPage(supplierDomain);
      const pagesForThisCat = maxPagesPerCategory;
      let consecutiveNoNewPages = 0;
      let consecutiveFetchFailures = 0;
      const MAX_CONSECUTIVE_FETCH_FAILURES = 3;
      console.log(`[store-scan ${runId}] cat=${catUrl} planned_pages=${pagesForThisCat} (est=${productsPerPage}/page, configured_max=${maxPages})`);
      for (let p = 1; p <= pagesForThisCat; p++) {
        if (productMap.size >= maxProducts) break;
        const pagedUrl = buildPagedUrl(catUrl, p, supplierDomain, profile);
        const { html, status, via, links: fcLinks } = await fetchCategoryHtml(pagedUrl);
        pagesCrawled++;
        console.log(`[store-scan ${runId}] page ${p}/${pagesForThisCat} url=${pagedUrl} via=${via} status=${status} html_len=${html?.length ?? 0} fc_links=${fcLinks?.length ?? 0}`);
        if (!html) {
          crawlErrors.push(`fetch_${via}_${status}`);
          if (via.includes("blocked")) {
            console.warn(`[store-scan ${runId}] blocking challenge detected on ${pagedUrl} via=${via} status=${status} — aborting category`);
            break;
          }
          consecutiveFetchFailures += 1;
          if (consecutiveFetchFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) {
            console.warn(`[store-scan ${runId}] FAIL-FAST: ${consecutiveFetchFailures} consecutive fetch failures (last via=${via} status=${status}) — aborting category`);
            break;
          }
          continue;
        }
        consecutiveFetchFailures = 0;
        const cards = collectProductUrls(html, pagedUrl, supplierDomain, fcLinks ?? []);
        const beforeCount = productMap.size;
        for (const c of cards) {
          if (productMap.size >= maxProducts) break;
          const key = c.product_id ?? c.url_key;
          if (!productMap.has(key)) {
            productMap.set(key, c);
            pendingFlush.push(c);
          }
        }
        const newOnThisPage = productMap.size - beforeCount;
        console.log(`[store-scan ${runId}] page ${p} collected ${cards.length} cards (${newOnThisPage} unique-new, total ${productMap.size}/${maxProducts})`);

        // Stream the page's discoveries to the DB so the UI updates now.
        await flushPendingPage();

        if (cards.length === 0) {
          console.log(`[store-scan ${runId}] page ${p} returned 0 product links — stopping pagination for this category`);
          break;
        }

        if (newOnThisPage === 0) {
          consecutiveNoNewPages += 1;
          if (consecutiveNoNewPages >= 2) {
            console.log(`[store-scan ${runId}] page ${p} produced 0 new products for ${consecutiveNoNewPages} consecutive pages — stopping pagination for this category`);
            break;
          }
          continue;
        }

        consecutiveNoNewPages = 0;
      }
      if (productMap.size >= maxProducts) break;
    }

    // Final flush in case anything was left after the last loop iteration.
    await flushPendingPage();

    if (productMap.size === 0) {
      const failureCounts = crawlErrors.reduce<Record<string, number>>((a, k) => { a[k] = (a[k] ?? 0) + 1; return a; }, {});
      await sb.from("store_scan_runs").update({
        status: crawlErrors.length > 0 ? "error" : "done",
        pages_crawled: pagesCrawled,
        products_found: 0,
        products_failed: crawlErrors.length,
        completed_at: new Date().toISOString(),
        error_message: crawlErrors.length > 0
          ? `Crawl yielded 0 products. ${crawlErrors.length} fetch failure(s). Top reasons: ${Object.entries(failureCounts).slice(0, 3).map(([k, v]) => `${k}×${v}`).join(", ")}`
          : null,
        failure_reasons: crawlErrors.length > 0 ? failureCounts : { crawl_empty: 1 },
      }).eq("id", runId);
      console.log(`[store-scan ${runId}] done — no products found (${crawlErrors.length} fetch failures)`);
      return;
    }

    await sb.from("store_scan_runs").update({
      pages_crawled: pagesCrawled,
      products_found: totalDiscoveredFlushed,
      products_new: totalNewFlushed,
      status: "extracting",
      error_message: null,
    }).eq("id", runId);
    console.log(`[store-scan ${runId}] crawl-phase done — total queued ${totalDiscoveredFlushed} URLs (${totalNewFlushed} new), kicking next chunk`);

    // Hand off to the first chunk worker (fire-and-forget self-invoke).
    await triggerNextChunk(runId, userAuthHeader);
  } catch (e: any) {
    console.error(`[store-scan ${runId}] crawl-phase crashed:`, e?.message ?? e);
    await sb.from("store_scan_runs").update({
      status: "error",
      error_message: String(e?.message ?? e).slice(0, 500),
      completed_at: new Date().toISOString(),
    }).eq("id", runId);
  }
}

async function triggerNextChunk(runId: string, userAuthHeader: string): Promise<boolean> {
  const url = `${SUPABASE_URL}/functions/v1/store-scan-run`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": userAuthHeader,
          "x-internal-secret": INTERNAL_SYNC_SECRET,
        },
        body: JSON.stringify({ mode: "process_chunk", run_id: runId }),
      });

      if (resp.ok) {
        console.log(`[store-scan ${runId}] next-chunk trigger accepted status=${resp.status} attempt=${attempt}`);
        return true;
      }

      const text = await resp.text().catch(() => "");
      console.warn(`[store-scan ${runId}] next-chunk trigger failed status=${resp.status} attempt=${attempt} body=${text.slice(0, 200)}`);
    } catch (e: any) {
      console.warn(`[store-scan ${runId}] triggerNextChunk attempt ${attempt} threw:`, e?.message ?? e);
    }

    await new Promise((r) => setTimeout(r, attempt * 500));
  }

  return false;
}

function isMissingLeaseColumnError(error: unknown): boolean {
  const message = String((error as { message?: string } | null)?.message ?? "");
  return /chunk_lease_until/i.test(message) && /does not exist/i.test(message);
}

async function runChunkPhase(
  sb: ReturnType<typeof createClient>,
  runId: string,
  userAuthHeader: string,
) {
  // Hard wrap so a thrown error never silently kills the chunk loop.
  // On crash we reset stuck "processing" items + clear the lease + re-trigger.
  try {
    return await runChunkPhaseInner(sb, runId, userAuthHeader);
  } catch (err: any) {
    console.error(`[store-scan ${runId}] runChunkPhase CRASHED — auto-recovering:`, err?.message ?? err, err?.stack ?? "");
    try {
      await sb.from("store_scan_items")
        .update({ status: "pending", error: `chunk_crash: ${String(err?.message ?? err).slice(0, 200)}` })
        .eq("run_id", runId)
        .eq("status", "processing");
      await sb.from("store_scan_runs")
        .update({ chunk_lease_until: null })
        .eq("id", runId);
    } catch (cleanupErr: any) {
      console.warn(`[store-scan ${runId}] post-crash cleanup failed:`, cleanupErr?.message ?? cleanupErr);
    }
    // Re-trigger so the run keeps making progress
    await triggerNextChunk(runId, userAuthHeader).catch(() => {});
  }
}

async function runChunkPhaseInner(
  sb: ReturnType<typeof createClient>,
  runId: string,
  userAuthHeader: string,
) {
  const { data: runRow, error: runRowErr } = await sb
    .from("store_scan_runs")
    .select("id, user_id, status, supplier_domain, started_at")
    .eq("id", runId)
    .maybeSingle();

  if (runRowErr) {
    console.warn(`[store-scan ${runId}] failed to read run row:`, runRowErr.message);
    return;
  }
  if (!runRow) {
    console.warn(`[store-scan ${runId}] run row not found`);
    return;
  }
  if (runRow.status === "done" || runRow.status === "error") {
    console.log(`[store-scan ${runId}] run already terminal (${runRow.status}) — skipping`);
    return;
  }

  let leaseSupported = true;
  let leasedUserId = runRow.user_id as string;

  // Lease the run so two chunk workers don't claim overlapping items.
  const leaseUntil = new Date(Date.now() + CHUNK_LEASE_SECONDS * 1000).toISOString();
  const nowIso = new Date().toISOString();
  const { data: leased, error: leaseErr } = await sb
    .from("store_scan_runs")
    .update({ chunk_lease_until: leaseUntil })
    .eq("id", runId)
    .or(`chunk_lease_until.is.null,chunk_lease_until.lt.${nowIso}`)
    .select("id, user_id, status")
    .maybeSingle();

  if (leaseErr) {
    if (isMissingLeaseColumnError(leaseErr)) {
      leaseSupported = false;
      console.warn(`[store-scan ${runId}] lease column unavailable — continuing without run lease fallback`);
    } else {
      console.warn(`[store-scan ${runId}] lease error:`, leaseErr.message);
      return;
    }
  } else if (!leased) {
    console.log(`[store-scan ${runId}] another worker holds the lease — skipping`);
    return;
  } else if (leased.status === "done" || leased.status === "error") {
    console.log(`[store-scan ${runId}] run already terminal (${leased.status}) — skipping`);
    return;
  } else {
    leasedUserId = leased.user_id as string;
  }

  // Look up the supplier domain so we can pick a throttle profile (slow lane
  // for Walmart-class sites, fast lane for everything else).
  const throttle = getThrottleProfile(runRow?.supplier_domain as string | null);

  // Claim a chunk of pending items sized by the throttle profile.
  const { data: candidateRows, error: pendErr } = await sb
    .from("store_scan_items")
    .select("id")
    .eq("run_id", runId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(throttle.chunkSize);

  if (pendErr) {
    console.error(`[store-scan ${runId}] chunk fetch error:`, pendErr.message);
    if (leaseSupported) {
      await sb.from("store_scan_runs").update({ chunk_lease_until: null }).eq("id", runId);
    }
    return;
  }

  if (!candidateRows || candidateRows.length === 0) {
    // No more pending items — finalize the run by aggregating counters from items.
    await finalizeRun(sb, runId, leaseSupported);
    return;
  }

  const { data: pendingRows, error: claimErr } = await sb
    .from("store_scan_items")
    .update({ status: "processing" })
    .eq("run_id", runId)
    .eq("status", "pending")
    .in("id", candidateRows.map((row: any) => row.id))
    .select("id, source_url, url_key, product_id, source_title, source_price, source_image_url, source_currency");

  if (claimErr) {
    console.error(`[store-scan ${runId}] chunk claim error:`, claimErr.message);
    if (leaseSupported) {
      await sb.from("store_scan_runs").update({ chunk_lease_until: null }).eq("id", runId);
    }
    return;
  }

  if (!pendingRows || pendingRows.length === 0) {
    console.log(`[store-scan ${runId}] chunk claim raced with another worker — retrying`);
    if (leaseSupported) {
      await sb.from("store_scan_runs").update({ chunk_lease_until: null }).eq("id", runId);
    }
    await triggerNextChunk(runId, userAuthHeader);
    return;
  }

  console.log(
    `[store-scan ${runId}] processing chunk of ${pendingRows.length} items ` +
    `(domain=${runRow?.supplier_domain ?? "?"} concurrency=${throttle.concurrency} ` +
    `delay=${throttle.delayMinMs}-${throttle.delayMaxMs}ms)`
  );

  // ── Listing-data fallback cache ───────────────────────────────────────
  // Two-tier fallback so a blocked PDP fetch never produces an empty row:
  //   Tier A — row-level seed: title/image/price written during crawl from
  //            the category card markup (collectProductUrls). This is the
  //            primary source — works on the very first scan, no prior data
  //            required.
  //   Tier B — category_products table: data written by category-diff-scan
  //            (admin-managed category discovery). Acts as a backup when
  //            crawl-time card parsing missed (anchor-only sites, Firecrawl
  //            `links` pass).
  // Both get merged into listingFallbackByUrl. When the PDP extractor is
  // blocked (HTTP 403, anti-bot), we hydrate from this map so the matching
  // pipeline can still find an Amazon match and compute ROI — turning
  // "blocked → skipped" into "blocked → matched (listing data)".
  const listingFallbackByUrl = new Map<string, { title: string | null; price: number | null; image: string | null; currency: string | null }>();

  // Tier A: seed from the row itself (captured during crawl).
  let tierASeeds = 0;
  for (const r of pendingRows as any[]) {
    const url = r?.source_url;
    if (!url) continue;
    const t = r?.source_title ?? null;
    const p = typeof r?.source_price === "number" ? r.source_price : null;
    const img = r?.source_image_url ?? null;
    const cur = r?.source_currency ?? null;
    if (t || p != null || img) {
      listingFallbackByUrl.set(String(url), { title: t, price: p, image: img, currency: cur });
      if (t && p != null) tierASeeds++;
    }
  }

  // Tier B: top up / overwrite from category_products where available.
  try {
    const urlsForFallback = (pendingRows as any[]).map((r: any) => r.source_url).filter(Boolean);
    if (urlsForFallback.length > 0) {
      const { data: cpRows } = await sb
        .from("category_products")
        .select("product_url, current_title, current_price, current_image, current_currency")
        .eq("supplier_domain", runRow?.supplier_domain ?? "")
        .in("product_url", urlsForFallback);
      for (const cp of cpRows ?? []) {
        const url = String((cp as any).product_url);
        const existing = listingFallbackByUrl.get(url);
        const merged = {
          title: (cp as any).current_title ?? existing?.title ?? null,
          price: typeof (cp as any).current_price === "number" ? (cp as any).current_price : (existing?.price ?? null),
          image: (cp as any).current_image ?? existing?.image ?? null,
          currency: (cp as any).current_currency ?? existing?.currency ?? null,
        };
        listingFallbackByUrl.set(url, merged);
      }
      console.log(
        `[store-scan ${runId}] listing-fallback cache: row_seeds=${tierASeeds}/${pendingRows.length} ` +
        `category_products=${cpRows?.length ?? 0} total=${listingFallbackByUrl.size}/${urlsForFallback.length}`
      );
    }
  } catch (e: any) {
    console.warn(`[store-scan ${runId}] listing-fallback cache load failed:`, e?.message ?? e);
  }

  let extracted = 0, matched = 0, unmatched = 0, blocked = 0, failed = 0;
  const failureReasons: Record<string, number> = {};
  const bumpReason = (k: string) => { failureReasons[k] = (failureReasons[k] ?? 0) + 1; };

  const deriveFieldReason = (r: any, hasTitle: boolean, hasPrice: boolean, hasImage: boolean): string => {
    const fr: string | undefined = r?.final_resolution;
    const p1: string | undefined = r?.phase1_status;
    const provider: string | undefined = r?.block_provider ?? undefined;
    if (fr === "non_product_page") return "non_product_page";
    if (fr === "fetch_error") return p1 === "timeout" ? "fetch_timeout" : "fetch_error";
    if (fr === "blocked_phase1" || fr === "blocked_phase2" || fr === "blocked_all_phases") {
      return provider ? `blocked_${provider}` : "blocked_by_site";
    }
    if (fr === "phase2_timeout") return "render_timeout";
    if (fr === "phase2_render_failed") return "render_failed";
    if (fr === "phase2_extract_failed") return "render_ok_no_price";
    if (fr === "not_found_unblocked") {
      if (!hasTitle && !hasPrice) return "no_title_no_price";
      if (hasTitle && !hasPrice) return "title_ok_price_missing";
      if (!hasTitle && hasPrice) return "price_ok_title_missing";
      return "no_image";
    }
    if (!hasTitle && !hasPrice) return "extraction_returned_empty";
    if (!hasPrice) return "price_missing";
    if (!hasTitle) return "title_missing";
    return "extraction_partial";
  };

  // Process items in this chunk — concurrency 2 keeps us under both Supabase
  // function-to-function rate limits and our extractor's per-second budget.
  const concurrency = throttle.concurrency;
  type PendingRow = { id: string; source_url: string; url_key: string | null; product_id: string | null };
  const slices: PendingRow[][] = Array.from({ length: concurrency }, () => []);
  pendingRows.forEach((row: any, i: number) => slices[i % concurrency].push(row));

  const worker = async (slice: PendingRow[]) => {
    for (const row of slice) {
      const url = row.source_url;
      try {
        // Human-like jitter delay between requests — critical for slow-lane domains
        // (Walmart, Target) where rapid sequential fetches trigger press-and-hold.
        await jitterDelay(throttle.delayMinMs, throttle.delayMaxMs);
        const r = await extractProduct(url, leasedUserId, userAuthHeader);
        let sourceTitle: string | null = r?.title ?? null;
        let sourcePrice: number | null = typeof r?.price_current === "number" ? r.price_current : null;
        let sourceImage: string | null = r?.image_url ?? null;
        let sourceCurrency: string = r?.currency ?? "USD";
        let hasTitle = !!sourceTitle && sourceTitle.length > 2;
        let hasPrice = sourcePrice !== null && sourcePrice > 0;
        let hasImage = !!sourceImage;

        // If the extractor returned data but it looks like a challenge page,
        // count it as a real block so we don't pollute "matched" stats and
        // so the dashboard surfaces the actual reason.
        const looksAntiBot = isAntiBotBlocked(r) || (
          hasTitle && !hasPrice && /press\s*&?\s*hold|robot|verify|captcha/i.test(sourceTitle ?? "")
        );
        if (looksAntiBot) {
          console.warn(`[store-scan ${runId}] anti-bot block detected url=${url.slice(0, 120)} provider=${r?.block_provider ?? "?"}`);
        }

        let status = "extracted";
        let errMsg: string | null = r?.error ?? null;
        let reasonCode: string | null = null;
        let extractionMode: "full" | "listing_fallback" = "full";

        if (errMsg && /^extractor_\d+/i.test(errMsg)) {
          status = "error"; failed++;
          reasonCode = errMsg.toLowerCase().startsWith("extractor_4") || errMsg.toLowerCase().startsWith("extractor_5")
            ? errMsg.split(":")[0].toLowerCase()
            : "extractor_failure";
          bumpReason(reasonCode);
        } else if (looksAntiBot) {
          status = "error"; failed++; blocked++;
          reasonCode = r?.block_provider ? `blocked_${String(r.block_provider).toLowerCase()}` : "blocked_anti_bot";
          bumpReason(reasonCode);
        } else if (!hasTitle && !hasPrice) {
          status = "error"; failed++;
          reasonCode = deriveFieldReason(r, hasTitle, hasPrice, hasImage);
          bumpReason(reasonCode);
          if (/blocked/.test(reasonCode)) blocked++;
        } else if (hasTitle && !hasPrice) {
          status = "partial"; failed++;
          reasonCode = deriveFieldReason(r, hasTitle, hasPrice, hasImage);
          bumpReason(reasonCode);
        } else {
          extracted++;
        }

        // ── LISTING-DATA FALLBACK ─────────────────────────────────────
        // The PDP fetch was blocked / partial / empty, but the category
        // crawl already captured title/image/price for this URL. Use that
        // listing data to keep the matching pipeline alive instead of
        // discarding the row. This converts "blocked → skipped" into
        // "blocked → matched (listing data)".
        if (status !== "extracted") {
          const listing = listingFallbackByUrl.get(url);
          if (listing && listing.title && listing.title.length > 2 && typeof listing.price === "number" && listing.price > 0) {
            // Roll back the failure counters we just bumped.
            if (status === "error") failed = Math.max(0, failed - 1);
            else if (status === "partial") failed = Math.max(0, failed - 1);
            if (reasonCode && /blocked/.test(reasonCode)) blocked = Math.max(0, blocked - 1);

            sourceTitle = listing.title;
            sourcePrice = listing.price;
            sourceImage = listing.image ?? sourceImage;
            sourceCurrency = listing.currency ?? sourceCurrency;
            hasTitle = true;
            hasPrice = true;
            hasImage = !!sourceImage;

            extractionMode = "listing_fallback";
            status = "extracted";
            errMsg = null;
            const prevReason = reasonCode;
            reasonCode = null;
            extracted++;
            bumpReason("recovered_via_listing_fallback");
            console.log(
              `[store-scan ${runId}] LISTING-FALLBACK recovered url=${url.slice(0, 120)} ` +
              `prev_reason=${prevReason ?? "?"} title="${sourceTitle?.slice(0, 60)}" price=${sourcePrice}`
            );
          }
        }

        console.log(
          `[store-scan ${runId}] item url=${url.slice(0, 120)} ` +
          `title=${hasTitle ? "Y" : "N"} price=${hasPrice ? sourcePrice : "N"} image=${hasImage ? "Y" : "N"} ` +
          `phase1=${r?.phase1_status ?? "?"} phase2=${r?.phase2_status ?? "?"} ` +
          `final=${r?.final_resolution ?? "?"} block=${r?.block_provider ?? "-"} ` +
          `method=${r?.extraction_method ?? "?"} reason=${reasonCode ?? "ok"}`
        );

        let m: any = {
          asin: null, title: null, price: null, image: null,
          score: 0, method: "skipped", confidence: "none",
          roi: null, margin: null, candidates: [], query: "",
        };

        // ── ROI carry-over (existing-product short-circuit): if a prior scan
        // of the SAME source URL already produced an Amazon match, reuse the
        // matched_asin / amz_price / roi WITHOUT calling SP-API again. SP-API
        // is reserved exclusively for newly discovered URLs (no prior row).
        // The user can still click per-row "Refresh ROI" to recompute live.
        //
        // Carry-over triggers as long as a prior matched row exists for this
        // (user, source_url). We no longer require source_price parity — small
        // supplier price drift should not waste an SP-API call.
        let carriedOver = false;
        if (status === "extracted" && sourceTitle) {
          try {
            // Lookup by url_key first (canonical, dedupes tracking-param variants),
            // then product_id as a secondary key. Falls back to source_url for
            // legacy rows that pre-date the url_key column.
            let priorQuery = sb
              .from("store_scan_items")
              .select("run_id, created_at, source_price, matched_asin, amz_title, amz_price, amz_image_url, match_score, match_method, match_confidence, normalized_query, amz_candidates, roi, margin_pct, fees_json")
              .eq("user_id", leasedUserId)
              .not("matched_asin", "is", null);

            if (row.url_key) {
              priorQuery = priorQuery.eq("url_key", row.url_key);
            } else if (row.product_id) {
              priorQuery = priorQuery.eq("product_id", row.product_id);
            } else {
              priorQuery = priorQuery.eq("source_url", url);
            }

            const { data: priorRows } = await priorQuery
              .order("created_at", { ascending: false })
              .limit(5);

            const runStartedAtMs = Date.parse(String((runRow as any)?.started_at ?? ""));
            const prior = (priorRows ?? []).find((candidate: any) => {
              if (!candidate?.matched_asin) return false;
              if (candidate.run_id !== runId) return true;
              const createdAtMs = Date.parse(String(candidate.created_at ?? ""));
              return Number.isFinite(runStartedAtMs)
                ? Number.isFinite(createdAtMs) && createdAtMs < runStartedAtMs
                : false;
            }) ?? null;

            const priorCandidateCount = Array.isArray(prior?.amz_candidates) ? prior.amz_candidates.length : 0;
            const priorMethod = String(prior?.match_method ?? "").toLowerCase();
            const priorLooksLegacySingleMatch = priorCandidateCount <= 1 || (!priorMethod.startsWith("engine_") && !priorMethod.startsWith("spapi_"));
            const acceptedPriorCandidate = Array.isArray(prior?.amz_candidates)
              ? prior.amz_candidates.find((c: any) => String(c?.asin ?? "").toUpperCase() === String(prior?.matched_asin ?? "").toUpperCase())
              : null;
            const acceptedPriorVerdict = String(acceptedPriorCandidate?.verdict ?? "").toLowerCase();
            const acceptedPriorConfidence = Number(acceptedPriorCandidate?.engine_confidence ?? 0);
            const acceptedPriorDecision = String(acceptedPriorCandidate?.decision_signal ?? "").toLowerCase();
            const priorCarryOverEligible = !!prior?.matched_asin
              && !priorLooksLegacySingleMatch
              && (
                acceptedPriorVerdict === "exact_match"
                || acceptedPriorVerdict === "same_base_product_different_pack"
                || (acceptedPriorVerdict === "likely_match" && acceptedPriorConfidence >= 75)
              )
              && acceptedPriorDecision !== "hard_conflict";

            if (priorCarryOverEligible) {
              // Recompute ROI locally if supplier price moved meaningfully (>2%
              // or > $0.50) using the cached amz_price + cached fees — still no
              // SP-API call. Otherwise reuse prior ROI verbatim.
              const priorSrc = Number(prior.source_price ?? 0);
              const priceDrift = priorSrc > 0 && sourcePrice
                ? Math.abs(sourcePrice - priorSrc) / priorSrc
                : 0;
              const priceDelta = priorSrc > 0 && sourcePrice
                ? Math.abs(sourcePrice - priorSrc)
                : 0;

              let reusedRoi = prior.roi;
              let reusedMargin = prior.margin_pct;
              let recomputed = false;

              const cachedAmzPrice = Number(prior.amz_price ?? 0);
              const cachedFees =
                prior.fees_json && typeof (prior.fees_json as any).totalFees === "number"
                  ? Number((prior.fees_json as any).totalFees)
                  : null;

              if (
                sourcePrice &&
                sourcePrice > 0 &&
                cachedAmzPrice > 0 &&
                cachedFees != null &&
                (priceDrift > 0.02 || priceDelta > 0.5)
              ) {
                const profit = cachedAmzPrice - cachedFees - sourcePrice;
                reusedRoi = Math.round((profit / sourcePrice) * 100 * 100) / 100;
                reusedMargin = Math.round((profit / cachedAmzPrice) * 100 * 100) / 100;
                recomputed = true;
              }

              m = {
                asin: prior.matched_asin,
                title: prior.amz_title,
                price: prior.amz_price,
                image: prior.amz_image_url,
                score: prior.match_score ?? 0,
                method: prior.match_method ?? "carried_over",
                confidence: prior.match_confidence ?? "low",
                roi: reusedRoi,
                margin: reusedMargin,
                candidates: Array.isArray(prior.amz_candidates) ? prior.amz_candidates : [],
                query: prior.normalized_query ?? "",
                feesJson: prior.fees_json ?? null,
              };
              carriedOver = true;
              status = "matched"; matched++;
              bumpReason(recomputed ? "carried_over_recomputed_local" : "carried_over_prior_match");
              console.log(
                `[store-scan ${runId}] ROI carry-over for ${url.slice(0, 100)} ` +
                `asin=${m.asin} src=$${sourcePrice ?? "?"} prior_src=$${priorSrc} ` +
                `roi=${m.roi}% recomputed=${recomputed} (no SP-API call)`
              );
            } else if (prior && prior.matched_asin) {
              console.log(
                `[store-scan ${runId}] skipping legacy carry-over for ${url.slice(0, 100)} ` +
                `asin=${prior.matched_asin} prior_method=${prior.match_method ?? "-"} candidates=${priorCandidateCount} ` +
                `verdict=${acceptedPriorVerdict || "-"} confidence=${acceptedPriorConfidence || 0} decision=${acceptedPriorDecision || "-"}`
              );
            }
          } catch (carryErr: any) {
            console.warn(`[store-scan ${runId}] carry-over lookup failed:`, carryErr?.message ?? carryErr);
          }
        }

        if (!carriedOver && status === "extracted" && sourceTitle) {
          m = await matchAmazon(sourceTitle, sourcePrice, leasedUserId);
          if (m.asin) {
            status = "matched"; matched++;
            if (m.confidence !== "high") bumpReason(`matched_${m.confidence}_confidence`);
            // Track ROI resolution outcome so we can see it in scan stats / debugging.
            if (m.roi == null) bumpReason("matched_no_roi_after_fallbacks");
          } else {
            status = "unmatched"; unmatched++;
            bumpReason(`unmatched_${m.method}`);
          }
          console.log(
            `[store-scan ${runId}] match query="${m.query}" best_score=${m.score} ` +
            `confidence=${m.confidence} roi=${m.roi ?? "n/a"} top=${(m.candidates ?? []).map((c: any) => `${c.asin}:${c.score}`).join(",")}`
          );
        }

        const finalErr = errMsg
          ? errMsg
          : reasonCode
            ? `${reasonCode}${r?.final_resolution ? ` (resolution=${r.final_resolution})` : ""}${r?.block_provider ? ` (block=${r.block_provider})` : ""}`
            : null;

        // ── PRESERVE PRIOR MATCH ON BLOCKED/FAILED REFRESH ─────────────
        // If this rescan failed/was blocked AND we have a previously
        // verified match, never wipe the good data. Re-fetch the prior
        // row by url_key/product_id/source_url and keep its match fields.
        // Only stamp last_refresh_status / last_refresh_error so the UI
        // can show "last refresh blocked; showing previous verified result".
        const refreshFailed = !carriedOver
          && (status === "error" || status === "partial")
          && !m.asin;

        let preservePayload: Record<string, any> | null = null;
        let preserveStatus: string | null = null;
        if (refreshFailed) {
          try {
            let priorQuery2 = sb
              .from("store_scan_items")
              .select("matched_asin, amz_title, amz_price, amz_image_url, match_score, match_method, match_confidence, normalized_query, amz_candidates, roi, margin_pct, fees_json, source_title, source_price, source_image_url, source_currency, status")
              .eq("user_id", leasedUserId)
              .not("matched_asin", "is", null)
              .neq("id", row.id);
            if (row.url_key) {
              priorQuery2 = priorQuery2.eq("url_key", row.url_key);
            } else if (row.product_id) {
              priorQuery2 = priorQuery2.eq("product_id", row.product_id);
            } else {
              priorQuery2 = priorQuery2.eq("source_url", url);
            }
            const { data: priorPreserveRows } = await priorQuery2
              .order("created_at", { ascending: false })
              .limit(1);
            const priorGood = (priorPreserveRows ?? [])[0] as any;
            if (priorGood && priorGood.matched_asin) {
              // Use prior matched data; keep prior status (matched/unmatched)
              // so the row is not visually downgraded to "skipped"/"error".
              preserveStatus = priorGood.status === "matched" ? "matched" : (status);
              preservePayload = {
                source_title: sourceTitle ?? priorGood.source_title,
                source_price: sourcePrice ?? priorGood.source_price,
                source_currency: sourceCurrency ?? priorGood.source_currency,
                source_image_url: sourceImage ?? priorGood.source_image_url,
                source_availability: r?.availability ?? null,
                source_availability_status: (r as any)?.availability_status ?? "unknown",
                matched_asin: priorGood.matched_asin,
                amz_title: priorGood.amz_title,
                amz_price: priorGood.amz_price,
                amz_image_url: priorGood.amz_image_url,
                match_score: priorGood.match_score,
                match_method: priorGood.match_method,
                match_confidence: priorGood.match_confidence,
                normalized_query: priorGood.normalized_query,
                amz_candidates: priorGood.amz_candidates,
                roi: priorGood.roi,
                margin_pct: priorGood.margin_pct,
                fees_json: priorGood.fees_json,
                status: "matched",
                error: null,
                last_refresh_status: reasonCode ?? "refresh_failed",
                last_refresh_error: finalErr,
                last_refresh_at: new Date().toISOString(),
              };
              // Reclassify counters: this is NOT a fresh failure of a known
              // good item — it's a preserved match.
              if (status === "error") failed = Math.max(0, failed - 1);
              if (reasonCode && /blocked/.test(reasonCode)) blocked = Math.max(0, blocked - 1);
              matched++;
              bumpReason("preserved_prior_match_on_refresh_block");
              console.log(
                `[store-scan ${runId}] PRESERVED prior match for ${url.slice(0, 100)} ` +
                `asin=${priorGood.matched_asin} confidence=${priorGood.match_confidence ?? "?"} ` +
                `(refresh_status=${reasonCode ?? "refresh_failed"})`
              );
            }
          } catch (preserveErr: any) {
            console.warn(`[store-scan ${runId}] preserve-prior lookup failed:`, preserveErr?.message ?? preserveErr);
          }
        }

        // ── PRECISION LAYER: price sanity + composite confidence + Review bucket
        // Computed only for fresh (non-preserved) match results so prior good
        // matches keep their stored quality fields untouched on refresh.
        const _priceSanity = evaluatePriceSanity(sourcePrice ?? null, m.price ?? null);
        const _hasAsin = !!m.asin;
        const _engineCandidate = (m.candidates ?? []).find((c) => c.asin === m.asin);
        const _verificationEvidence = _engineCandidate?.verification_evidence ?? null;
        const _imageSignalApplied = typeof _verificationEvidence?._image_signal_applied === "string"
          ? String(_verificationEvidence._image_signal_applied)
          : null;
        const _imageMismatch = Boolean(
          _verificationEvidence?._image_mismatch_warning === true ||
          _imageSignalApplied === "demote_light" ||
          _imageSignalApplied === "demote_strong"
        );
        const _quality = scoreMatchConfidence({
          text_score: typeof m.score === "number" ? m.score : null,
          engine_verdict: _engineCandidate?.verdict ?? null,
          engine_confidence: _engineCandidate?.engine_confidence ?? null,
          price_sanity: _priceSanity.state,
          price_ratio: _priceSanity.ratio,
          verification_depth: extractionMode === "listing_fallback"
            ? "listing_fallback"
            : (_hasAsin ? "full" : "none"),
          has_amazon_price: typeof m.price === "number" && Number.isFinite(m.price) && m.price > 0,
          image_mismatch: _imageMismatch,
        });
        const _confidenceScore = _hasAsin ? _quality.score : null;
        const _confidenceBand: ConfidenceBand | null = _hasAsin ? _quality.band : null;
        const _reviewRequired = _hasAsin && _confidenceBand === "review";
        const _qualitySignals = _hasAsin ? {
          text_score: typeof m.score === "number" ? m.score : null,
          engine_verdict: _engineCandidate?.verdict ?? null,
          engine_confidence: _engineCandidate?.engine_confidence ?? null,
          price_sanity: _priceSanity.state,
          price_ratio: _priceSanity.ratio,
          verification_depth: extractionMode === "listing_fallback" ? "listing_fallback" : "full",
          has_amazon_price: typeof m.price === "number" && Number.isFinite(m.price) && m.price > 0,
          image_mismatch: _imageMismatch,
          image_signal_applied: _imageSignalApplied,
          computed_at: new Date().toISOString(),
        } : null;

        // Update the existing pending row instead of inserting a new one.
        await sb.from("store_scan_items").update(preservePayload ?? {
          source_title: sourceTitle,
          source_price: sourcePrice,
          source_currency: sourceCurrency,
          source_image_url: sourceImage,
          source_availability: r?.availability ?? null,
          source_availability_status: (r as any)?.availability_status ?? "unknown",
          matched_asin: m.asin,
          amz_title: m.title,
          amz_price: m.price,
          amz_image_url: m.image,
          match_score: m.score || null,
          match_method: m.method,
          // GLOBAL PIPELINE INTEGRITY (Fix #1): never claim "high" confidence when
          // the trade-readiness signal (Amazon price) is missing/zero. Identity
          // match (AI) and trade viability (price/ROI) are separate truths — keep
          // them separate so the UI can filter unusable rows out by default.
          match_confidence: (() => {
            const cf = m.confidence ?? null;
            const priceOk = typeof m.price === "number" && Number.isFinite(m.price) && m.price > 0;
            if (m.asin && !priceOk && cf === "high") return "needs_price";
            return cf;
          })(),
          // ── Precision layer columns (price sanity + composite trust score)
          confidence_score: _confidenceScore,
          confidence_band: _confidenceBand,
          price_sanity: _hasAsin ? _priceSanity.state : null,
          review_required: _reviewRequired,
          match_quality_signals: _qualitySignals,
          normalized_query: m.query ?? null,
          amz_candidates: m.candidates && m.candidates.length ? m.candidates : null,
          roi: m.roi,
          margin_pct: m.margin,
          fees_json: m.feesJson ?? null,
          status,
          error: finalErr,
          // Stamp refresh outcome so even non-preserved rows surface why the
          // last attempt failed (helps admin debug). For successful matches
          // we record "success" to clear stale warnings from a prior run.
          // When the row was hydrated from category_products listing data
          // (PDP fetch was blocked), we surface that explicitly so the UI
          // can show "Supplier protected — using listing data".
          last_refresh_status: extractionMode === "listing_fallback"
            ? "listing_fallback"
            : (refreshFailed ? (reasonCode ?? "refresh_failed") : (m.asin ? "success" : (status === "extracted" ? "success" : (reasonCode ?? null)))),
          last_refresh_error: extractionMode === "listing_fallback" ? null : (refreshFailed ? finalErr : null),
          last_refresh_at: new Date().toISOString(),
        }).eq("id", row.id);
      } catch (itemErr: any) {
        failed++; bumpReason("worker_exception");
        console.error(`[store-scan ${runId}] worker error for ${url}:`, itemErr?.message ?? itemErr);
        await sb.from("store_scan_items").update({
          status: "error",
          error: String(itemErr?.message ?? itemErr).slice(0, 500),
          match_method: "exception",
        }).eq("id", row.id);
      }
    }
  };

  await Promise.all(slices.map(worker));

  // Atomically merge this chunk's counters and failure_reasons into the run row.
  const { data: cur } = await sb
    .from("store_scan_runs")
    .select("products_extracted, products_matched, products_unmatched, products_blocked, products_failed, failure_reasons")
    .eq("id", runId)
    .maybeSingle();

  const mergedReasons: Record<string, number> = {
    ...(cur?.failure_reasons ?? {}),
  };
  for (const [k, v] of Object.entries(failureReasons)) {
    mergedReasons[k] = (mergedReasons[k] ?? 0) + v;
  }

  const runUpdate: Record<string, unknown> = {
    products_extracted: (cur?.products_extracted ?? 0) + extracted,
    products_matched: (cur?.products_matched ?? 0) + matched,
    products_unmatched: (cur?.products_unmatched ?? 0) + unmatched,
    products_blocked: (cur?.products_blocked ?? 0) + blocked,
    products_failed: (cur?.products_failed ?? 0) + failed,
    failure_reasons: mergedReasons,
  };
  if (leaseSupported) runUpdate.chunk_lease_until = null;

  await sb.from("store_scan_runs").update(runUpdate).eq("id", runId);

  console.log(`[store-scan ${runId}] chunk done — extracted=${extracted} matched=${matched} failed=${failed}`);

  // Trigger the next chunk. If none remain it will short-circuit to finalizeRun.
  await triggerNextChunk(runId, userAuthHeader);
}

async function finalizeRun(sb: ReturnType<typeof createClient>, runId: string, leaseSupported = true) {
  // Inspect counters to decide terminal status. If we found products but
  // extracted/matched none AND failures occurred, the run is effectively
  // a failure even if the chunk loop exited cleanly — show 'error' so
  // users see the red status instead of a misleading green "done".
  const { data: cur } = await sb
    .from("store_scan_runs")
    .select("products_found, products_extracted, products_matched, products_failed, failure_reasons")
    .eq("id", runId)
    .maybeSingle();

  let terminalStatus: "done" | "error" | "blocked" = "done";
  let errorMessage: string | null = null;
  if (cur) {
    const found = Number(cur.products_found ?? 0);
    const extracted = Number(cur.products_extracted ?? 0);
    const matched = Number(cur.products_matched ?? 0);
    const failed = Number(cur.products_failed ?? 0);
    const reasons = (cur.failure_reasons ?? {}) as Record<string, number>;
    const reasonKeys = Object.keys(reasons);
    const allFailed = found > 0 && extracted === 0 && matched === 0 && failed > 0;
    const scraperQuotaHit = reasonKeys.some((k) =>
      /quota|monthly api calls|scrapingbee|payment|insufficient/i.test(k),
    );
    // BLOCKED: we found product URLs but extracted/matched zero. This is NOT
    // "done" — the supplier blocked us, the scraper hit a quota, or page parsing
    // failed across the board. Surfacing this as a distinct terminal state lets
    // the UI show "Scan failed — showing previous results" instead of pretending
    // the scan succeeded with empty hands.
    const isZeroExtractionBlock = found > 0 && extracted === 0 && matched === 0;
    if (allFailed || scraperQuotaHit) {
      terminalStatus = "error";
      errorMessage = scraperQuotaHit
        ? "Scraper quota exhausted — no product details could be fetched"
        : "All products failed to extract — see failure_reasons for details";
    } else if (isZeroExtractionBlock) {
      terminalStatus = "blocked";
      errorMessage = "Scan blocked: 0 of " + found + " products could be extracted (scraper blocked, supplier protections, or page format change). Previous results preserved.";
    }
  }

  const runUpdate: Record<string, unknown> = {
    status: terminalStatus,
    completed_at: new Date().toISOString(),
  };
  if (errorMessage) runUpdate.error_message = errorMessage;
  if (leaseSupported) runUpdate.chunk_lease_until = null;

  await sb.from("store_scan_runs").update(runUpdate).eq("id", runId);

  const { data: finalizedRun } = await sb
    .from("store_scan_runs")
    .select("started_at, products_extracted, products_matched, products_found")
    .eq("id", runId)
    .maybeSingle();
  const startedAt = String((finalizedRun as { started_at?: string | null } | null)?.started_at ?? "");
  const finalExtracted = Number((finalizedRun as any)?.products_extracted ?? 0);
  const finalMatched = Number((finalizedRun as any)?.products_matched ?? 0);
  const finalFound = Number((finalizedRun as any)?.products_found ?? 0);

  // ZERO-EXTRACTION SAFEGUARD: if this rescan collapsed to zero extracted /
  // zero matched products, do NOT delete the prior good rows. Wiping them
  // would erase the previous successful scan and leave the admin staring at
  // an empty table. Surface a warning instead so it's visible in logs.
  const shouldPreservePrior = finalExtracted === 0 && finalMatched === 0;

  if (startedAt && !shouldPreservePrior) {
    const { error: cleanupErr } = await sb
      .from("store_scan_items")
      .delete()
      .eq("run_id", runId)
      .lt("created_at", startedAt);
    if (cleanupErr) {
      console.warn(`[store-scan ${runId}] failed to remove superseded rows after finalize:`, cleanupErr.message);
    }
  } else if (shouldPreservePrior) {
    console.warn(
      `[store-scan ${runId}] ZERO_EXTRACTION_SAFEGUARD active — preserving prior items ` +
      `(found=${finalFound}, extracted=${finalExtracted}, matched=${finalMatched}). ` +
      `No rows deleted from store_scan_items.`
    );
    // Best-effort: append a note to error_message so the admin sees the safeguard.
    try {
      const noteRunUpdate: Record<string, unknown> = {
        error_message: (errorMessage ? errorMessage + " · " : "") +
          "Zero-extraction safeguard active: previous scan data preserved.",
      };
      await sb.from("store_scan_runs").update(noteRunUpdate).eq("id", runId);
    } catch {}
  }

  console.log(`[store-scan ${runId}] all chunks complete — run finalized as ${terminalStatus}${errorMessage ? ` (${errorMessage})` : ""}`);
}


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const internalSecret = req.headers.get("x-internal-secret") ?? "";

    let body: StartBody;
    try { body = await req.json(); }
    catch (e: any) {
      return new Response(JSON.stringify({ error: `invalid_json: ${e?.message}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ── Internal continuation: process the next chunk of an existing run ──
    if (body.mode === "process_chunk") {
      if (!INTERNAL_SYNC_SECRET || internalSecret !== INTERNAL_SYNC_SECRET) {
        return new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const runId = body.run_id;
      if (!runId) {
        return new Response(JSON.stringify({ error: "run_id required for process_chunk" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Run the chunk in the background and return immediately so this invocation's
      // wall-time is bounded only by one chunk's processing time.
      // Always use the service-role bearer for downstream internal calls — the
      // incoming authHeader may belong to an expired user JWT (the scan can
      // outlive a user session), which would silently kill the chunk loop.
      const internalAuthHeader = `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
      // @ts-ignore — EdgeRuntime is available in Supabase Edge Functions
      (globalThis as any).EdgeRuntime?.waitUntil(runChunkPhase(sb, runId, internalAuthHeader));
      return new Response(JSON.stringify({ ok: true, mode: "process_chunk", run_id: runId }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Resume mode: client watchdog calls this when a run looks stalled.
    // Resets stuck "processing" items back to "pending", clears any stale lease,
    // and re-triggers the chunk loop. Safe to call repeatedly (idempotent).
    if (body.mode === "resume") {
      const runId = body.run_id;
      if (!runId) {
        return new Response(JSON.stringify({ error: "run_id required for resume" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Auth: either the run's owner OR an internal call.
      let authorized = false;
      if (INTERNAL_SYNC_SECRET && internalSecret === INTERNAL_SYNC_SECRET) {
        authorized = true;
      } else if (authHeader) {
        const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
          global: { headers: { Authorization: authHeader } },
        });
        const token = authHeader.replace(/^Bearer\s+/i, "");
        const { data: claims } = await userClient.auth.getClaims(token);
        const uid = (claims as any)?.claims?.sub;
        if (uid) {
          const { data: ownerRow } = await sb
            .from("store_scan_runs")
            .select("user_id, status")
            .eq("id", runId)
            .maybeSingle();
          if (ownerRow && (ownerRow as any).user_id === uid) authorized = true;
        }
      }
      if (!authorized) {
        return new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: runStatus } = await sb
        .from("store_scan_runs")
        .select("status")
        .eq("id", runId)
        .maybeSingle();
      if (!runStatus) {
        return new Response(JSON.stringify({ error: "run_not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const st = (runStatus as any).status;
      if (st === "done" || st === "error") {
        return new Response(JSON.stringify({ ok: true, skipped: true, reason: `terminal_${st}` }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Reset stuck "processing" items older than 3 minutes to "pending"
      const staleCutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      const { data: resetRows } = await sb
        .from("store_scan_items")
        .update({ status: "pending" })
        .eq("run_id", runId)
        .eq("status", "processing")
        .lt("created_at", staleCutoff)
        .select("id");
      const resetCount = resetRows?.length ?? 0;

      // Clear any stale lease (best-effort)
      try {
        await sb.from("store_scan_runs").update({ chunk_lease_until: null }).eq("id", runId);
      } catch {}

      console.log(`[store-scan ${runId}] RESUME requested — reset ${resetCount} stuck items, re-triggering chunk loop`);

      const internalAuthHeader = `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
      // @ts-ignore — EdgeRuntime is available in Supabase Edge Functions
      (globalThis as any).EdgeRuntime?.waitUntil(runChunkPhase(sb, runId, internalAuthHeader));

      return new Response(JSON.stringify({ ok: true, mode: "resume", run_id: runId, reset_items: resetCount }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!authHeader) {
      console.error("[store-scan] missing Authorization header");
      return new Response(JSON.stringify({ error: "missing_auth_header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Normal start path: authenticate user, create run, kick off crawl phase ──
    const supabaseAuth = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await supabaseAuth.auth.getUser();
    if (authErr || !user) {
      console.error("[store-scan] auth failed:", authErr?.message);
      return new Response(JSON.stringify({ error: `unauthorized: ${authErr?.message ?? "no user"}` }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supplierDomain = normDomain(body.supplier_domain || "");
    const categoryUrls = Array.isArray(body.category_urls) ? body.category_urls.filter(Boolean) : [];
    if (!supplierDomain || categoryUrls.length === 0) {
      return new Response(JSON.stringify({ error: "supplier_domain and category_urls required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: profile } = await sb
      .from("supplier_scan_profiles")
      .select("*")
      .eq("domain", supplierDomain)
      .maybeSingle();

    // Cap lifted: trust user-provided max_products. Profile cap kept only as a sane upper safeguard (10000).
    const HARD_SAFETY_CAP = 10000;
    const maxProducts = Math.min(body.max_products ?? 500, HARD_SAFETY_CAP);
    const maxPages = profile?.max_pages_per_run ?? 5;
    const startedAt = new Date().toISOString();
    const cleanCategoryUrls = Array.from(new Set(categoryUrls.map((url) => String(url).trim()).filter(Boolean)));
    const normalizeScopeUrl = (raw: string) => {
      const trimmed = String(raw ?? "").trim();
      if (!trimmed) return "";
      try {
        const u = new URL(trimmed);
        const params = [...u.searchParams.entries()].sort(([aKey, aVal], [bKey, bVal]) => {
          if (aKey === bKey) return aVal.localeCompare(bVal);
          return aKey.localeCompare(bKey);
        });
        const query = params.length > 0
          ? `?${params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`
          : "";
        return `${u.protocol.toLowerCase()}//${normDomain(u.hostname)}${(u.pathname || "/").replace(/\/+$/, "") || "/"}${query}`;
      } catch {
        return trimmed.toLowerCase().replace(/#.*$/, "").replace(/\/+$/, "");
      }
    };
    const normalizedSignature = cleanCategoryUrls.map(normalizeScopeUrl).filter(Boolean).sort();
    const sameRunScope = (row: { category_id?: string | null; scope_urls?: string[] | null }) => {
      if (body.category_id && row.category_id && row.category_id === body.category_id) return true;
      const candidateSignature = Array.isArray(row.scope_urls)
        ? row.scope_urls.map(normalizeScopeUrl).filter(Boolean).sort()
        : [];
      return candidateSignature.length === normalizedSignature.length
        && candidateSignature.every((value, index) => value === normalizedSignature[index]);
    };

    const { data: recentRuns, error: recentRunsErr } = await sb
      .from("store_scan_runs")
      .select("id, status, category_id, scope_urls")
      .eq("user_id", user.id)
      .eq("supplier_domain", supplierDomain)
      .eq("scope_type", "category_url")
      .order("created_at", { ascending: false })
      .limit(body.category_id ? 50 : 200);
    if (recentRunsErr) {
      console.error("[store-scan] run_lookup_failed:", recentRunsErr);
      return new Response(JSON.stringify({ error: recentRunsErr.message ?? "run_lookup_failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const existingRun = (recentRuns ?? []).find((row) => sameRunScope(row as { category_id?: string | null; scope_urls?: string[] | null }));
    const existingStatus = String((existingRun as { status?: string | null } | undefined)?.status ?? "").toLowerCase();
    const activeStatuses = new Set(["crawling", "extracting", "running", "processing"]);

    if (existingRun && activeStatuses.has(existingStatus)) {
      return new Response(JSON.stringify({
        run_id: (existingRun as { id: string }).id,
        status: existingStatus,
        message: "Matching scan already running.",
        products_found: 0,
        reused: true,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    let run: Record<string, any> | null = null;
    let runErr: { message?: string } | null = null;

    if (existingRun) {
      const recycled = await sb
        .from("store_scan_runs")
        .update({
          profile_id: profile?.id ?? null,
          supplier_domain: supplierDomain,
          scope_type: "category_url",
          scope_urls: cleanCategoryUrls,
          status: "crawling",
          max_products_cap: maxProducts,
          started_at: startedAt,
          completed_at: null,
          category_id: body.category_id ?? (existingRun as { category_id?: string | null }).category_id ?? null,
          pages_crawled: 0,
          products_found: 0,
          products_new: 0,
          products_extracted: 0,
          products_matched: 0,
          products_unmatched: 0,
          products_blocked: 0,
          products_failed: 0,
          failure_reasons: {},
          error_message: null,
          chunk_lease_until: null,
        })
        .eq("id", (existingRun as { id: string }).id)
        .select("*")
        .single();
      run = (recycled.data as Record<string, any> | null) ?? null;
      runErr = recycled.error;
    } else {
      const created = await sb
        .from("store_scan_runs")
        .insert({
          user_id: user.id,
          profile_id: profile?.id ?? null,
          supplier_domain: supplierDomain,
          scope_type: "category_url",
          scope_urls: cleanCategoryUrls,
          status: "crawling",
          max_products_cap: maxProducts,
          started_at: startedAt,
          category_id: body.category_id ?? null,
        })
        .select("*")
        .single();
      run = (created.data as Record<string, any> | null) ?? null;
      runErr = created.error;
    }

    if (runErr || !run) {
      console.error("[store-scan] run_create_failed:", runErr);
      return new Response(JSON.stringify({ error: runErr?.message ?? "run_create_failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Kick off the crawl phase in the background; it will queue pending items
    // and self-trigger the first chunk worker.
    // @ts-ignore — EdgeRuntime is available in Supabase Edge Functions
    // IMPORTANT: pass the service-role bearer (not the user's JWT) for all
    // internal self-triggered continuations and downstream function calls.
    // The user's JWT expires after ~1 hour and the scan can run for many
    // hours; using the service role keeps the chunk loop alive regardless of
    // whether the user is still on the page or their session has been
    // refreshed/rotated. Internal endpoints additionally enforce
    // INTERNAL_SYNC_SECRET, so this does not weaken authorization.
    const internalAuthHeader = `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
    (globalThis as any).EdgeRuntime?.waitUntil(runCrawlPhase(sb, run.id, user.id, internalAuthHeader, supplierDomain, cleanCategoryUrls, maxProducts, maxPages, profile));

    return new Response(JSON.stringify({
      run_id: run.id,
      status: "crawling",
      message: existingRun ? "Scan restarted in existing history row." : "Scan started. Poll store_scan_runs for progress.",
      products_found: 0,
      reused: !!existingRun,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("[store-scan] top-level error:", e?.message ?? e);
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
