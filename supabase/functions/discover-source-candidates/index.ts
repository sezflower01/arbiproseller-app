import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkModuleAccess } from "../_shared/module-access-guard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Domain tiers (mirrors src/pages/tools/supplier-discovery/shared.tsx) ───
const TIER1_DOMAINS = new Set([
  // Mass merchants & big box
  "walmart.com", "target.com", "bestbuy.com", "homedepot.com", "lowes.com",
  "kohls.com", "macys.com", "jcpenney.com", "nordstrom.com", "nordstromrack.com",
  "saksfifthavenue.com", "saksoff5th.com", "bloomingdales.com", "neimanmarcus.com",
  "dillards.com", "belk.com", "bealls.com", "burlington.com", "ross.com", "tjmaxx.com",
  "marshalls.com", "homegoods.com", "sierra.com",
  // Pharmacy / health & beauty
  "walgreens.com", "cvs.com", "riteaid.com", "ulta.com", "sephora.com",
  "bathandbodyworks.com", "victoriassecret.com",
  // Office & school
  "staples.com", "officedepot.com", "schoolspecialty.com",
  // Home improvement / hardware
  "acehardware.com", "menards.com", "harborfreight.com", "tractorsupply.com",
  "northerntool.com", "grainger.com", "zoro.com", "fastenal.com",
  // Home / furniture
  "wayfair.com", "ikea.com", "potterybarn.com", "westelm.com", "crateandbarrel.com",
  "cb2.com", "worldmarket.com", "homedepot.com", "raymourflanigan.com", "ashleyfurniture.com",
  // Crafts / hobbies / books
  "michaels.com", "joann.com", "hobbylobby.com", "barnesandnoble.com", "books-a-million.com",
  // Pet
  "petco.com", "petsmart.com", "chewy.com", "petsuppliesplus.com",
  // Sporting goods / outdoors
  "dickssportinggoods.com", "academy.com", "rei.com", "basspro.com", "cabelas.com",
  "scheels.com", "modells.com", "footlocker.com", "finishline.com", "champssports.com",
  "eastbay.com", "lululemon.com", "gap.com", "oldnavy.com", "bananarepublic.com",
  // Toys / kids / baby
  "toysrus.com", "buybuybaby.com", "carters.com", "oshkosh.com", "thechildrensplace.com",
  "gymboree.com", "build-a-bear.com",
  // Membership clubs (still listed; gated by MEMBERSHIP_DOMAINS for pricing)
  "samsclub.com", "costco.com", "bjs.com",
  // Grocery / convenience (often have GM SKUs)
  "kroger.com", "publix.com", "wegmans.com", "heb.com", "meijer.com",
  "wholefoodsmarket.com", "freshdirect.com", "vitacost.com", "iherb.com",
]);
const TIER2_DOMAINS = new Set([
  // Specialty / niche retailers
  "containerstore.com", "bedbathandbeyond.com", "qvc.com", "hsn.com",
  "newegg.com", "bhphotovideo.com", "adorama.com", "overstock.com",
  "zappos.com", "6pm.com", "shoes.com", "famousfootwear.com", "dswshoes.com", "dsw.com",
  "famousfootwear.com", "shoecarnival.com",
  // Electronics / tech
  "microcenter.com", "frys.com", "tigerdirect.com", "abt.com", "crutchfield.com",
  "samsung.com", "apple.com", "lenovo.com", "dell.com", "hp.com",
  "razer.com", "logitech.com", "corsair.com",
  // Auto & tools
  "autozone.com", "advanceautoparts.com", "oreillyauto.com", "napaonline.com",
  "rockauto.com", "summitracing.com", "carid.com", "4wheelparts.com",
  // Health / supplements / beauty
  "gnc.com", "vitaminshoppe.com", "puritan.com", "swansonvitamins.com",
  "luckyvitamin.com", "dermstore.com", "skinstore.com", "lookfantastic.com",
  // Home goods / kitchen
  "surlatable.com", "williams-sonoma.com", "sur-la-table.com", "kohlsfurniture.com",
  // Books / media
  "thriftbooks.com", "abebooks.com", "alibris.com", "betterworldbooks.com",
  // Apparel
  "uniqlo.com", "hm.com", "zara.com", "macys.com", "express.com", "abercrombie.com",
  "hollisterco.com", "americaneagle.com", "aerie.com", "forever21.com",
  // Misc legit US retailers
  "qvc.com", "evine.com", "shopjimmy.com", "sweetwater.com", "guitarcenter.com",
  "musiciansfriend.com", "americanmusical.com", "samash.com",
  // Outdoors / sports
  "backcountry.com", "moosejaw.com", "campsaver.com", "publiclands.com",
  "sportsmanswarehouse.com", "fieldandstreamshop.com",
  // Toys / collectibles
  "miniinthebox.com", "entertainmentearth.com", "bigbadtoystore.com",
]);
const MEMBERSHIP_DOMAINS = new Set([
  "costco.com", "samsclub.com", "bjs.com",
]);
const AGGREGATOR_PATTERNS = [
  /\bubuy\./i, /\btiendamia\./i, /\bpicclick\./i, /\baddros\./i,
  /\bwarehouserunner\./i, /\bsupplyleader\./i, /\bbabyluckretail\./i,
  /\binstacart\./i,
];
const SOCIAL_PATTERNS = [
  /\binstagram\./i, /\btiktok\./i, /\bfacebook\./i, /\bpinterest\./i,
  /\byoutube\./i, /\btwitter\./i, /\bx\.com$/i, /\breddit\./i,
];

function domainTier(domain: string | null | undefined): 1 | 2 | 3 | 4 {
  if (!domain) return 4;
  const d = domain.toLowerCase().replace(/^www\./, "");
  if (SOCIAL_PATTERNS.some((re) => re.test(d))) return 4;
  if (AGGREGATOR_PATTERNS.some((re) => re.test(d))) return 3;
  if (TIER1_DOMAINS.has(d)) return 1;
  if (TIER2_DOMAINS.has(d)) return 2;
  return 2;
}

function isMembership(domain: string | null): boolean {
  if (!domain) return false;
  return MEMBERSHIP_DOMAINS.has(domain.toLowerCase().replace(/^www\./, ""));
}

const EXCLUDED_DOMAINS = new Set([
  "ebay.com", "aliexpress.com", "alibaba.com", "wish.com", "etsy.com",
]);

// Universal block: any Amazon domain, any TLD, any subdomain.
// Matches: amazon.com, amazon.sg, www.amazon.de, m.amazon.co.jp,
// smile.amazon.com, aax-us-iad.amazon.com, amzn.to, a.co, etc.
const AMAZON_DOMAIN_RE = /(^|\.)(amazon|amzn)\.[a-z.]{2,}$|(^|\.)a\.co$|(^|\.)amzn\.to$/i;

function isAmazonDomain(domain: string | null): boolean {
  if (!domain) return false;
  return AMAZON_DOMAIN_RE.test(domain.toLowerCase());
}

// Country-code TLDs that indicate non-US storefronts. We block these to ensure
// pricing is in USD from US-shippable suppliers (matches user's Amazon US marketplace).
const NON_US_TLD_PATTERNS = [
  /\.co\.uk$/i, /\.uk$/i, /\.de$/i, /\.fr$/i, /\.it$/i, /\.es$/i, /\.nl$/i,
  /\.pl$/i, /\.se$/i, /\.no$/i, /\.fi$/i, /\.dk$/i, /\.ie$/i, /\.be$/i,
  /\.at$/i, /\.ch$/i, /\.pt$/i, /\.gr$/i, /\.cz$/i, /\.hu$/i, /\.ro$/i,
  /\.com\.mx$/i, /\.mx$/i, /\.com\.br$/i, /\.com\.ar$/i, /\.cl$/i, /\.co$/i,
  /\.pe$/i, /\.ca$/i, /\.com\.au$/i, /\.au$/i, /\.co\.nz$/i, /\.nz$/i,
  /\.co\.jp$/i, /\.jp$/i, /\.co\.kr$/i, /\.kr$/i, /\.cn$/i, /\.com\.cn$/i,
  /\.hk$/i, /\.tw$/i, /\.sg$/i, /\.my$/i, /\.th$/i, /\.vn$/i, /\.ph$/i,
  /\.id$/i, /\.in$/i, /\.pk$/i, /\.ae$/i, /\.sa$/i, /\.il$/i, /\.tr$/i,
  /\.ru$/i, /\.ua$/i, /\.za$/i, /\.eg$/i, /\.ng$/i, /\.ke$/i,
];

function isUSDomain(domain: string | null): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase().replace(/^www\./, "");
  // Reject any non-US country TLD
  for (const re of NON_US_TLD_PATTERNS) {
    if (re.test(d)) return false;
  }
  return true;
}

// URL patterns that indicate non-product pages (search/category/blog)
const NON_PRODUCT_PATTERNS = [
  /\/search\b/i, /\/category\//i, /\/categories\//i, /\/c\//i,
  /\/blog\//i, /\/news\//i, /\/help\//i, /\/support\//i,
  /\/faq\b/i, /\?q=/i, /\?search=/i, /\/shop\/?$/i, /\/store\/?$/i,
];

function normalizeDomain(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const stripParams = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "ref", "ref_", "tag"];
    stripParams.forEach((p) => u.searchParams.delete(p));
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

function isLikelyProductPage(url: string): boolean {
  for (const pattern of NON_PRODUCT_PATTERNS) {
    if (pattern.test(url)) return false;
  }
  return true;
}

// ─── Identity-aware penalties (mirrors shared.tsx matchPenalties) ───
const PACK_RE = /(\d+)\s*[- ]?\s*(?:pack|pk|count|ct|pc|pieces?)\b/i;
const SIZE_TOKENS = [
  "xx-small","xx small","xxs","x-small","x small","xs",
  "small","medium","large","x-large","x large","xl",
  "xx-large","xx large","xxl","xxxl","3xl","4xl",
];

function extractPackCount(text: string): number | null {
  const m = (text || "").match(PACK_RE);
  return m ? parseInt(m[1], 10) : null;
}

function extractSizeToken(text: string): string | null {
  const lower = (text || "").toLowerCase();
  for (const t of SIZE_TOKENS) {
    const re = new RegExp(`\\b${t.replace(/[-\s]/g, "[\\s-]?")}\\b`, "i");
    if (re.test(lower)) return t.replace(/[-\s]/g, "");
  }
  return null;
}

function tokenize(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hits = 0;
  for (const t of ta) if (tb.has(t)) hits++;
  return hits / ta.size;
}

interface Identity {
  asin: string;
  title?: string | null;
  brand?: string | null;
  model?: string | null;
  upc?: string | null;
}

interface RawCandidate {
  url: string;
  title: string;
  snippet: string;
}

async function googleSearch(query: string, num = 10): Promise<RawCandidate[]> {
  const apiKey = Deno.env.get("GOOGLE_API_KEY");
  const cx = Deno.env.get("GOOGLE_CX_ID");
  if (!apiKey || !cx) return [];

  // gl=us, cr=countryUS, lr=lang_en — restrict to US storefronts in English
  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&num=${num}&gl=us&cr=countryUS&lr=lang_en&hl=en`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      console.warn("Google CSE non-OK:", r.status);
      return [];
    }
    const j = await r.json();
    const items = Array.isArray(j.items) ? j.items : [];
    return items.map((it: any) => ({
      url: it.link || "",
      title: it.title || "",
      snippet: it.snippet || "",
    })).filter((c: RawCandidate) => c.url);
  } catch (e) {
    console.warn("Google CSE error:", e instanceof Error ? (e as Error).message : e);
    return [];
  }
}

async function serpApiSearch(query: string, num = 10): Promise<RawCandidate[]> {
  const apiKey = Deno.env.get("SERPAPI_API_KEY");
  if (!apiKey) return [];

  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&num=${num}&api_key=${apiKey}&engine=google&gl=us&hl=en&google_domain=google.com&location=United+States`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      console.warn("SerpAPI non-OK:", r.status);
      return [];
    }
    const j = await r.json();
    const items = Array.isArray(j.organic_results) ? j.organic_results : [];
    return items.map((it: any) => ({
      url: it.link || "",
      title: it.title || "",
      snippet: it.snippet || "",
    })).filter((c: RawCandidate) => c.url);
  } catch (e) {
    console.warn("SerpAPI error:", e instanceof Error ? (e as Error).message : e);
    return [];
  }
}

async function searchAll(query: string, num = 10): Promise<RawCandidate[]> {
  let results = await googleSearch(query, num);
  if (results.length === 0) {
    results = await serpApiSearch(query, num);
  }
  return results;
}

// Extract model-number-like tokens from a title (e.g. "G550-5600-W1", "ABC123")
function extractModelTokensFromTitle(title: string | null | undefined): string[] {
  if (!title) return [];
  const tokens = title.match(/\b[A-Z0-9][A-Z0-9-]{4,}[A-Z0-9]\b/gi) || [];
  const scored = tokens
    .map((t) => t.trim())
    .filter((t) => /\d/.test(t) && t.length >= 5 && t.length <= 30)
    .filter((t, i, arr) => arr.indexOf(t) === i);
  return scored.slice(0, 3);
}

// Normalize a model number: strip non-alphanumerics, uppercase
function normalizeModel(model: string | null | undefined): string {
  if (!model) return "";
  return model.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Strip trailing single-letter revision suffix (e.g. W1A → W1)
function stripRevisionSuffix(normalized: string): string {
  if (normalized.length > 4 && /[A-Z]\d[A-Z]$/.test(normalized)) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

// Generate model variations for searching: original, no-separators, hyphenated, no-suffix, spaced
function buildModelVariations(model: string): string[] {
  if (!model) return [];
  const variations = new Set<string>();
  const norm = normalizeModel(model);
  if (!norm) return [];
  variations.add(model);
  variations.add(norm);
  const hyphenated = norm.replace(/([A-Z]+)(\d+)/g, "$1-$2").replace(/(\d+)([A-Z]+)/g, "$1-$2");
  if (hyphenated !== norm) variations.add(hyphenated);
  const stripped = stripRevisionSuffix(norm);
  if (stripped !== norm) variations.add(stripped);
  const spaced = norm.replace(/([A-Z]+)(\d+)/g, "$1 $2").replace(/(\d+)([A-Z]+)/g, "$1 $2");
  if (spaced !== norm) variations.add(spaced);
  return Array.from(variations).filter((v) => v.length >= 3);
}

// Score how well a candidate text matches a model number (0-100)
// Handles prefix matches (W1 ↔ W1A), variations, and partial token overlap
function modelMatchStrength(candidateText: string, model: string): {
  strength: number;
  type: "exact" | "normalized" | "prefix" | "partial" | "none";
} {
  if (!model || !candidateText) return { strength: 0, type: "none" };
  const candNorm = normalizeModel(candidateText);
  const modelNorm = normalizeModel(model);
  if (!candNorm || !modelNorm) return { strength: 0, type: "none" };

  if (candNorm.includes(modelNorm)) return { strength: 100, type: "exact" };

  // Prefix match — handles W1 ↔ W1A by stripping our trailing revision letter
  const modelStripped = stripRevisionSuffix(modelNorm);
  if (modelStripped !== modelNorm && modelStripped.length >= 5 && candNorm.includes(modelStripped)) {
    return { strength: 85, type: "prefix" };
  }
  if (modelStripped.length >= 5 && candNorm.indexOf(modelStripped) >= 0) {
    return { strength: 80, type: "prefix" };
  }
  // Reverse: candidate may use a stripped form (model=G..W1A, page has G..W1)
  for (let cut = 1; cut <= 2; cut++) {
    const reduced = modelNorm.slice(0, modelNorm.length - cut);
    if (reduced.length >= 6 && candNorm.includes(reduced)) {
      return { strength: 75, type: "prefix" };
    }
  }

  // Partial: token-based overlap on model parts (split by digit↔letter transitions)
  const modelParts = modelNorm.match(/[A-Z]+|\d+/g) || [];
  const significantParts = modelParts.filter((p) => p.length >= 2);
  if (significantParts.length === 0) return { strength: 0, type: "none" };
  const hits = significantParts.filter((p) => candNorm.includes(p)).length;
  const ratio = hits / significantParts.length;
  if (ratio >= 0.66) return { strength: Math.round(60 * ratio), type: "partial" };

  return { strength: 0, type: "none" };
}

function buildQueries(identity: Identity): string[] {
  const queries: string[] = [];
  // Exclude Amazon entirely (any TLD) plus major non-US storefronts at the query
  // level so Google doesn't even surface them — saves CSE quota and keeps results
  // US-only. `-inurl:amazon.` catches every amazon.<tld> we don't list explicitly.
  const exclusions = "-site:amazon.com -site:amazon.co.uk -site:amazon.de -site:amazon.fr -site:amazon.it -site:amazon.es -site:amazon.ca -site:amazon.com.mx -site:amazon.com.br -site:amazon.co.jp -site:amazon.in -site:amazon.com.au -site:amazon.sg -site:amazon.ae -site:amazon.sa -site:amazon.com.tr -site:amazon.nl -site:amazon.pl -site:amazon.se -site:amazon.cn -site:amzn.to -site:a.co -inurl:amazon. -site:ebay.com -site:aliexpress.com -site:alibaba.com -site:wish.com";

  if (identity.upc) {
    queries.push(`"${identity.upc}" ${exclusions}`);
  }
  if (identity.brand && identity.model) {
    queries.push(`"${identity.brand}" "${identity.model}" ${exclusions}`);
  }

  const modelTokens = extractModelTokensFromTitle(identity.title);
  for (const tok of modelTokens) {
    if (identity.model && tok.toLowerCase() === identity.model.toLowerCase()) continue;
    queries.push(`"${tok}" ${exclusions}`);
  }

  if (identity.title) {
    const cleanTitle = identity.title.length > 100 ? identity.title.slice(0, 100) : identity.title;
    queries.push(`"${cleanTitle}" ${exclusions}`);
    queries.push(`${cleanTitle} buy ${exclusions}`);
  }

  // Broadcast probe: actively ask Google to look ACROSS our expanded US-retailer
  // catalog using `site:a OR site:b ...` — this surfaces candidates from retailers
  // Google would otherwise hide behind Amazon/eBay results.
  const broadcastDomains = [
    "walmart.com", "target.com", "bestbuy.com", "homedepot.com", "lowes.com",
    "kohls.com", "macys.com", "staples.com", "officedepot.com", "wayfair.com",
    "newegg.com", "bhphotovideo.com", "adorama.com", "overstock.com",
    "michaels.com", "joann.com", "hobbylobby.com", "petco.com", "petsmart.com",
    "chewy.com", "tractorsupply.com", "acehardware.com", "harborfreight.com",
    "northerntool.com", "zoro.com", "grainger.com",
    "ulta.com", "sephora.com", "walgreens.com", "cvs.com",
    "dickssportinggoods.com", "academy.com", "rei.com", "basspro.com",
    "barnesandnoble.com", "thriftbooks.com",
    "autozone.com", "advanceautoparts.com", "oreillyauto.com",
    "vitacost.com", "iherb.com", "gnc.com", "vitaminshoppe.com",
    "containerstore.com", "qvc.com", "hsn.com", "abt.com", "crutchfield.com",
  ];
  const broadcast = broadcastDomains.map((d) => `site:${d}`).join(" OR ");
  if (identity.upc) {
    queries.push(`"${identity.upc}" (${broadcast})`);
  } else if (identity.brand && identity.model) {
    queries.push(`"${identity.brand}" "${identity.model}" (${broadcast})`);
  } else if (identity.title) {
    const cleanTitle = identity.title.length > 80 ? identity.title.slice(0, 80) : identity.title;
    queries.push(`${cleanTitle} (${broadcast})`);
  }

  return queries;
}

// Build supplier-biased queries using model variations (handles W1 vs W1A, separator
// differences). Supplier-FIRST discovery — we actively probe known suppliers even
// when Google does not surface them for the original keyword query.
function buildSupplierBiasedQueries(identity: Identity, supplierDomains: string[]): string[] {
  if (supplierDomains.length === 0) return [];

  const modelTokens = extractModelTokensFromTitle(identity.title);
  const primaryModel = identity.model || modelTokens[0] || null;
  const modelVariations = primaryModel ? buildModelVariations(primaryModel) : [];
  const cleanTitle = identity.title
    ? (identity.title.length > 80 ? identity.title.slice(0, 80) : identity.title)
    : null;

  const queries: string[] = [];
  const domains = supplierDomains.slice(0, 25);

  for (const dom of domains) {
    if (identity.upc) {
      queries.push(`site:${dom} "${identity.upc}"`);
      continue;
    }
    if (modelVariations.length > 0) {
      // Probe up to 2 variations per supplier (cost control).
      // First: brand + primary model. Second: a different variation (catches W1A vs W1).
      const primary = modelVariations[0];
      if (identity.brand) {
        queries.push(`site:${dom} "${identity.brand}" "${primary}"`);
      } else {
        queries.push(`site:${dom} "${primary}"`);
      }
      if (modelVariations.length > 1) {
        queries.push(`site:${dom} "${modelVariations[1]}"`);
      }
      continue;
    }
    if (cleanTitle) {
      queries.push(`site:${dom} ${cleanTitle}`);
    }
  }
  return queries;
}

// Returns ONLY trusted supplier domains — used to drive site: search queries (cost control).
async function fetchSupplierDomains(supabase: any, userId: string): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from("suppliers")
      .select("domain")
      .eq("user_id", userId)
      .eq("trust_level", "trusted")
      .not("domain", "is", null);
    if (error) {
      console.warn("suppliers lookup failed:", (error as Error).message);
      return [];
    }
    if (!Array.isArray(data)) return [];
    return data
      .map((r: any) => (r.domain || "").toLowerCase().trim())
      .filter((d: string) => d.length > 0)
      .filter((d: string, i: number, arr: string[]) => arr.indexOf(d) === i);
  } catch (e) {
    console.warn("fetchSupplierDomains error:", e instanceof Error ? (e as Error).message : e);
    return [];
  }
}

// Returns ALL supplier domains (any trust level) — used only for the registry-match scoring boost.
async function fetchAllSupplierDomains(supabase: any, userId: string): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from("suppliers")
      .select("domain")
      .eq("user_id", userId)
      .not("domain", "is", null);
    if (error || !Array.isArray(data)) return [];
    return data
      .map((r: any) => (r.domain || "").toLowerCase().trim())
      .filter((d: string) => d.length > 0)
      .filter((d: string, i: number, arr: string[]) => arr.indexOf(d) === i);
  } catch {
    return [];
  }
}

function scoreCandidate(c: RawCandidate, identity: Identity): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];

  const haystack = `${c.title} ${c.snippet} ${c.url}`.toLowerCase();
  const candText = `${c.title} ${c.snippet}`;

  // UPC exact match — highest signal
  if (identity.upc && haystack.includes(identity.upc.toLowerCase())) {
    score += 50;
    reasons.push("UPC match");
  }

  // Brand
  let hasBrand = false;
  if (identity.brand) {
    const brandFirst = identity.brand.toLowerCase().split(/\s+/)[0];
    if (brandFirst.length >= 3 && haystack.includes(brandFirst)) {
      score += 15;
      reasons.push("brand");
      hasBrand = true;
    }
  }

  // Model match — use fuzzy/prefix/variation-aware matching
  // Check identity.model and any model-like tokens extracted from title
  const modelCandidates: string[] = [];
  if (identity.model) modelCandidates.push(identity.model);
  for (const tok of extractModelTokensFromTitle(identity.title)) {
    if (!modelCandidates.includes(tok)) modelCandidates.push(tok);
  }
  let bestModel: { strength: number; type: string } = { strength: 0, type: "none" };
  for (const m of modelCandidates) {
    const r = modelMatchStrength(`${c.title} ${c.snippet} ${c.url}`, m);
    if (r.strength > bestModel.strength) bestModel = r;
  }
  if (bestModel.strength > 0) {
    // Model is the strongest identity signal — weight it heavily
    // exact=35, prefix=28, partial=up to 18
    const modelBonus = Math.round((bestModel.strength / 100) * 35);
    score += modelBonus;
    reasons.push(`model ${bestModel.type} (${bestModel.strength})`);
  }

  // Title token overlap (lower weight since model is now stronger)
  if (identity.title) {
    const overlap = tokenOverlap(identity.title, c.title);
    const overlapScore = Math.round(overlap * 25);
    if (overlapScore > 0) {
      score += overlapScore;
      reasons.push(`${Math.round(overlap * 100)}% overlap`);
    }
  }

  // Domain tier scoring
  const domain = normalizeDomain(c.url);
  const tier = domainTier(domain);
  if (tier === 1) { score += 20; reasons.push("tier-1 retailer"); }
  else if (tier === 2) { score += 8; }
  else if (tier === 3) { score -= 20; reasons.push("aggregator penalty"); }
  else if (tier === 4) { score -= 50; reasons.push("social/unknown penalty"); }

  if (isMembership(domain)) {
    score -= 15;
    reasons.push("membership-only");
  }

  // Brand penalty — reduced (or skipped) when model match is strong.
  // Real-world supplier pages often omit brand for parts/replacements.
  if (identity.brand && !hasBrand) {
    if (bestModel.strength >= 75) {
      // Strong model match overrides missing brand — no penalty
      reasons.push("brand missing (model strong)");
    } else if (bestModel.strength >= 50) {
      score -= 5;
      reasons.push("brand missing (model partial)");
    } else {
      score -= 15;
      reasons.push("missing brand");
    }
  }

  // Pack-count mismatch
  const idPack = extractPackCount(identity.title || "");
  const cPack = extractPackCount(candText);
  if (idPack && cPack && idPack !== cPack) {
    score -= 25;
    reasons.push(`pack mismatch ${cPack}≠${idPack}`);
  } else if (idPack && cPack == null) {
    score -= 10;
    reasons.push(`pack ${idPack} not confirmed`);
  }

  // Size-variation mismatch
  const idSize = extractSizeToken(identity.title || "");
  const cSize = extractSizeToken(candText);
  if (idSize && cSize && idSize !== cSize) {
    score -= 20;
    reasons.push(`size mismatch ${cSize}≠${idSize}`);
  } else if (idSize && cSize == null) {
    score -= 8;
    reasons.push(`size ${idSize} not confirmed`);
  }

  if (score < 0) score = 0;
  if (score > 100) score = 100;

  return { score, reason: reasons.join(" · ") || "weak match" };
}

async function fetchIdentity(supabase: any, userId: string, asin: string, overrides: Partial<Identity>): Promise<Identity> {
  const identity: Identity = {
    asin,
    title: overrides.title ?? null,
    brand: overrides.brand ?? null,
    model: overrides.model ?? null,
    upc: overrides.upc ?? null,
  };

  // Pull from keepa_products (no user filter — shared catalog)
  if (!identity.title || !identity.brand) {
    try {
      const { data } = await supabase
        .from("keepa_products")
        .select("title, brand, manufacturer")
        .eq("asin", asin)
        .maybeSingle();
      if (data) {
        identity.title = identity.title || data.title;
        identity.brand = identity.brand || data.brand || data.manufacturer;
      }
    } catch (e) {
      console.warn("keepa_products lookup failed:", e instanceof Error ? (e as Error).message : e);
    }
  }

  // Pull from inventory (user-scoped)
  if (!identity.title) {
    try {
      const { data } = await supabase
        .from("inventory")
        .select("title")
        .eq("user_id", userId)
        .eq("asin", asin)
        .limit(1)
        .maybeSingle();
      if (data?.title) identity.title = data.title;
    } catch (e) {
      console.warn("inventory lookup failed:", e instanceof Error ? (e as Error).message : e);
    }
  }

  // Pull from created_listings (user-scoped)
  if (!identity.title) {
    try {
      const { data } = await supabase
        .from("created_listings")
        .select("title")
        .eq("user_id", userId)
        .eq("asin", asin)
        .limit(1)
        .maybeSingle();
      if (data?.title) identity.title = data.title;
    } catch (e) {
      console.warn("created_listings lookup failed:", e instanceof Error ? (e as Error).message : e);
    }
  }

  return identity;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Missing auth" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify user
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Invalid auth" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    // Service-role client for writes
    const supabase = createClient(supabaseUrl, serviceKey);

    // MODULE ACCESS GUARD: supplier_discovery:run is required (admin bypasses).
    const access = await checkModuleAccess(supabase, userId, "supplier_discovery", "run");
    if (!access.allowed) {
      console.warn(`[discover-source-candidates] BLOCKED user=${userId} reason=${access.reason}`);
      return new Response(JSON.stringify({ error: access.reason || "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const asin: string = (body.asin || "").trim().toUpperCase();
    const overrides: Partial<Identity> = body.identity_overrides || {};
    const autoExtract: boolean = body.auto_extract !== false;
    const autoExtractLimit: number = Math.min(Math.max(body.auto_extract_limit || 3, 1), 20);
    // Cost-saving inputs forwarded to auto-extract
    const minRoiPct: number | null =
      typeof body.min_roi_pct === "number" && body.min_roi_pct > 0 ? body.min_roi_pct : null;
    const amazonPriceHint: number | null =
      typeof body.amazon_price === "number" && body.amazon_price > 0 ? body.amazon_price : null;
    // STRICT: when true, only crawl/score domains that exist in the user's supplier registry.
    // Generic Google queries are skipped; post-filter drops anything outside the registry.
    const trustedOnlyRaw: boolean = body.trusted_only === true;
    // Optional explicit subset of supplier domains the user picked from the UI dropdown.
    // When provided (non-empty), we lock the search to ONLY these domains, regardless of
    // their trust_level. This implies trusted_only behavior (no generic crawl).
    const selectedSupplierDomainsInput: string[] = Array.isArray(body.selected_supplier_domains)
      ? (body.selected_supplier_domains as unknown[])
          .map((d) => (typeof d === "string" ? normalizeDomain(d) || "" : ""))
          .filter((d) => d.length > 0)
      : [];
    const hasExplicitSupplierSelection = selectedSupplierDomainsInput.length > 0;
    const trustedOnly: boolean = trustedOnlyRaw || hasExplicitSupplierSelection;

    if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
      return new Response(JSON.stringify({ error: "Invalid ASIN" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve identity
    const identity = await fetchIdentity(supabase, userId, asin, overrides);
    if (!identity.title && !identity.upc) {
      return new Response(
        JSON.stringify({ error: "Could not resolve product identity. Please provide a title or UPC." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Create run
    const { data: run, error: runErr } = await supabase
      .from("source_discovery_runs")
      .insert({
        user_id: userId,
        asin,
        amazon_title: identity.title,
        brand: identity.brand,
        model_number: identity.model,
        upc: identity.upc,
        run_type: "retail",
        status: "discovering",
      })
      .select()
      .single();

    if (runErr || !run) {
      console.error("Failed to create run:", runErr);
      return new Response(JSON.stringify({ error: "Failed to create run" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch user's supplier registry. We split it:
    //  - trusted-only domains drive site: search queries (cost control)
    //  - all domains drive the registry-match scoring boost (recognition)
    const [trustedDomainsAll, allDomainsAll] = await Promise.all([
      fetchSupplierDomains(supabase, userId),
      fetchAllSupplierDomains(supabase, userId),
    ]);

    // If the user explicitly selected a subset in the UI dropdown, narrow BOTH sets
    // to that selection (intersection with their registry). This guarantees we only
    // probe and accept the chosen suppliers.
    let trustedDomains = trustedDomainsAll;
    let allDomains = allDomainsAll;
    if (hasExplicitSupplierSelection) {
      const selectedSet = new Set(selectedSupplierDomainsInput);
      const registrySet = new Set(allDomainsAll);
      // Only keep selections that exist in the user's registry (defense in depth)
      const intersected = [...selectedSet].filter((d) => registrySet.has(d));
      trustedDomains = intersected;
      allDomains = intersected;
    }
    const supplierDomainSet = new Set(allDomains);

    // Build & run queries.
    //  - Default mode: generic queries + trusted-supplier site: queries
    //  - trusted_only mode: ONLY supplier site: queries (no generic crawl) → registry-locked
    const supplierQueries = buildSupplierBiasedQueries(identity, trustedDomains);
    const baseQueries = trustedOnly ? [] : buildQueries(identity);
    const queries = [...baseQueries, ...supplierQueries];
    console.log(
      `[discover] run=${run.id} asin=${asin} trustedOnly=${trustedOnly} explicitSelection=${hasExplicitSupplierSelection} base=${baseQueries.length} supplier=${supplierQueries.length} trusted=${trustedDomains.length} totalRegistry=${allDomains.length}`,
    );

    if (trustedOnly && supplierQueries.length === 0) {
      console.warn(`[discover] run=${run.id} trusted_only=true but no eligible suppliers — no candidates will be returned`);
    }

    const allResults: RawCandidate[] = [];
    for (const q of queries) {
      const r = await searchAll(q, 10);
      allResults.push(...r);
    }

    // Dedupe by normalized URL, filter excluded domains and non-product pages
    const seen = new Set<string>();
    const filtered: RawCandidate[] = [];
    for (const r of allResults) {
      const norm = normalizeUrl(r.url);
      const dom = normalizeDomain(norm);
      if (!dom) continue;
      if (EXCLUDED_DOMAINS.has(dom)) continue;
      // Universal Amazon block: any TLD, any subdomain (amazon.sg, m.amazon.de, a.co, amzn.to, …)
      if (isAmazonDomain(dom)) continue;
      // US-only enforcement: drop any non-US country-TLD storefront
      if (!isUSDomain(dom)) continue;
      // STRICT registry lock: in trusted_only mode, the domain MUST be in the user's
      // supplier registry. This catches Google's "related results" leakage where the
      // search engine returns matches outside the requested site: filter.
      if (trustedOnly && !supplierDomainSet.has(dom)) continue;
      if (!isLikelyProductPage(norm)) continue;
      if (seen.has(norm)) continue;
      seen.add(norm);
      filtered.push({ ...r, url: norm });
    }

    // Score & sort — apply registry boost so known suppliers rank above generic results
    const scored = filtered.map((c) => {
      const { score, reason } = scoreCandidate(c, identity);
      const dom = normalizeDomain(c.url) || "";
      let finalScore = score;
      let finalReason = reason;
      if (supplierDomainSet.has(dom)) {
        finalScore = Math.min(100, score + 25);
        finalReason = (reason ? reason + " · " : "") + "registry supplier";
      }
      return { ...c, score: finalScore, reason: finalReason };
    });
    scored.sort((a, b) => b.score - a.score);

    // Insert candidates
    const rowsToInsert = scored.slice(0, 50).map((c) => ({
      run_id: run.id,
      user_id: userId,
      asin,
      source_url: c.url,
      domain: normalizeDomain(c.url),
      source_type: "retail",
      source_title: c.title.slice(0, 500),
      source_snippet: c.snippet.slice(0, 1000),
      match_score: c.score,
      match_reason: c.reason,
    }));

    if (rowsToInsert.length > 0) {
      const { error: insErr } = await supabase.from("source_candidates").insert(rowsToInsert);
      if (insErr) {
        console.error("Insert candidates error:", insErr);
      }
    }

    // Update run summary
    await supabase
      .from("source_discovery_runs")
      .update({
        total_candidates: rowsToInsert.length,
        status: rowsToInsert.length === 0 ? "completed" : (autoExtract ? "extracting" : "completed"),
      })
      .eq("id", run.id);

    // Fire-and-forget auto-extract for the top N
    if (autoExtract && rowsToInsert.length > 0) {
      const fnUrl = `${supabaseUrl}/functions/v1/auto-extract-top-candidates`;
      // Don't await; let it run in background
      fetch(fnUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          run_id: run.id,
          limit: autoExtractLimit,
          min_roi_pct: minRoiPct,
          amazon_price: amazonPriceHint,
        }),
      }).catch((e) => console.warn("auto-extract trigger failed:", e));
    }

    return new Response(
      JSON.stringify({
        run_id: run.id,
        asin,
        identity,
        total_candidates: rowsToInsert.length,
        auto_extract: autoExtract && rowsToInsert.length > 0,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? (e as Error).message : String(e);
    console.error("discover-source-candidates error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
