// Universal Product Price Extractor — Phase 1 + AI fallback (hardened v2)
// Layered pipeline: JSON-LD → microdata → meta tags → CSS selectors → embedded hydration → AI fallback
// Returns structured price data with extraction method + confidence score + needs_review flag.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkModuleAccess } from "../_shared/module-access-guard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Phase status values (granular for trust + observability)
type PhaseStatus =
  | "success"
  | "blocked"            // anti-bot/captcha challenge
  | "no_price_found"     // page accessible but no price extracted
  | "timeout"            // upstream/render timed out
  | "render_failed"      // browser-render provider HTTP/network failure
  | "extract_failed"     // browser rendered but extraction layers couldn't find price
  | "skipped"            // skipped (e.g. policy disallowed or non-product page)
  | "not_run"            // never attempted
  | "error";             // generic/unknown failure (kept for back-compat)

// Final access-strategy resolution (separate from extraction success)
type FinalResolution =
  | "price_extracted"
  | "blocked_phase1"        // P1 blocked, P2 not attempted
  | "blocked_phase2"        // P1 blocked, P2 also blocked
  | "blocked_all_phases"    // alias used when both clearly blocked
  | "phase2_timeout"        // P2 escalated but provider timed out
  | "phase2_render_failed"  // P2 escalated but provider returned non-2xx / network failure
  | "phase2_extract_failed" // P2 rendered successfully but extraction failed
  | "not_found_unblocked"   // page accessible but no price found
  | "non_product_page"
  | "fetch_error";

interface ExtractionResult {
  url: string;
  domain: string | null;
  title: string | null;
  price_current: number | null;
  price_original: number | null;
  currency: string | null;
  availability: string | null;
  // Normalized stock state — single canonical enum the rest of the system
  // can rely on (filtering, badges, admin counts). Raw `availability` text is
  // kept for debugging.
  availability_status: "in_stock" | "out_of_stock" | "preorder" | "backorder" | "unknown";
  image_url: string | null;
  variant: string | null;
  extraction_method: string;
  confidence_score: number;
  raw_price_text: string | null;
  raw_payload: Record<string, unknown> | null;
  error: string | null;
  // ── New trust-layer fields (returned to client; not all persisted)
  needs_review?: boolean;
  review_reasons?: string[];
  page_type?: "product" | "search" | "category" | "cart" | "home" | "unknown";
  cached?: boolean;
  debug?: Record<string, unknown>;
  // ── Access-strategy fields ──
  phase1_status?: PhaseStatus;
  phase2_status?: PhaseStatus;
  block_provider?: string | null; // e.g. "perimeterx", "datadome", "cloudflare", "walmart_press_and_hold"
  final_resolution?: FinalResolution;
  domain_policy?: string;         // policy name applied
  cache_ttl_hours?: number;       // ttl for this result
}

// ── Domain access policies ──
// Defines escalation behaviour and cache TTLs per domain class.
interface DomainPolicy {
  name: string;
  try_phase2: boolean;         // attempt browser rendering on P1 failure/block
  phase2_only_if_blocked: boolean; // skip P2 if P1 simply found no price (don't waste credits)
  blocked_cache_ttl_hours: number;
  success_cache_ttl_hours: number;
}

const DEFAULT_POLICY: DomainPolicy = {
  name: "default",
  try_phase2: false,            // by default static-first only
  phase2_only_if_blocked: true,
  blocked_cache_ttl_hours: 1,
  success_cache_ttl_hours: 24,
};

const DOMAIN_POLICIES: Array<{ match: (d: string) => boolean; policy: DomainPolicy }> = [
  {
    // Walmart: high-friction, allow P2 escalation but cache blocks short
    match: (d) => d.includes("walmart"),
    policy: {
      name: "walmart",
      try_phase2: true,
      phase2_only_if_blocked: false,
      blocked_cache_ttl_hours: 2,
      success_cache_ttl_hours: 24,
    },
  },
  {
    // Other high-friction US retailers
    match: (d) => /target\.com|bestbuy\.com|homedepot\.com|lowes\.com|walgreens\.com|cvs\.com/.test(d),
    policy: {
      name: "us_retailer_high_friction",
      try_phase2: true,
      phase2_only_if_blocked: false,
      blocked_cache_ttl_hours: 2,
      success_cache_ttl_hours: 24,
    },
  },
  {
    // Shopify-like / generic e-commerce: P1 should usually work, escalate only on blocks
    match: (d) => /shopify\.com|myshopify|shop\./.test(d),
    policy: {
      name: "shopify",
      try_phase2: true,
      phase2_only_if_blocked: true,
      blocked_cache_ttl_hours: 1,
      success_cache_ttl_hours: 24,
    },
  },
];

function getDomainPolicy(domain: string | null): DomainPolicy {
  if (!domain) return DEFAULT_POLICY;
  const d = domain.toLowerCase();
  for (const { match, policy } of DOMAIN_POLICIES) {
    if (match(d)) return policy;
  }
  return DEFAULT_POLICY;
}

// ── Currency normalization ──────────────────────────────────────────
const CURRENCY_SYMBOL_MAP: Record<string, string> = {
  "$": "USD", "US$": "USD", "USD": "USD",
  "€": "EUR", "EUR": "EUR",
  "£": "GBP", "GBP": "GBP",
  "¥": "JPY", "JPY": "JPY",
  "₹": "INR", "INR": "INR",
  "C$": "CAD", "CA$": "CAD", "CAD": "CAD",
  "A$": "AUD", "AU$": "AUD", "AUD": "AUD",
  "MX$": "MXN", "MXN": "MXN",
  "R$": "BRL", "BRL": "BRL",
};

function detectCurrency(text: string): string | null {
  const upper = text.toUpperCase();
  for (const [sym, code] of Object.entries(CURRENCY_SYMBOL_MAP)) {
    if (upper.includes(sym.toUpperCase())) return code;
  }
  const match = upper.match(/\b(USD|EUR|GBP|JPY|CAD|AUD|MXN|BRL|INR|CHF|CNY|HKD)\b/);
  return match ? match[1] : null;
}

// Domain → likely currency hint (used to flag mismatch)
function expectedCurrencyForDomain(domain: string | null): string | null {
  if (!domain) return null;
  const d = domain.toLowerCase();
  if (/\.com$|\.us$/.test(d) || d.includes("walmart") || d.includes("target") || d.includes("bestbuy") || d.includes("homedepot") || d.includes("walgreens")) return "USD";
  if (/\.co\.uk$|\.uk$/.test(d)) return "GBP";
  if (/\.de$|\.fr$|\.it$|\.es$|\.nl$|\.eu$/.test(d)) return "EUR";
  if (/\.ca$/.test(d)) return "CAD";
  if (/\.com\.mx$|\.mx$/.test(d)) return "MXN";
  if (/\.com\.br$|\.br$/.test(d)) return "BRL";
  if (/\.com\.au$|\.au$/.test(d)) return "AUD";
  if (/\.co\.jp$|\.jp$/.test(d)) return "JPY";
  return null;
}

// Parse "24.99", "24,99", "$1,299.00", "1.299,00 €" → number
function parsePriceNumber(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") return isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s) return null;

  s = s.replace(/[^\d.,\-]/g, "");
  if (!s) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");

  if (lastComma > lastDot && lastComma !== -1) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }

  const n = parseFloat(s);
  if (!isFinite(n) || n <= 0 || n > 1_000_000) return null;
  return Math.round(n * 100) / 100;
}

function getDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// ── Bot-challenge / anti-scrape detection ──
function detectBotChallenge(html: string): { blocked: boolean; signal: string | null } {
  if (!html || html.length < 500) return { blocked: true, signal: "empty_or_tiny_response" };
  const lower = html.toLowerCase();
  const signals: Array<[RegExp, string]> = [
    [/robot or human\??/i, "walmart_press_and_hold"],
    [/press\s*&\s*hold|press and hold/i, "press_and_hold_captcha"],
    [/are you a robot/i, "generic_robot_check"],
    [/access denied/i, "access_denied"],
    [/captcha-delivery|geo\.captcha/i, "datadome_captcha"],
    [/<title[^>]*>\s*(just a moment|attention required)\s*[\.…]*\s*<\/title>/i, "cloudflare_challenge"],
    [/cf-browser-verification|cf-challenge/i, "cloudflare_jschallenge"],
    [/px-captcha|perimeterx/i, "perimeterx"],
    [/distil_r_captcha|distilnetworks/i, "distil_networks"],
    [/please verify you are a human/i, "generic_human_verify"],
  ];
  for (const [re, sig] of signals) {
    if (re.test(html)) return { blocked: true, signal: sig };
  }
  // Walmart-specific: blocked pages are usually <2KB and contain "blocked"
  if (lower.includes("walmart") && html.length < 4000 && /blocked|verify/.test(lower)) {
    return { blocked: true, signal: "walmart_short_block_page" };
  }
  return { blocked: false, signal: null };
}

// ── Product-page heuristic ──
function detectPageType(html: string, url: string): "product" | "search" | "category" | "cart" | "home" | "unknown" {
  const u = url.toLowerCase();
  if (/[?&](q|query|search|s)=/.test(u) || /\/search(\b|\/|\?)/.test(u)) return "search";
  if (/\/cart(\b|\/|\?)|\/checkout(\b|\/|\?)/.test(u)) return "cart";
  if (/\/(category|categories|c|browse|shop|department)\//.test(u)) return "category";

  const lower = html.toLowerCase();
  // Strong product signals
  const productSignals =
    /"@type"\s*:\s*"product"/i.test(html) ||
    /property=["']og:type["'][^>]+content=["']product["']/i.test(html) ||
    /<meta[^>]+property=["']product:price:amount["']/i.test(html) ||
    /itemtype=["'][^"']*schema\.org\/product["']/i.test(html);
  if (productSignals) return "product";

  // Search-result signals
  if (
    /search results for/i.test(lower) ||
    /<title[^>]*>[^<]*search[^<]*<\/title>/i.test(html) ||
    /class=["'][^"']*search-results[^"']*["']/i.test(html)
  ) return "search";

  // Try URL path heuristic for product
  if (/\/(product|p|dp|item|prod|products)\//.test(u) || /\/[^/]+-p-?\d+/.test(u)) return "product";

  return "unknown";
}

// ── Layer 1: JSON-LD structured data ────────────────────────────────
function extractJsonLd(html: string): Partial<ExtractionResult> | null {
  const blocks: any[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const text = m[1].trim().replace(/[\u0000-\u001F]+/g, " ");
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else blocks.push(parsed);
    } catch { /* skip malformed */ }
  }

  if (blocks.length === 0) return null;

  const flat: any[] = [];
  for (const b of blocks) {
    if (b && typeof b === "object" && Array.isArray(b["@graph"])) flat.push(...b["@graph"]);
    else flat.push(b);
  }

  for (const node of flat) {
    if (!node || typeof node !== "object") continue;
    const type = node["@type"];
    const isProduct =
      type === "Product" ||
      (Array.isArray(type) && type.includes("Product")) ||
      node.offers != null;

    if (!isProduct) continue;

    let offer = node.offers;
    if (Array.isArray(offer)) offer = offer[0];
    if (!offer) continue;

    // Prefer explicit current price; aggregate offers get a confidence penalty
    const isAggregate = offer["@type"] === "AggregateOffer" || offer.lowPrice != null;
    const priceRaw = offer.price ?? offer.lowPrice ?? offer.highPrice;
    const price = parsePriceNumber(priceRaw);
    if (!price) continue;

    // List/original price detection
    let originalPrice: number | null = null;
    const ps = offer.priceSpecification;
    if (Array.isArray(ps)) {
      for (const sp of ps) {
        if (typeof sp?.priceType === "string" && /list/i.test(sp.priceType)) {
          originalPrice = parsePriceNumber(sp.price);
        }
      }
    } else if (ps && typeof ps === "object") {
      if (typeof ps.priceType === "string" && /list/i.test(ps.priceType)) {
        originalPrice = parsePriceNumber(ps.price);
      }
    }

    return {
      title: typeof node.name === "string" ? node.name : null,
      price_current: price,
      price_original: originalPrice,
      currency: typeof offer.priceCurrency === "string" ? offer.priceCurrency.toUpperCase() : null,
      availability: typeof offer.availability === "string"
        ? offer.availability.replace("https://schema.org/", "").replace("http://schema.org/", "")
        : null,
      image_url: Array.isArray(node.image) ? String(node.image[0]) : (typeof node.image === "string" ? node.image : null),
      raw_price_text: String(priceRaw),
      extraction_method: isAggregate ? "json_ld_aggregate" : "json_ld",
      confidence_score: isAggregate ? 0.75 : 0.95,
      raw_payload: { source: "json_ld", aggregate: isAggregate },
    };
  }
  return null;
}

// ── Layer 2: Microdata + meta tags ──────────────────────────────────
function extractMicrodataAndMeta(html: string): Partial<ExtractionResult> | null {
  const out: Partial<ExtractionResult> = {};

  const metaPatterns: Array<[RegExp, string]> = [
    [/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["']/i, "price"],
    [/<meta[^>]+property=["']og:price:amount["'][^>]+content=["']([^"']+)["']/i, "price"],
    [/<meta[^>]+itemprop=["']price["'][^>]+content=["']([^"']+)["']/i, "price"],
    [/<meta[^>]+property=["']product:price:currency["'][^>]+content=["']([^"']+)["']/i, "currency"],
    [/<meta[^>]+property=["']og:price:currency["'][^>]+content=["']([^"']+)["']/i, "currency"],
    [/<meta[^>]+itemprop=["']priceCurrency["'][^>]+content=["']([^"']+)["']/i, "currency"],
    [/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i, "title"],
    [/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i, "image"],
    [/<meta[^>]+property=["']product:availability["'][^>]+content=["']([^"']+)["']/i, "availability"],
  ];

  let priceRaw: string | null = null;
  for (const [re, key] of metaPatterns) {
    const m = html.match(re);
    if (!m) continue;
    const v = m[1].trim();
    if (key === "price" && !priceRaw) priceRaw = v;
    else if (key === "currency" && !out.currency) out.currency = v.toUpperCase();
    else if (key === "title" && !out.title) out.title = v;
    else if (key === "image" && !out.image_url) out.image_url = v;
    else if (key === "availability" && !out.availability) out.availability = v;
  }

  if (!priceRaw) {
    const m = html.match(/<[^>]+itemprop=["']price["'][^>]*content=["']([^"']+)["']/i);
    if (m) priceRaw = m[1];
  }
  if (!priceRaw) {
    const m = html.match(/<[^>]+itemprop=["']price["'][^>]*>([\s\S]{0,80}?)<\//i);
    if (m) priceRaw = m[1].trim();
  }

  const price = parsePriceNumber(priceRaw);
  if (!price) return null;

  out.price_current = price;
  out.raw_price_text = priceRaw;
  out.extraction_method = "microdata_meta";
  out.confidence_score = 0.85;
  return out;
}

// ── Layer 3: Embedded hydration ──
function extractHydration(html: string): Partial<ExtractionResult> | null {
  const nextMatch = html.match(/<script\s+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      const found = deepFindPrice(data);
      if (found?.price) {
        return {
          title: found.title || null,
          price_current: found.price,
          price_original: found.originalPrice || null,
          currency: found.currency || null,
          image_url: found.image || null,
          raw_price_text: String(found.price),
          extraction_method: "hydration_next",
          confidence_score: 0.85,
          raw_payload: { source: "__NEXT_DATA__" },
        };
      }
    } catch { /* ignore */ }
  }

  const shopifyMatch = html.match(/var\s+meta\s*=\s*(\{[\s\S]*?\});/);
  if (shopifyMatch) {
    try {
      const meta = JSON.parse(shopifyMatch[1]);
      const product = meta?.product;
      const variant = product?.variants?.[0];
      if (variant?.price) {
        return {
          title: product?.type || null,
          price_current: parsePriceNumber(String(variant.price / 100)),
          currency: meta?.currency || null,
          raw_price_text: String(variant.price),
          extraction_method: "hydration_shopify",
          confidence_score: 0.85,
        };
      }
    } catch { /* ignore */ }
  }

  const scanScripts = [
    /window\.__NUXT__\s*=\s*(\{[\s\S]*?\});/,
    /window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\});/,
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/,
  ];
  for (const re of scanScripts) {
    const m = html.match(re);
    if (!m) continue;
    try {
      const data = JSON.parse(m[1]);
      const found = deepFindPrice(data);
      if (found?.price) {
        return {
          title: found.title || null,
          price_current: found.price,
          currency: found.currency || null,
          image_url: found.image || null,
          raw_price_text: String(found.price),
          extraction_method: "hydration_state",
          confidence_score: 0.75,
        };
      }
    } catch { /* ignore */ }
  }

  return null;
}

// ── Walmart-specific extractor ──
// Walmart embeds product data in a __NEXT_DATA__ script. The current price lives at
// product.priceInfo.currentPrice.price (selected variant) or item.priceInfo.currentPrice.price.
function extractWalmart(html: string, debug: Record<string, unknown>): Partial<ExtractionResult> | null {
  const wDebug: Record<string, unknown> = { tried: [] };
  (debug as any).walmart = wDebug;

  const nextMatch = html.match(/<script\s+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!nextMatch) {
    (wDebug.tried as string[]).push("no_next_data");
    return null;
  }

  let data: any;
  try {
    data = JSON.parse(nextMatch[1]);
    (wDebug.tried as string[]).push("next_data_parsed");
  } catch (e: any) {
    (wDebug.tried as string[]).push("next_data_parse_failed");
    wDebug.parse_error = e?.message;
    return null;
  }

  // Common Walmart paths
  const candidates: any[] = [];
  const initial = data?.props?.pageProps?.initialData?.data?.product
              ?? data?.props?.pageProps?.initialData?.data?.idml?.product
              ?? data?.props?.pageProps?.product;
  if (initial) candidates.push({ node: initial, path: "props.pageProps.initialData.data.product" });

  const reviewsProduct = data?.props?.pageProps?.initialData?.data?.reviews?.product;
  if (reviewsProduct) candidates.push({ node: reviewsProduct, path: "props.pageProps.initialData.data.reviews.product" });

  // Fallback: deep search for any node with priceInfo.currentPrice
  function findPriceInfo(obj: any, depth = 0, path = ""): { node: any; path: string } | null {
    if (!obj || depth > 10 || typeof obj !== "object") return null;
    if (obj.priceInfo?.currentPrice?.price != null) return { node: obj, path };
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length && i < 50; i++) {
        const r = findPriceInfo(obj[i], depth + 1, `${path}[${i}]`);
        if (r) return r;
      }
      return null;
    }
    for (const k of Object.keys(obj)) {
      const r = findPriceInfo(obj[k], depth + 1, path ? `${path}.${k}` : k);
      if (r) return r;
    }
    return null;
  }

  if (candidates.length === 0) {
    const found = findPriceInfo(data);
    if (found) {
      candidates.push(found);
      (wDebug.tried as string[]).push("deep_priceInfo_search");
    }
  }

  wDebug.candidate_paths = candidates.map(c => c.path);

  for (const { node, path } of candidates) {
    const priceInfo = node?.priceInfo;
    const cp = priceInfo?.currentPrice?.price ?? priceInfo?.linePrice;
    const wp = priceInfo?.wasPrice?.price ?? priceInfo?.listPrice?.price;
    const currency = priceInfo?.currentPrice?.currencyUnit || priceInfo?.priceDisplayCodes?.currency || "USD";
    const price = parsePriceNumber(cp);
    if (!price) continue;

    const availability =
      node?.availabilityStatus === "IN_STOCK" || priceInfo?.availabilityStatus === "IN_STOCK"
        ? "InStock"
        : node?.availabilityStatus === "OUT_OF_STOCK"
        ? "OutOfStock"
        : null;

    wDebug.matched_path = path;
    wDebug.matched_price = price;
    wDebug.matched_currency = currency;

    return {
      title: typeof node?.name === "string" ? node.name : null,
      price_current: price,
      price_original: parsePriceNumber(wp),
      currency: typeof currency === "string" ? currency.toUpperCase() : "USD",
      availability,
      image_url: node?.imageInfo?.thumbnailUrl || node?.imageInfo?.allImages?.[0]?.url || null,
      variant: node?.variantCriteria?.[0]?.selectedVariant?.name || null,
      raw_price_text: String(cp),
      extraction_method: "walmart_next_data",
      confidence_score: 0.9,
      raw_payload: { source: "walmart_next_data", path },
    };
  }

  (wDebug.tried as string[]).push("no_priceInfo_found");
  return null;
}

// ── Target-specific extractor ──
// Target embeds PDP data in a dehydrated React Query payload inside __NEXT_DATA__.
// Real product price is commonly available as price.current_retail and/or
// price.formatted_current_price, while title/image live nearby under
// item.product_description / enrichment.image_info / images.
function extractTarget(html: string, debug: Record<string, unknown>): Partial<ExtractionResult> | null {
  const tDebug: Record<string, unknown> = { tried: [] };
  (debug as any).target = tDebug;

  const readTargetPriceCandidate = (value: unknown): number | null => {
    if (value == null) return null;
    if (typeof value === "number") return parsePriceNumber(value);
    if (typeof value === "string") return parsePriceNumber(value);
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const candidate =
        obj.current_retail ??
        obj.formatted_current_price ??
        obj.reg_retail ??
        obj.formatted_comparison_price ??
        obj.value ??
        obj.amount;
      return parsePriceNumber(
        typeof candidate === "string" || typeof candidate === "number" ? candidate : null
      );
    }
    return null;
  };

  // Fast path: Target often ships the PDP payload as escaped JSON inside inline JS.
  // This is the exact structure currently visible on real PDPs that were failing with
  // render_ok_no_price, e.g. \"price\":{\"current_retail\":40.89,...}.
  const escapedCurrent = html.match(/\\"(?:current_retail|current_price|price)\\":(?:\{[^}]*\\"value\\":)?([0-9]+(?:\.[0-9]+)?)/i)?.[1]
    ?? html.match(/\"(?:current_retail|current_price|price)\":(?:\{[^}]*\"value\":)?([0-9]+(?:\.[0-9]+)?)/i)?.[1]
    ?? null;
  const escapedFormatted = html.match(/\\"formatted_(?:current_price|price)\\":\\"([^\\]+)\\"/i)?.[1]
    ?? html.match(/\"formatted_(?:current_price|price)\":\"([^\"]+)\"/i)?.[1]
    ?? null;
  const escapedOriginal = html.match(/\\"(?:reg_retail|original_price|compare_at_price)\\":(?:\{[^}]*\\"value\\":)?([0-9]+(?:\.[0-9]+)?)/i)?.[1]
    ?? html.match(/\"(?:reg_retail|original_price|compare_at_price)\":(?:\{[^}]*\"value\":)?([0-9]+(?:\.[0-9]+)?)/i)?.[1]
    ?? html.match(/\\"formatted_(?:comparison_price|original_price)\\":\\"([^\\]+)\\"/i)?.[1]
    ?? html.match(/\"formatted_(?:comparison_price|original_price)\":\"([^\"]+)\"/i)?.[1]
    ?? null;
  const escapedImage = html.match(/\\"primary_image_url\\":\\"([^\\]+)\\"/i)?.[1] ?? null;
  const escapedTitle =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.replace(/\s+:\s*Target\s*$/i, "").trim()
    ?? null;

  const escapedPrice = parsePriceNumber(escapedCurrent ?? escapedFormatted);
  if (escapedPrice) {
    tDebug.fast_path = "escaped_inline_payload";
    tDebug.matched_price = escapedCurrent ?? escapedFormatted;
    tDebug.matched_original_price = escapedOriginal;
    return {
      title: escapedTitle,
      price_current: escapedPrice,
      price_original: parsePriceNumber(escapedOriginal),
      currency: "USD",
      image_url: escapedImage,
      raw_price_text: String(escapedCurrent ?? escapedFormatted),
      extraction_method: "target_escaped_inline_price",
      confidence_score: 0.94,
      raw_payload: { source: "target_escaped_inline_price" },
    };
  }
  (tDebug.tried as string[]).push("escaped_inline_payload_no_match");

  const nextMatch = html.match(/<script\s+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!nextMatch) {
    (tDebug.tried as string[]).push("no_next_data");
    return null;
  }

  let data: any;
  try {
    data = JSON.parse(nextMatch[1]);
  } catch {
    (tDebug.tried as string[]).push("next_data_parse_failed");
    return null;
  }

  const candidates: Array<{ node: any; path: string }> = [];

  function pushCandidate(node: any, path: string) {
    if (!node || typeof node !== "object") return;
    const cp =
      readTargetPriceCandidate(node?.price) ??
      readTargetPriceCandidate(node?.price_details) ??
      readTargetPriceCandidate(node?.current_price) ??
      readTargetPriceCandidate(node?.pricing?.price) ??
      readTargetPriceCandidate(node?.pricing) ??
      readTargetPriceCandidate(node?.priceSummary);
    if (cp != null) candidates.push({ node, path });
  }

  const queries = data?.props?.dehydratedState?.queries;
  if (Array.isArray(queries)) {
    queries.forEach((query: any, idx: number) => {
      const stateData = query?.state?.data;
      pushCandidate(stateData, `props.dehydratedState.queries[${idx}].state.data`);
      if (Array.isArray(stateData)) {
        stateData.forEach((entry: any, entryIdx: number) => {
          pushCandidate(entry, `props.dehydratedState.queries[${idx}].state.data[${entryIdx}]`);
          pushCandidate(entry?.data, `props.dehydratedState.queries[${idx}].state.data[${entryIdx}].data`);
        });
      }
    });
  } else {
    (tDebug.tried as string[]).push("no_dehydrated_queries");
  }

  function findTargetPriceNode(obj: any, depth = 0, path = "root"): { node: any; path: string } | null {
    if (!obj || depth > 12 || typeof obj !== "object") return null;
    const hasTargetPrice =
      readTargetPriceCandidate(obj?.price) != null ||
      readTargetPriceCandidate(obj?.price_details) != null ||
      readTargetPriceCandidate(obj?.current_price) != null ||
      readTargetPriceCandidate(obj?.pricing?.price) != null ||
      readTargetPriceCandidate(obj?.pricing) != null ||
      readTargetPriceCandidate(obj?.priceSummary) != null;
    if (hasTargetPrice) {
      return { node: obj, path };
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length && i < 80; i++) {
        const found = findTargetPriceNode(obj[i], depth + 1, `${path}[${i}]`);
        if (found) return found;
      }
      return null;
    }
    for (const k of Object.keys(obj)) {
      const found = findTargetPriceNode(obj[k], depth + 1, path ? `${path}.${k}` : k);
      if (found) return found;
    }
    return null;
  }

  if (candidates.length === 0) {
    const found = findTargetPriceNode(data, 0, "__NEXT_DATA__");
    if (found) {
      candidates.push(found);
      (tDebug.tried as string[]).push("deep_target_price_search");
    }
  }

  for (const { node, path } of candidates) {
    const priceNode = node?.price ?? node?.price_details ?? node?.pricing?.price ?? node?.pricing ?? node?.priceSummary ?? {};
    const currentRaw =
      node?.current_price ??
      priceNode?.current_retail ??
      priceNode?.current_price ??
      priceNode?.formatted_current_price ??
      priceNode?.price ??
      priceNode?.value ??
      priceNode?.amount;
    const originalRaw =
      priceNode?.reg_retail ??
      priceNode?.original_price ??
      priceNode?.compare_at_price ??
      priceNode?.formatted_comparison_price ??
      priceNode?.formatted_original_price;
    const price = readTargetPriceCandidate(currentRaw);
    if (!price) continue;

    const title =
      node?.item?.product_description?.title ||
      node?.product_description?.title ||
      node?.title ||
      node?.product?.item?.product_description?.title ||
      null;

    const image =
      node?.enrichment?.image_info?.primary_image?.url ||
      node?.images?.primary_image_url ||
      node?.image?.primary_image?.url ||
      node?.item?.enrichment?.image_info?.primary_image?.url ||
      null;

    const availability =
      node?.available_to_promise_network?.availability_status ||
      node?.fulfillment?.shipping_options?.availability_status ||
      null;

    tDebug.matched_path = path;
    tDebug.matched_price = currentRaw;
    tDebug.matched_original_price = originalRaw ?? null;

    return {
      title: typeof title === "string" ? title : null,
      price_current: price,
      price_original: parsePriceNumber(originalRaw),
      currency: "USD",
      availability: typeof availability === "string" ? availability : null,
      image_url: typeof image === "string" ? image : null,
      raw_price_text: String(currentRaw),
      extraction_method: "target_dehydrated_state",
      confidence_score: 0.92,
      raw_payload: { source: "target_dehydrated_state", path },
    };
  }

  (tDebug.tried as string[]).push("no_target_price_found");
  return null;
}

// ── Target DOM + regex fallback ──
// Runs only when extractTarget() (JSON path) fails. Tries data-test attributes,
// then permissive JSON key sweeps, then a last-resort regex over $XX.XX patterns
// near price-related markup. Designed to recover when Target rotates JSON shapes
// or hydrates the price after our wait window.
function extractTargetDomFallback(
  html: string,
  debug: Record<string, unknown>,
): Partial<ExtractionResult> | null {
  const tDebug: Record<string, unknown> = (debug as any).target_dom ?? { tried: [] };
  (debug as any).target_dom = tDebug;

  const validate = (n: number | null): number | null => {
    if (n == null || !Number.isFinite(n)) return null;
    if (n < 0.5 || n > 99999) return null; // Reasonable consumer-product range
    return Math.round(n * 100) / 100;
  };

  const ogTitle =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? null;
  const ogImage =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? null;

  // Layer A0: __TGT_DATA__ inline blob — Target's other in-page state var
  const tgtBlob = html.match(/__TGT_DATA__\s*=\s*['"`]?\{[\s\S]*?(?:current_retail|formatted_current_price|salePrice)[^}]*?([0-9]+(?:\.[0-9]{1,2})?)/i);
  if (tgtBlob) {
    const p = validate(parsePriceNumber(tgtBlob[1]));
    if (p != null) {
      (tDebug.tried as string[]).push("tgt_data_blob_hit");
      tDebug.matched_price = p;
      return {
        title: ogTitle, price_current: p, currency: "USD", image_url: ogImage,
        raw_price_text: String(tgtBlob[1]), extraction_method: "target_tgt_data_blob",
        confidence_score: 0.85, raw_payload: { source: "target_tgt_data_blob" },
      };
    }
  }
  (tDebug.tried as string[]).push("tgt_data_blob_no_match");

  // Layer A: data-test attributes Target ships in rendered HTML
  const domSelectors = [
    /<[^>]+data-test=["'](?:product-price|current-price|price-current|priceValue|product-price-value)["'][^>]*>\s*\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
    /<span[^>]+data-test=["']product-price["'][^>]*>[\s\S]{0,200}?\$\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
    /<[^>]+itemprop=["']price["'][^>]*content=["']?\$?([0-9]+(?:\.[0-9]{1,2})?)/i,
    // Wider scan when price sits in nested spans
    /data-test=["']product-price["'][\s\S]{0,400}?\$\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
  ];
  for (const re of domSelectors) {
    const m = html.match(re);
    const p = validate(parsePriceNumber(m?.[1] ?? null));
    if (p != null) {
      (tDebug.tried as string[]).push("dom_selector_hit");
      tDebug.matched_price = p;
      return {
        title: ogTitle, price_current: p, currency: "USD", image_url: ogImage,
        raw_price_text: String(m?.[1] ?? p), extraction_method: "target_dom_fallback",
        confidence_score: 0.78, raw_payload: { source: "target_dom_fallback" },
      };
    }
  }
  (tDebug.tried as string[]).push("dom_selectors_no_match");

  // Layer B: permissive JSON key sweep (shape-agnostic)
  // Catches new field names like price.price, salePrice, listPrice.value, etc.
  const jsonKeys = [
    /["\\]+(?:current_retail|formatted_current_price|current_price|salePrice|sale_price)["\\]+\s*:\s*\\?["{]?\s*(?:value\\?["']?\s*:\s*)?\$?([0-9]+(?:\.[0-9]{1,2})?)/i,
    /["\\]+price["\\]+\s*:\s*\{[^}]*(?:current_retail|value|amount|formatted)["\\]+\s*:\s*\\?["']?\$?([0-9]+(?:\.[0-9]{1,2})?)/i,
    /["\\]+(?:listPrice|list_price|reg_retail)["\\]+\s*:\s*\\?["{]?\s*(?:value\\?["']?\s*:\s*)?\$?([0-9]+(?:\.[0-9]{1,2})?)/i,
  ];
  for (const re of jsonKeys) {
    const m = html.match(re);
    const p = validate(parsePriceNumber(m?.[1] ?? null));
    if (p != null) {
      (tDebug.tried as string[]).push("json_key_sweep_hit");
      tDebug.matched_price = p;
      return {
        title: ogTitle,
        price_current: p,
        currency: "USD",
        image_url: ogImage,
        raw_price_text: String(m?.[1] ?? p),
        extraction_method: "target_json_sweep",
        confidence_score: 0.72,
        raw_payload: { source: "target_json_sweep" },
      };
    }
  }
  (tDebug.tried as string[]).push("json_key_sweep_no_match");

  // Layer C: last-resort regex — find $XX.XX near a price-context word
  // We require proximity (within ~80 chars) to "price" / "retail" / "current"
  // to avoid grabbing shipping or unrelated dollar amounts.
  const contextWindow = /(?:price|retail|current|sale|product[_-]?price|cost)[^a-z0-9]{0,80}\$\s*([0-9]+(?:\.[0-9]{1,2})?)/gi;
  const matches: number[] = [];
  let cm: RegExpExecArray | null;
  while ((cm = contextWindow.exec(html)) !== null && matches.length < 25) {
    const v = validate(parsePriceNumber(cm[1]));
    if (v != null) matches.push(v);
  }
  if (matches.length > 0) {
    // Take the most frequent value (avoids one-off shipping/tax numbers)
    const freq = new Map<number, number>();
    matches.forEach((m) => freq.set(m, (freq.get(m) ?? 0) + 1));
    const best = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (best != null) {
      (tDebug.tried as string[]).push("contextual_regex_hit");
      tDebug.matched_price = best;
      tDebug.candidate_count = matches.length;
      return {
        title: ogTitle,
        price_current: best,
        currency: "USD",
        image_url: ogImage,
        raw_price_text: String(best),
        extraction_method: "target_contextual_regex",
        confidence_score: 0.6,
        raw_payload: { source: "target_contextual_regex", candidates: matches.slice(0, 10) },
      };
    }
  }
  (tDebug.tried as string[]).push("contextual_regex_no_match");

  return null;
}

function deepFindPrice(obj: any, depth = 0): { price?: number; originalPrice?: number; currency?: string; title?: string; image?: string } | null {
  if (!obj || depth > 8) return null;
  if (typeof obj !== "object") return null;

  const result: any = {};
  const priceKeys = ["price", "currentPrice", "salePrice", "finalPrice", "amount", "value"];
  const origKeys = ["listPrice", "originalPrice", "wasPrice", "msrp", "regularPrice"];
  const currencyKeys = ["currency", "currencyCode", "priceCurrency"];
  const titleKeys = ["name", "title", "productName"];
  const imageKeys = ["image", "imageUrl", "primaryImage"];

  if (Array.isArray(obj)) {
    for (const it of obj) {
      const r = deepFindPrice(it, depth + 1);
      if (r?.price) return r;
    }
    return null;
  }

  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const lk = k.toLowerCase();
    if (!result.price && priceKeys.some(pk => lk === pk.toLowerCase())) {
      const p = parsePriceNumber(typeof v === "object" ? v?.value ?? v?.amount : v);
      if (p) result.price = p;
    }
    if (!result.originalPrice && origKeys.some(pk => lk === pk.toLowerCase())) {
      const p = parsePriceNumber(typeof v === "object" ? v?.value ?? v?.amount : v);
      if (p) result.originalPrice = p;
    }
    if (!result.currency && currencyKeys.some(pk => lk === pk.toLowerCase()) && typeof v === "string") {
      result.currency = v.toUpperCase();
    }
    if (!result.title && titleKeys.some(pk => lk === pk.toLowerCase()) && typeof v === "string" && v.length < 300) {
      result.title = v;
    }
    if (!result.image && imageKeys.some(pk => lk === pk.toLowerCase()) && typeof v === "string" && v.startsWith("http")) {
      result.image = v;
    }
  }

  if (result.price) return result;

  for (const k of Object.keys(obj)) {
    const r = deepFindPrice(obj[k], depth + 1);
    if (r?.price) return r;
  }
  return null;
}

// ── Layer 4: HTML selectors ──
function extractSelectors(html: string): Partial<ExtractionResult> | null {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // Strip strikethrough/list price wrappers so we don't grab them as current
    .replace(/<(s|strike|del)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/class=["'][^"']*\b(was-price|list-price|original-price|old-price|strike|crossed)[^"']*["'][^>]*>[\s\S]*?</gi, "<");

  const patterns: Array<{ re: RegExp; conf: number; label: string }> = [
    { re: /data-test(?:id)?=["'][^"']*(?:product-price|current-price|price-display|price-value)[^"']*["'][^>]*>\s*([^<]{1,40})\s*</i, conf: 0.82, label: "data-test-price" },
    { re: /aria-label=["'][^"']*\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)[^"']*["']/i, conf: 0.72, label: "aria-price" },
    { re: /\"current_price\"\s*:\s*\{[^}]*\"value\"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i, conf: 0.9, label: "inline-current-price-value" },
    { re: /\"price\"\s*:\s*\{[^}]*\"value\"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i, conf: 0.84, label: "inline-price-value" },
    { re: /data-price=["']([0-9.,]+)["']/i, conf: 0.7, label: "data-price" },
    { re: /class=["'][^"']*sale-price[^"']*["'][^>]*>\s*([^<]{1,40})\s*</i, conf: 0.7, label: "sale-price" },
    { re: /class=["'][^"']*current[-_]price[^"']*["'][^>]*>\s*([^<]{1,40})\s*</i, conf: 0.7, label: "current-price" },
    { re: /class=["'][^"']*\bprice\b[^"']*["'][^>]*>\s*([^<]{1,60})\s*</i, conf: 0.5, label: "class-price" },
  ];

  for (const { re, conf, label } of patterns) {
    const m = cleaned.match(re);
    if (!m) continue;
    const price = parsePriceNumber(m[1]);
    if (!price) continue;
    return {
      price_current: price,
      currency: detectCurrency(m[1]),
      raw_price_text: m[1].trim(),
      extraction_method: `selector_${label}`,
      confidence_score: conf,
    };
  }

  return null;
}

function extractTitle(html: string): string | null {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return og[1].trim();
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return t ? t[1].trim().slice(0, 250) : null;
}

function extractImage(html: string): string | null {
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  return og ? og[1].trim() : null;
}

// ── Availability normalization ──
// Keeps the legacy schema.org-style string for back-compat, AND derives a
// normalized enum (`in_stock` | `out_of_stock` | `preorder` | `backorder` |
// `unknown`) using a layered approach: structured signals first, then HTML
// text/button-state heuristics.
type StockEnum = "in_stock" | "out_of_stock" | "preorder" | "backorder" | "unknown";

function stockEnumFromRaw(raw: string | null | undefined): StockEnum | null {
  if (!raw) return null;
  const s = raw.toLowerCase()
    .replace("https://schema.org/", "")
    .replace("http://schema.org/", "")
    .trim();

  if (/(out[\s_-]?of[\s_-]?stock|outofstock|sold[\s_-]?out|soldout|unavailable|discontinued|notify[\s_-]?me|currently[\s_-]?unavailable|no[\s_-]?longer[\s_-]?available)/.test(s)) {
    return "out_of_stock";
  }
  if (/(pre[\s_-]?order|preorder|coming[\s_-]?soon|releases?[\s_-]?on)/.test(s)) {
    return "preorder";
  }
  if (/(back[\s_-]?order|backorder)/.test(s)) {
    return "backorder";
  }
  if (/(in[\s_-]?stock|instock|available|add[\s_-]?to[\s_-]?(cart|bag|basket)|buy[\s_-]?now|limitedavailability|limited[\s_-]?stock|only[\s]+\d+[\s]+left|usually[\s]+ships|ships[\s]+next[\s]+business[\s]+day)/.test(s)) {
    return "in_stock";
  }
  return null;
}

function availabilityLabelFromEnum(value: StockEnum | null): string | null {
  switch (value) {
    case "in_stock":
      return "InStock";
    case "out_of_stock":
      return "OutOfStock";
    case "preorder":
      return "PreOrder";
    case "backorder":
      return "BackOrder";
    default:
      return null;
  }
}

function htmlAvailabilitySignal(html: string): { status: StockEnum | null; label: string | null } {
  if (!html) return { status: null, label: null };

  const lower = html.toLowerCase();
  const disabledPurchaseCta = /<button[^>]*\b(disabled|aria-disabled=["']true["'])[^>]*>[^<]*(add[\s]+to[\s]+(cart|bag|basket)|buy[\s]+now)/i.test(html);
  const activePurchaseCta = /<button(?![^>]*\b(?:disabled|aria-disabled=["']true["']))[^>]*>[^<]*(add[\s]+to[\s]+(cart|bag|basket)|buy[\s]+now)/i.test(html);
  const hasNegativeText = /sold[\s_-]?out|out[\s_-]?of[\s_-]?stock|currently[\s]+unavailable|no[\s]+longer[\s]+available|notify[\s]+me[\s]+when|item[\s]+unavailable/.test(lower);
  const hasPreorderText = /pre[\s_-]?order|preorder|coming[\s]+soon|releases?[\s]+on[\s]+\w+\s+\d/.test(lower);
  const hasBackorderText = /back[\s_-]?order|on[\s]+backorder/.test(lower);
  const hasPositiveText = /\bin[\s]+stock\b|\bavailable[\s]+now\b|\busually[\s]+ships\b|\bships[\s]+(today|tomorrow|next[\s]+business[\s]+day|in[\s]+\d)|\bonly[\s]+\d+[\s]+left\b/.test(lower);
  const shippingLeadMatch = html.match(/(Usually ships in[^<]{0,80}|Ships next business day|Ships today|Ships tomorrow)/i);
  const inStockMatch = html.match(/\bIn Stock\b/i);

  if (disabledPurchaseCta) return { status: "out_of_stock", label: "OutOfStock" };
  if (hasPreorderText) return { status: "preorder", label: "PreOrder" };
  if (hasBackorderText) return { status: "backorder", label: "BackOrder" };

  if ((activePurchaseCta || hasPositiveText) && !hasNegativeText) {
    return {
      status: "in_stock",
      label: shippingLeadMatch?.[1] ?? inStockMatch?.[0] ?? "InStock",
    };
  }

  if (hasNegativeText) return { status: "out_of_stock", label: "OutOfStock" };
  if (activePurchaseCta || hasPositiveText) {
    return {
      status: "in_stock",
      label: shippingLeadMatch?.[1] ?? inStockMatch?.[0] ?? "InStock",
    };
  }

  return { status: null, label: null };
}

function normalizeAvailability(html: string, current: string | null): string | null {
  const rawStatus = stockEnumFromRaw(current);
  const htmlSignal = htmlAvailabilitySignal(html);

  if (htmlSignal.status === "in_stock" && rawStatus === "out_of_stock") {
    return htmlSignal.label ?? "InStock";
  }
  if (htmlSignal.status === "out_of_stock" && rawStatus === "in_stock") {
    return htmlSignal.label ?? "OutOfStock";
  }
  if (current && rawStatus) {
    return current;
  }
  return htmlSignal.label ?? availabilityLabelFromEnum(rawStatus) ?? current ?? null;
}

// Map raw availability text + page HTML into the canonical stock enum.
// Visible page signals override stale structured data when they clearly conflict.
function deriveAvailabilityStatus(
  rawAvailability: string | null,
  html: string,
): StockEnum {
  const rawStatus = stockEnumFromRaw(rawAvailability);
  const htmlStatus = htmlAvailabilitySignal(html).status;

  if (htmlStatus === "in_stock" && rawStatus === "out_of_stock") return "in_stock";
  if (htmlStatus === "out_of_stock") return "out_of_stock";
  if (rawStatus && rawStatus !== "unknown") return rawStatus;
  if (htmlStatus) return htmlStatus;
  return "unknown";
}

// ── Layer 5: AI fallback ──
async function aiFallback(visibleText: string, url: string): Promise<Partial<ExtractionResult> | null> {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) return null;

  const snippet = visibleText.slice(0, 6000);

  try {
    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content:
              "You are a careful price extractor. Given visible text from a single product page, identify the CURRENT selling price (not list/strike-through). Return null if uncertain. Never guess. If the page looks like a search results, category, or cart page, set confidence below 0.3.",
          },
          { role: "user", content: `URL: ${url}\n\nPage text:\n${snippet}` },
        ],
        tools: [{
          type: "function",
          function: {
            name: "report_price",
            description: "Report the extracted price information",
            parameters: {
              type: "object",
              properties: {
                price_current: { type: ["number", "null"] },
                price_original: { type: ["number", "null"] },
                currency: { type: ["string", "null"] },
                availability: { type: ["string", "null"] },
                title: { type: ["string", "null"] },
                confidence: { type: "number" },
                reasoning: { type: "string" },
              },
              required: ["price_current", "currency", "confidence"],
              additionalProperties: false,
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "report_price" } },
      }),
    });

    if (!resp.ok) {
      console.error("AI fallback failed:", resp.status);
      return null;
    }

    const data = await resp.json();
    const toolCall = data?.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) return null;
    const args = JSON.parse(toolCall.function.arguments || "{}");

    if (args.price_current == null) return null;
    const conf = Math.max(0, Math.min(1, Number(args.confidence) || 0.3));
    return {
      title: args.title || null,
      price_current: parsePriceNumber(args.price_current),
      price_original: parsePriceNumber(args.price_original),
      currency: args.currency || null,
      availability: args.availability || null,
      raw_price_text: String(args.price_current),
      extraction_method: "ai_fallback",
      confidence_score: Math.min(conf, 0.6),
      raw_payload: { ai_reasoning: args.reasoning },
    };
  } catch (e) {
    console.error("AI fallback error:", e);
    return null;
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Phase 2: Browser rendering via ScrapingBee ──
// Only invoked for blocked or known JS-heavy domains. Returns rendered HTML or null.
const HIGH_FRICTION_DOMAINS = ["walmart.com", "target.com", "bestbuy.com", "homedepot.com"];

function isHighFrictionDomain(domain: string | null): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return HIGH_FRICTION_DOMAINS.some((h) => d === h || d.endsWith(`.${h}`) || d.includes(h));
}

type BrowserRenderOutcome =
  | { kind: "ok"; html: string; structured?: FirecrawlStructured | null }
  | { kind: "skipped"; reason: string }
  | { kind: "timeout"; elapsed_ms: number }
  | { kind: "render_failed"; status?: number; error: string };

type FirecrawlStructured = {
  title?: string | null;
  price_current?: number | null;
  price_original?: number | null;
  currency?: string | null;
  image_url?: string | null;
  availability?: string | null;
};

// ── Firecrawl renderer (primary) ──
// Direct REST call (Firecrawl doesn't use Lovable connector gateway).
async function firecrawlRender(
  url: string,
  domain: string | null,
  debug: Record<string, unknown>,
): Promise<BrowserRenderOutcome> {
  const apiKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!apiKey) {
    (debug as any).phase2_firecrawl_skipped = "no_firecrawl_key";
    return { kind: "skipped", reason: "no_firecrawl_key" };
  }

  // Stealth proxy for known anti-bot domains
  const useStealth = isHighFrictionDomain(domain);
  // Target hydrates the price node ~4-7s after initial HTML on stealth proxies.
  // Bumped to 8000ms to consistently capture the post-hydration price.
  const waitFor = domain && domain.includes("target.com") ? 8000
                : domain && domain.includes("walmart") ? 3500
                : 2000;

  const body = {
    url,
    // Request HTML + AI-extracted JSON in one call. The structured JSON works
    // even when the HTML response is a tiny bot-challenge stub, because Firecrawl
    // runs the extraction against the fully-rendered DOM internally.
    formats: [
      "html",
      {
        type: "json",
        prompt: "Extract product details from this page. Return: title (string), price_current (current selling price as a number with no currency symbol), price_original (original/list price if discounted, else null), currency (3-letter ISO code like USD/EUR/GBP), image_url (main product image URL), availability (in_stock, out_of_stock, preorder, or unknown). If this is not a single product page, return all fields as null.",
        schema: {
          type: "object",
          properties: {
            title: { type: ["string", "null"] },
            price_current: { type: ["number", "null"] },
            price_original: { type: ["number", "null"] },
            currency: { type: ["string", "null"] },
            image_url: { type: ["string", "null"] },
            availability: { type: ["string", "null"] },
          },
        },
      },
    ],
    onlyMainContent: false,
    waitFor,
    proxy: useStealth ? "stealth" : "auto",
    timeout: 30000,
    blockAds: true,
  };

  (debug as any).phase2_endpoint = "firecrawl";
  (debug as any).phase2_url = url;
  (debug as any).phase2_domain = domain;
  (debug as any).phase2_proxy = body.proxy;
  console.log(`[browserRender] firecrawl start url=${url} domain=${domain} proxy=${body.proxy} waitFor=${waitFor}`);

  const TIMEOUT_MS = 28000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const resp = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const elapsed = Date.now() - t0;
    (debug as any).phase2_elapsed_ms = elapsed;
    (debug as any).phase2_http_status = resp.status;

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      const snippet = errText.slice(0, 300);
      (debug as any).phase2_error = `firecrawl HTTP ${resp.status}: ${snippet}`;
      console.warn(`[browserRender] firecrawl error status=${resp.status} body=${snippet}`);
      // 402 = no credits, 401 = bad key — let caller fall back to ScrapingBee
      return { kind: "render_failed", status: resp.status, error: `firecrawl_${resp.status}: ${snippet}` };
    }

    const json = await resp.json().catch(() => ({} as any));
    const html: string = json?.data?.html ?? json?.html ?? "";
    const structured: FirecrawlStructured | null =
      (json?.data?.json as FirecrawlStructured) ?? (json?.json as FirecrawlStructured) ?? null;
    (debug as any).phase2_html_length = html.length;
    (debug as any).phase2_structured_price = structured?.price_current ?? null;
    (debug as any).phase2_structured_title = structured?.title ? String(structured.title).slice(0, 80) : null;

    // Structured JSON is the most reliable signal — accept it even with tiny HTML
    if (structured?.price_current && Number(structured.price_current) > 0) {
      console.log(`[browserRender] firecrawl ok (json) url=${url} price=${structured.price_current} html_len=${html.length} elapsed=${elapsed}ms`);
      return { kind: "ok", html: html || "<html></html>", structured };
    }

    if (!html || html.length < 500) {
      console.warn(`[browserRender] firecrawl tiny response url=${url} len=${html?.length || 0} no_structured_price`);
      return { kind: "render_failed", status: resp.status, error: `firecrawl_html_too_short (len=${html?.length || 0}, no_structured_price)` };
    }
    console.log(`[browserRender] firecrawl ok url=${url} len=${html.length} elapsed=${elapsed}ms`);
    return { kind: "ok", html, structured };
  } catch (e: any) {
    const elapsed = Date.now() - t0;
    (debug as any).phase2_elapsed_ms = elapsed;
    const msg = e?.name === "AbortError" ? "firecrawl_timeout" : (e?.message || String(e));
    (debug as any).phase2_error = msg;
    if (e?.name === "AbortError") {
      return { kind: "timeout", elapsed_ms: elapsed };
    }
    return { kind: "render_failed", error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ── ScrapingBee renderer (fallback) ──
async function scrapingBeeRender(
  url: string,
  domain: string | null,
  debug: Record<string, unknown>,
): Promise<BrowserRenderOutcome> {
  const apiKey = Deno.env.get("SCRAPINGBEE_API_KEY");
  if (!apiKey) {
    (debug as any).phase2_bee_skipped = "no_scrapingbee_key";
    return { kind: "skipped", reason: "no_scrapingbee_key" };
  }

  const params = new URLSearchParams({
    api_key: apiKey,
    url,
    render_js: "true",
    premium_proxy: "true",
    country_code: "us",
    wait: "2500",
    block_resources: "false",
  });

  if (domain && domain.includes("walmart")) {
    params.set("wait_for", "script#__NEXT_DATA__");
    params.set("wait", "4000");
  }
  if (domain && domain.includes("target.com")) {
    params.set("stealth_proxy", "true");
    params.delete("premium_proxy");
    params.set("wait", "8000"); // +2s for late price hydration
    params.set("wait_for", "[data-test=\"product-price\"]"); // wait for the actual rendered price node
    params.set("wait_browser", "networkidle2");
  }

  const endpoint = `https://app.scrapingbee.com/api/v1/?${params.toString()}`;
  (debug as any).phase2_fallback_endpoint = "scrapingbee";
  console.log(`[browserRender] scrapingbee fallback start url=${url} domain=${domain}`);

  const TIMEOUT_MS = 22000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const resp = await fetch(endpoint, { method: "GET", signal: controller.signal });
    const elapsed = Date.now() - t0;
    (debug as any).phase2_fallback_elapsed_ms = elapsed;
    (debug as any).phase2_fallback_http_status = resp.status;

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { kind: "render_failed", status: resp.status, error: `bee HTTP ${resp.status}: ${errText.slice(0, 200)}` };
    }
    const html = await resp.text();
    if (!html || html.length < 500) {
      return { kind: "render_failed", status: resp.status, error: `bee_html_too_short (len=${html?.length || 0})` };
    }
    console.log(`[browserRender] scrapingbee fallback ok url=${url} len=${html.length}`);
    return { kind: "ok", html };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "render_timeout" : (e?.message || String(e));
    if (e?.name === "AbortError") return { kind: "timeout", elapsed_ms: Date.now() - t0 };
    return { kind: "render_failed", error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// Primary entry point: Firecrawl-only (ScrapingBee fallback removed — quota
// exhausted on free tier and user chose to consolidate on Firecrawl). The
// scrapingBeeRender function above is kept dormant in case we re-enable it.
async function browserRender(
  url: string,
  domain: string | null,
  debug: Record<string, unknown>,
): Promise<BrowserRenderOutcome> {
  const fc = await firecrawlRender(url, domain, debug);
  if (fc.kind !== "ok") {
    (debug as any).phase2_scrapingbee_disabled = true;
    console.log(`[browserRender] firecrawl outcome=${fc.kind} — scrapingbee fallback disabled`);
  }
  return fc;
}

// Run extraction layers on a given HTML body. Returns first successful result.
function runExtractionLayers(
  html: string,
  isWalmart: boolean,
  debug: Record<string, unknown>,
  methodPrefix = "",
): Partial<ExtractionResult> | null {
  const layers: Array<{ name: string; fn: () => Partial<ExtractionResult> | null }> = [];
  const isTarget = typeof (debug as any)?.domain === "string" && String((debug as any).domain).includes("target.com");
  if (isWalmart) {
    layers.push({ name: "walmart_next_data", fn: () => extractWalmart(html, debug) });
  }
  if (isTarget) {
    layers.push({ name: "target_dehydrated_state", fn: () => extractTarget(html, debug) });
  }
  layers.push(
    { name: "json_ld", fn: () => extractJsonLd(html) },
    { name: "hydration", fn: () => extractHydration(html) },
    { name: "microdata_meta", fn: () => extractMicrodataAndMeta(html) },
    { name: "selectors", fn: () => extractSelectors(html) },
  );
  // Target-specific last-resort fallback (DOM selectors + permissive JSON sweep + contextual regex).
  // Runs only after every generic layer has failed, to recover from JSON-shape rotations and late hydration.
  if (isTarget) {
    layers.push({ name: "target_dom_fallback", fn: () => extractTargetDomFallback(html, debug) });
  }

  for (const layer of layers) {
    (debug.layers_tried as string[]).push(`${methodPrefix}${layer.name}`);
    const r = layer.fn();
    if (r?.price_current) {
      debug.layers_succeeded = `${methodPrefix}${layer.name}`;
      // Tag method with prefix so client can show "browser_rendered_*"
      if (methodPrefix && r.extraction_method) {
        r.extraction_method = `${methodPrefix}${r.extraction_method}`;
      }
      return r;
    }
  }
  return null;
}

// ── Resolution-derived primary review reason ──
// Access-blockage reasons should always be shown FIRST, before generic
// quality flags like "Confidence below 0.6". This keeps the UI honest about
// *why* a result needs review (blocked vs. low confidence vs. AI fallback).
function reasonForResolution(result: ExtractionResult): string | null {
  const provider = result.block_provider
    ? (BLOCK_PROVIDER_TEXT[result.block_provider] || result.block_provider)
    : "anti-bot challenge";
  const dom = result.domain || "this domain";
  switch (result.final_resolution) {
    case "blocked_phase1":
      return `Blocked by ${provider} on ${dom} (Phase 1). Browser rendering not attempted by domain policy.`;
    case "blocked_phase2":
    case "blocked_all_phases":
      return `Blocked by ${provider} on ${dom} — Phase 2 browser rendering also blocked.`;
    case "phase2_timeout":
      return `Phase 2 browser rendering timed out for ${dom}. The site is reachable but did not respond in time.`;
    case "phase2_render_failed":
      return `Phase 2 browser rendering failed (provider error) for ${dom}.`;
    case "phase2_extract_failed":
      return `Phase 2 rendered ${dom} successfully, but no reliable price was found on the page.`;
    case "non_product_page":
      return `URL appears to be a ${result.page_type || "non-product"} page, not a single product page.`;
    case "fetch_error":
      return `Could not reach ${dom} (network/HTTP error).`;
    case "not_found_unblocked":
      return `Page is accessible but no reliable price was found across all extraction layers.`;
    default:
      return null;
  }
}

const BLOCK_PROVIDER_TEXT: Record<string, string> = {
  perimeterx: "PerimeterX",
  datadome_captcha: "DataDome",
  cloudflare_challenge: "Cloudflare",
  cloudflare_jschallenge: "Cloudflare JS challenge",
  walmart_press_and_hold: "Walmart Press & Hold",
  walmart_short_block_page: "Walmart block page",
  press_and_hold_captcha: "Press & Hold CAPTCHA",
  generic_robot_check: "robot check",
  access_denied: "access-denied page",
  distil_networks: "Distil Networks",
  generic_human_verify: "human-verification page",
  empty_or_tiny_response: "empty/blocked response",
};

// ── Validation guards ──
function validateAndFlag(result: ExtractionResult): { reasons: string[]; needsReview: boolean } {
  const reasons: string[] = [];

  // 1. PRIMARY reason: access/resolution-derived (blocked, timeout, etc.)
  // This must come first so the UI never shows "Confidence below 0.6" when
  // the real problem is that the page was blocked or timed out.
  const primary = reasonForResolution(result);
  if (primary) reasons.push(primary);

  // 2. Secondary quality flags (only meaningful when extraction actually ran)
  // Skip the generic "low confidence" flag for blocked/error resolutions —
  // a 0% confidence on a blocked page is a tautology, not useful signal.
  const isAccessFailure = result.final_resolution && [
    "blocked_phase1", "blocked_phase2", "blocked_all_phases",
    "phase2_timeout", "phase2_render_failed", "fetch_error",
  ].includes(result.final_resolution);

  // Reject obviously bad numbers
  if (result.price_current != null) {
    const p = result.price_current;
    if (p === 0 || p === 0.01 || p >= 99999) {
      reasons.push(`Suspicious price value (${p})`);
    }
  }

  // Currency mismatch with domain hint
  const expected = expectedCurrencyForDomain(result.domain);
  if (expected && result.currency && expected !== result.currency) {
    reasons.push(`Currency mismatch: page=${result.currency}, expected ${expected} for ${result.domain}`);
  }

  // Sale > original (probably swapped)
  if (result.price_original != null && result.price_current != null && result.price_current > result.price_original) {
    reasons.push("Current price > original price (possibly swapped)");
  }

  // AI fallback always = needs review
  if (result.extraction_method === "ai_fallback") {
    reasons.push("AI fallback was used — verify manually");
  }

  // Low confidence — only when not an access failure
  if (!isAccessFailure && (result.confidence_score ?? 0) < 0.6 && result.price_current != null) {
    reasons.push("Confidence below 0.6");
  }

  // Non-product page (only if not already covered by resolution)
  if (
    result.final_resolution !== "non_product_page" &&
    result.page_type && result.page_type !== "product" && result.page_type !== "unknown"
  ) {
    reasons.push(`Page does not look like a single product page (${result.page_type})`);
  }

  return { reasons, needsReview: reasons.length > 0 };
}

// ── Best Buy Products API (primary path for bestbuy.com) ──
// Bypasses Phase 1 fetch + Phase 2 browser rendering entirely. Best Buy's
// official Products API returns title, image, price, availability, SKU/UPC
// directly — no anti-bot, no rendering provider failures.
function extractBestBuySku(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)bestbuy\.com$/i.test(u.hostname)) return null;
    // Pattern: /site/<slug>/<sku>.p or /site/<sku>.p
    const m = u.pathname.match(/\/(\d{5,})\.p\b/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function fetchBestBuyApi(
  url: string,
  domain: string,
  policy: DomainPolicy,
  debug: Record<string, unknown>,
): Promise<ExtractionResult | null> {
  const apiKey = Deno.env.get("BESTBUY_API_KEY");
  if (!apiKey) {
    (debug as any).bestbuy_api_skipped = "no_api_key";
    return null;
  }
  const sku = extractBestBuySku(url);
  if (!sku) {
    (debug as any).bestbuy_api_skipped = "no_sku_in_url";
    return null;
  }

  const fields = [
    "sku", "name", "salePrice", "regularPrice", "onlineAvailability",
    "onlineAvailabilityText", "image", "largeImage", "thumbnailImage",
    "url", "upc", "modelNumber", "manufacturer",
  ].join(",");
  const endpoint = `https://api.bestbuy.com/v1/products(sku=${encodeURIComponent(sku)})?apiKey=${apiKey}&format=json&show=${fields}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const t0 = Date.now();
  try {
    const resp = await fetch(endpoint, { signal: ctrl.signal });
    (debug as any).bestbuy_api_status = resp.status;
    (debug as any).bestbuy_api_elapsed_ms = Date.now() - t0;
    if (!resp.ok) {
      (debug as any).bestbuy_api_error = `http_${resp.status}`;
      console.log(`[bestbuy_api] sku=${sku} status=${resp.status} → falling back to render`);
      return null;
    }
    const json: any = await resp.json();
    const product = Array.isArray(json?.products) ? json.products[0] : null;
    if (!product) {
      (debug as any).bestbuy_api_error = "no_product_in_response";
      console.log(`[bestbuy_api] sku=${sku} returned no product → falling back to render`);
      return null;
    }

    const price = typeof product.salePrice === "number" ? product.salePrice
                : typeof product.regularPrice === "number" ? product.regularPrice
                : null;
    const image = product.largeImage || product.image || product.thumbnailImage || null;
    const onlineAvail = product.onlineAvailability === true;
    const availabilityText = product.onlineAvailabilityText || (onlineAvail ? "In Stock" : "Out of Stock");
    const availabilityStatus: ExtractionResult["availability_status"] = onlineAvail ? "in_stock" : "out_of_stock";

    if (price == null || !product.name) {
      (debug as any).bestbuy_api_error = "missing_price_or_title";
      console.log(`[bestbuy_api] sku=${sku} missing price/title → falling back to render`);
      return null;
    }

    console.log(`[bestbuy_api] sku=${sku} OK title="${String(product.name).slice(0, 60)}" price=$${price}`);

    return {
      url,
      domain,
      title: String(product.name),
      price_current: price,
      price_original: typeof product.regularPrice === "number" && product.regularPrice !== price
        ? product.regularPrice : null,
      currency: "USD",
      availability: availabilityText,
      availability_status: availabilityStatus,
      image_url: image,
      variant: null,
      extraction_method: "bestbuy_api",
      confidence_score: 95,
      raw_price_text: `$${price}`,
      raw_payload: {
        sku: product.sku,
        upc: product.upc ?? null,
        modelNumber: product.modelNumber ?? null,
        manufacturer: product.manufacturer ?? null,
        source: "bestbuy_products_api",
      },
      error: null,
      needs_review: false,
      review_reasons: [],
      page_type: "product",
      debug,
      phase1_status: "skipped",
      phase2_status: "skipped",
      block_provider: null,
      final_resolution: "price_extracted",
      domain_policy: policy.name,
      cache_ttl_hours: policy.success_cache_ttl_hours,
    };
  } catch (e: any) {
    (debug as any).bestbuy_api_error = e?.name === "AbortError" ? "timeout" : (e?.message || "throw");
    console.log(`[bestbuy_api] error: ${(debug as any).bestbuy_api_error} → falling back to render`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Main pipeline ──
async function runPipeline(url: string): Promise<ExtractionResult> {
  const domain = getDomain(url);
  const policy = getDomainPolicy(domain);

  // Best Buy: try official Products API first. If it returns a clean result,
  // skip Phase 1/2 entirely. If it fails (no key, no sku, network/HTTP error,
  // missing fields), fall through to the normal render path.
  if (domain && /(^|\.)bestbuy\.com$/i.test(domain)) {
    const apiDebug: Record<string, unknown> = { domain_policy: policy.name, domain };
    const apiResult = await fetchBestBuyApi(url, domain, policy, apiDebug);
    if (apiResult) return apiResult;
  }

  const debug: Record<string, unknown> = {
    layers_tried: [],
    layers_succeeded: null,
    domain_policy: policy.name,
  };
  const base: ExtractionResult = {
    url,
    domain,
    title: null,
    price_current: null,
    price_original: null,
    currency: null,
    availability: null,
    availability_status: "unknown",
    image_url: null,
    variant: null,
    extraction_method: "none",
    confidence_score: 0,
    raw_price_text: null,
    raw_payload: null,
    error: null,
    needs_review: false,
    review_reasons: [],
    page_type: "unknown",
    debug,
    phase1_status: "not_run",
    phase2_status: "not_run",
    block_provider: null,
    final_resolution: "not_found_unblocked",
    domain_policy: policy.name,
    cache_ttl_hours: policy.success_cache_ttl_hours,
  };
  (debug as any).domain = domain;

  let html = "";
  const isWalmart = !!domain && domain.includes("walmart");
  // Phase 1 hard timeout (15s) — prevents the worker from being killed by the
  // Edge runtime wall-time budget when an upstream hangs.
  const PHASE1_TIMEOUT_MS = 15000;

  // Rotated browser UAs for retry — many anti-bot layers (Akamai, Imperva)
  // fingerprint repeated UA+IP pairs, so a second attempt with a different UA
  // and a small jitter often clears a transient 403/429.
  const UA_POOL = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  ];

  const buildHeaders = (uaIndex: number): HeadersInit => ({
    "User-Agent": UA_POOL[uaIndex % UA_POOL.length],
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": uaIndex === 1 ? '"Windows"' : uaIndex === 2 ? '"Linux"' : '"macOS"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    // Mimic referrer from a generic search/landing — many sites whitelist
    // requests with a plausible referer over those with none.
    "Referer": "https://www.google.com/",
  });

  const attemptFetch = async (uaIndex: number): Promise<{ resp: Response | null; threw: boolean; err?: any; isTimeout?: boolean }> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PHASE1_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { headers: buildHeaders(uaIndex), redirect: "follow", signal: ctrl.signal });
      return { resp, threw: false };
    } catch (e: any) {
      const isTimeout = e?.name === "AbortError";
      return { resp: null, threw: true, err: e, isTimeout };
    } finally {
      clearTimeout(timer);
    }
  };

  const p1Start = Date.now();
  let lastStatus: number | null = null;
  let lastErr: any = null;
  let lastIsTimeout = false;
  const RETRYABLE_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 2; // initial + 1 retry

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Small jitter (400-1200ms) before retry to avoid burst-detection.
      await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 800)));
      (debug as any)[`phase1_retry_${attempt}`] = lastStatus ? `http_${lastStatus}` : (lastIsTimeout ? "timeout" : "throw");
    }
    const { resp, threw, err, isTimeout } = await attemptFetch(attempt);
    if (!threw && resp) {
      lastStatus = resp.status;
      if (resp.ok) {
        html = await resp.text();
        lastErr = null;
        break;
      }
      // Non-OK: retry only if status is in the retryable set and we have attempts left.
      if (attempt < MAX_ATTEMPTS - 1 && RETRYABLE_STATUSES.has(resp.status)) {
        continue;
      }
      // Final non-OK — fall out of loop, handled below.
      break;
    } else {
      lastErr = err;
      lastIsTimeout = !!isTimeout;
      // Retry network throws / timeouts once.
      if (attempt < MAX_ATTEMPTS - 1) continue;
      break;
    }
  }

  debug.phase1_elapsed_ms = Date.now() - p1Start;

  if (!html && lastStatus !== null && lastStatus !== 200) {
    // Final HTTP error after retries.
    debug.fetch_status = lastStatus;
    base.error = `Fetch failed: HTTP ${lastStatus}`;
    base.phase1_status = "error";
    if (policy.try_phase2 && (isHighFrictionDomain(domain) || lastStatus === 403 || lastStatus === 429 || lastStatus === 503)) {
      debug.phase1_fallthrough_to_phase2 = `http_${lastStatus}`;
      html = "";
    } else {
      base.final_resolution = "fetch_error";
      base.cache_ttl_hours = policy.blocked_cache_ttl_hours;
      return base;
    }
  } else if (!html && lastErr) {
    // Final network throw / timeout after retries.
    base.error = lastIsTimeout
      ? `Phase 1 fetch timed out after ${PHASE1_TIMEOUT_MS}ms`
      : `Fetch error: ${lastErr?.message || String(lastErr)}`;
    base.phase1_status = lastIsTimeout ? "timeout" : "error";
    if (policy.try_phase2 && isHighFrictionDomain(domain)) {
      debug.phase1_fallthrough_to_phase2 = lastIsTimeout ? "timeout" : "throw";
      html = "";
    } else {
      base.final_resolution = "fetch_error";
      base.cache_ttl_hours = policy.blocked_cache_ttl_hours;
      return base;
    }
  } else if (html && lastStatus === 200) {
    debug.fetch_status = 200;
  }

  // ── Bot-challenge detection ──
  const challenge = detectBotChallenge(html);
  debug.bot_challenge = challenge;
  let blockedByChallenge = challenge.blocked;
  let blockSignal = challenge.signal;
  if (blockedByChallenge) base.block_provider = blockSignal;

  const pageType = detectPageType(html, url);
  base.page_type = pageType;
  debug.page_type = pageType;
  debug.html_length = html.length;
  debug.is_walmart = isWalmart;
  debug.is_high_friction = isHighFrictionDomain(domain);

  // Hard stop for clearly non-product pages
  if (!blockedByChallenge && (pageType === "search" || pageType === "category" || pageType === "cart")) {
    base.title = extractTitle(html);
    base.image_url = extractImage(html);
    base.extraction_method = "skipped_non_product";
    base.error = `URL appears to be a ${pageType} page, not a single product page`;
    base.needs_review = true;
    base.review_reasons = [base.error];
    base.phase1_status = "skipped";
    base.final_resolution = "non_product_page";
    base.cache_ttl_hours = policy.blocked_cache_ttl_hours;
    return base;
  }

  let fallbackTitle = blockedByChallenge ? null : extractTitle(html);
  let fallbackImage = blockedByChallenge ? null : extractImage(html);

  // ── Phase 1: static extraction layers ──
  let result: Partial<ExtractionResult> | null = null;
  if (blockedByChallenge) {
    base.phase1_status = "blocked";
  } else {
    result = runExtractionLayers(html, isWalmart, debug);
    base.phase1_status = result?.price_current ? "success" : "no_price_found";
  }

  // ── Phase 2 escalation: browser rendering (policy-driven) ──
  let shouldEscalate = false;
  let escalateReason = "";
  if (!result?.price_current && policy.try_phase2) {
    if (blockedByChallenge) {
      shouldEscalate = true;
      escalateReason = `bot_challenge:${blockSignal}`;
    } else if (!policy.phase2_only_if_blocked) {
      shouldEscalate = true;
      escalateReason = "policy_high_friction_no_price";
    }
  }

  // Track granular Phase 2 outcome separately so we can set final_resolution precisely
  let phase2Outcome:
    | "not_attempted"
    | "skipped"
    | "blocked"
    | "timeout"
    | "render_failed"
    | "extract_failed"
    | "success" = "not_attempted";

  if (shouldEscalate) {
    debug.phase2_triggered = true;
    debug.phase2_reason = escalateReason;
    const renderOutcome = await browserRender(url, domain, debug);
    debug.phase2_outcome_kind = renderOutcome.kind;

    if (renderOutcome.kind === "skipped") {
      base.phase2_status = "skipped";
      phase2Outcome = "skipped";
    } else if (renderOutcome.kind === "timeout") {
      base.phase2_status = "timeout";
      phase2Outcome = "timeout";
    } else if (renderOutcome.kind === "render_failed") {
      base.phase2_status = "render_failed";
      phase2Outcome = "render_failed";
    } else {
      // ok — got HTML back; check for bot challenge before extracting
      const renderedHtml = renderOutcome.html;
      const structured = renderOutcome.structured;
      const renderedChallenge = detectBotChallenge(renderedHtml);
      debug.phase2_bot_challenge = renderedChallenge;

      // Fast path: if Firecrawl returned structured JSON with a price, trust it
      // (works around bot challenges that hide product data in HTML).
      if (structured?.price_current && Number(structured.price_current) > 0) {
        blockedByChallenge = false;
        html = renderedHtml;
        result = {
          price_current: Number(structured.price_current),
          price_original: structured.price_original ? Number(structured.price_original) : null,
          currency: structured.currency || null,
          title: structured.title || null,
          image_url: structured.image_url || null,
          availability: structured.availability || null,
          extraction_method: "browser_rendered_firecrawl_json",
        } as Partial<ExtractionResult>;
        if (!fallbackTitle && structured.title) fallbackTitle = structured.title;
        if (!fallbackImage && structured.image_url) fallbackImage = structured.image_url;
        base.phase2_status = "success";
        phase2Outcome = "success";
      } else if (renderedChallenge.blocked) {
        debug.phase2_still_blocked = renderedChallenge.signal;
        base.phase2_status = "blocked";
        base.block_provider = renderedChallenge.signal || base.block_provider;
        phase2Outcome = "blocked";
      } else {
        blockedByChallenge = false;
        html = renderedHtml;
        if (!fallbackTitle) fallbackTitle = extractTitle(renderedHtml);
        if (!fallbackImage) fallbackImage = extractImage(renderedHtml);
        const renderedResult = runExtractionLayers(renderedHtml, isWalmart, debug, "browser_rendered_");
        if (renderedResult?.price_current) {
          result = renderedResult;
          base.phase2_status = "success";
          phase2Outcome = "success";
        } else {
          base.phase2_status = "extract_failed";
          phase2Outcome = "extract_failed";
        }
      }
    }
  } else if (!result?.price_current && !policy.try_phase2) {
    debug.phase2_skipped = "policy_disallows";
  }

  // If still blocked / unrecoverable and no price, return a blocked-style result with precise resolution
  if (!result?.price_current && (blockedByChallenge || phase2Outcome === "timeout" || phase2Outcome === "render_failed" || phase2Outcome === "extract_failed")) {
    base.title = fallbackTitle;
    base.image_url = fallbackImage;

    // Decide the final resolution precisely based on what happened
    let resolution: FinalResolution;
    let methodTag = "blocked_bot_challenge";
    let userError: string;

    if (phase2Outcome === "timeout") {
      resolution = "phase2_timeout";
      methodTag = "phase2_timeout";
      userError = `Phase 2 browser rendering timed out for ${domain}. The site is reachable but did not respond in time.`;
    } else if (phase2Outcome === "render_failed") {
      resolution = "phase2_render_failed";
      methodTag = "phase2_render_failed";
      userError = `Phase 2 browser rendering failed (provider error) for ${domain}.`;
    } else if (phase2Outcome === "extract_failed") {
      resolution = "phase2_extract_failed";
      methodTag = "phase2_extract_failed";
      userError = `Phase 2 browser rendered the page but no reliable price was found for ${domain}.`;
    } else {
      // Bot-challenge blocked path
      const phase2Tried = !!debug.phase2_triggered;
      resolution = phase2Tried ? "blocked_phase2" : "blocked_phase1";
      userError = phase2Tried
        ? `Blocked by anti-bot challenge (${base.block_provider}) — Phase 2 browser rendering also blocked for ${domain}.`
        : `Blocked by anti-bot challenge (${blockSignal}) for ${domain}.${policy.try_phase2 ? "" : " Phase 2 disabled by domain policy."}`;
    }

    base.extraction_method = methodTag;
    base.final_resolution = resolution;
    base.error = userError;
    base.needs_review = true;
    base.review_reasons = [userError];
    base.cache_ttl_hours = policy.blocked_cache_ttl_hours;
    return base;
  }

  // ── AI fallback (only on unblocked content) ──
  if (!result?.price_current && !blockedByChallenge) {
    (debug.layers_tried as string[]).push("ai_fallback");
    const text = htmlToText(html);
    const aiResult = await aiFallback(text, url);
    if (aiResult?.price_current) {
      result = aiResult;
      debug.layers_succeeded = "ai_fallback";
    }
  }

  if (!result?.price_current) {
    base.title = fallbackTitle;
    base.image_url = fallbackImage;
    base.extraction_method = "failed";
    base.error = "Price not reliably found";
    base.needs_review = true;
    base.review_reasons = ["No reliable price extracted across all layers"];
    base.final_resolution = "not_found_unblocked";
    base.cache_ttl_hours = policy.blocked_cache_ttl_hours;
    return base;
  }

  const merged: ExtractionResult = {
    ...base,
    ...result,
    title: result.title || fallbackTitle,
    image_url: result.image_url || fallbackImage,
    extraction_method: result.extraction_method || "unknown",
    confidence_score: result.confidence_score ?? 0,
    availability: normalizeAvailability(html, result.availability ?? null),
    availability_status: deriveAvailabilityStatus(result.availability ?? null, html),
    debug,
    phase1_status: base.phase1_status,
    phase2_status: base.phase2_status,
    block_provider: null,
    final_resolution: "price_extracted",
    domain_policy: policy.name,
    cache_ttl_hours: policy.success_cache_ttl_hours,
  };

  const v = validateAndFlag(merged);
  merged.needs_review = v.needsReview;
  merged.review_reasons = v.reasons;
  return merged;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
    const INTERNAL_SECRET = Deno.env.get("INTERNAL_SYNC_SECRET") ?? "";

    const body = await req.json().catch(() => ({}));
    const rawUrl = String(body?.url || "").trim();

    // ── Auth: support either user JWT (UI) or internal-secret + user_id (server-to-server)
    const internalSecretHeader = req.headers.get("x-internal-secret") ?? "";
    const isInternalCall = INTERNAL_SECRET.length > 0 && internalSecretHeader === INTERNAL_SECRET;

    let user: { id: string } | null = null;
    if (isInternalCall) {
      const internalUserId = String(body?.user_id || "").trim();
      if (!internalUserId) {
        return new Response(JSON.stringify({ error: "internal call requires user_id in body" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      user = { id: internalUserId };
    } else {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const userClient = createClient(SUPABASE_URL, ANON, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user: u }, error: userErr } = await userClient.auth.getUser();
      if (userErr || !u) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      user = u;
    }
    const save = body?.save !== false;
    const force = body?.force === true; // bypass cache

    // MODULE ACCESS GUARD: supplier_discovery:run required for user-driven calls
    // (internal server-to-server calls already pass a verified user_id and skip the JWT check;
    // we still enforce module access for those to keep parity).
    {
      const guardClient = createClient(SUPABASE_URL, SERVICE_ROLE);
      const access = await checkModuleAccess(guardClient, user!.id, "supplier_discovery", "run");
      if (!access.allowed) {
        console.warn(`[extract-product-price] BLOCKED user=${user!.id} reason=${access.reason}`);
        return new Response(JSON.stringify({ error: access.reason || "Forbidden" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (!rawUrl) {
      return new Response(JSON.stringify({ error: "url is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let normalized: string;
    try {
      const u = new URL(rawUrl);
      if (!/^https?:$/.test(u.protocol)) throw new Error("Invalid protocol");
      normalized = u.toString();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid URL" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // ── Cache lookup with per-result TTL ──
    // Successful extractions cache for 24h, blocked/failed results cache for 1-3h (per domain policy).
    if (!force) {
      // Look back the longest possible TTL (24h) and filter by per-row TTL stored in raw_payload.
      const maxLookbackHours = 24;
      const cutoff = new Date(Date.now() - maxLookbackHours * 3600 * 1000).toISOString();
      const { data: cachedRows } = await admin
        .from("extracted_product_data")
        .select("*")
        .eq("user_id", user.id)
        .eq("url", normalized)
        .gte("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(1);

      const cached = cachedRows?.[0];
      if (cached) {
        const rp = (cached.raw_payload || {}) as Record<string, any>;
        const ttlHours: number = typeof rp.cache_ttl_hours === "number" ? rp.cache_ttl_hours : 24;
        const ageMs = Date.now() - new Date(cached.created_at).getTime();
        const isFresh = ageMs < ttlHours * 3600 * 1000;

        if (isFresh) {
          const cachedResult: ExtractionResult = {
            availability_status: (cached.availability_status as any) ?? "unknown",
            url: cached.url,
            domain: cached.domain,
            title: cached.title,
            price_current: cached.price_current,
            price_original: cached.price_original,
            currency: cached.currency,
            availability: cached.availability,
            image_url: cached.image_url,
            variant: cached.variant,
            extraction_method: cached.extraction_method,
            confidence_score: cached.confidence_score ?? 0,
            raw_price_text: cached.raw_price_text,
            raw_payload: cached.raw_payload as any,
            error: cached.error,
            cached: true,
            page_type: rp.page_type,
            needs_review: rp.needs_review,
            review_reasons: rp.review_reasons,
            phase1_status: rp.phase1_status,
            phase2_status: rp.phase2_status,
            block_provider: rp.block_provider,
            final_resolution: rp.final_resolution,
            domain_policy: rp.domain_policy,
            cache_ttl_hours: ttlHours,
            debug: rp.debug,
          };
          // Migrate legacy "error" phase2 status to a more specific value when possible
          if (cachedResult.phase2_status === "error") {
            if (cachedResult.final_resolution === "blocked_phase2") cachedResult.phase2_status = "blocked";
            else if (cachedResult.final_resolution === "phase2_timeout") cachedResult.phase2_status = "timeout";
            else if (cachedResult.final_resolution === "phase2_render_failed") cachedResult.phase2_status = "render_failed";
            else if (cachedResult.final_resolution === "phase2_extract_failed") cachedResult.phase2_status = "extract_failed";
          }
          // Always re-derive review reasons from current logic so cached rows
          // benefit from improvements (e.g. resolution-derived primary reason).
          const v = validateAndFlag(cachedResult);
          cachedResult.review_reasons = v.reasons;
          cachedResult.needs_review = v.needsReview;
          // Honest user-facing error string for blocked cached results
          if (!cachedResult.price_current && v.reasons[0]) {
            cachedResult.error = v.reasons[0];
          }
          return new Response(JSON.stringify(cachedResult), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    const result = await runPipeline(normalized);

    if (save) {
      try {
        await admin.from("extracted_product_data").insert({
          user_id: user.id,
          url: result.url,
          domain: result.domain,
          title: result.title,
          price_current: result.price_current,
          price_original: result.price_original,
          currency: result.currency,
          availability: result.availability,
          availability_status: result.availability_status ?? "unknown",
          image_url: result.image_url,
          variant: result.variant,
          extraction_method: result.extraction_method,
          confidence_score: result.confidence_score,
          raw_price_text: result.raw_price_text,
          raw_payload: {
            ...(result.raw_payload || {}),
            page_type: result.page_type,
            needs_review: result.needs_review,
            review_reasons: result.review_reasons,
            phase1_status: result.phase1_status,
            phase2_status: result.phase2_status,
            block_provider: result.block_provider,
            final_resolution: result.final_resolution,
            domain_policy: result.domain_policy,
            cache_ttl_hours: result.cache_ttl_hours,
            debug: result.debug,
          },
          error: result.error,
        });
      } catch (e) {
        console.error("Persist failed (non-fatal):", e);
      }
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("extract-product-price error:", e);
    return new Response(JSON.stringify({ error: e?.message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
