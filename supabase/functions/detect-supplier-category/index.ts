// Auto-detect supplier category from a product URL
// Pipeline: breadcrumb → JSON-LD → URL path → AI fallback
// Returns { name, path, url, confidence, source, breadcrumb_links }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type Confidence = "high" | "medium" | "low";
type Source = "breadcrumb" | "json_ld" | "url_path" | "ai";

interface DetectionResult {
  name: string | null;
  path: string | null;          // e.g. "Toys > Action Figures > Transformers"
  url: string | null;           // best category/collection URL discovered
  confidence: Confidence;
  source: Source;
  breadcrumb_links?: { label: string; href: string }[];
  reason?: string;
}

const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
const SCRAPINGBEE_API_KEY = Deno.env.get("SCRAPINGBEE_API_KEY");
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

async function fetchHtml(url: string): Promise<string | null> {
  // Prefer Firecrawl for clean HTML
  if (FIRECRAWL_API_KEY) {
    try {
      const r = await fetch("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${FIRECRAWL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url, formats: ["html"], onlyMainContent: false }),
      });
      if (r.ok) {
        const j = await r.json();
        const html = j?.data?.html || j?.html;
        if (typeof html === "string" && html.length > 200) return html;
      }
    } catch (e) {
      console.warn("[detect-supplier-category] Firecrawl failed:", e);
    }
  }
  // Fallback to ScrapingBee
  if (SCRAPINGBEE_API_KEY) {
    try {
      const sb = new URL("https://app.scrapingbee.com/api/v1/");
      sb.searchParams.set("api_key", SCRAPINGBEE_API_KEY);
      sb.searchParams.set("url", url);
      sb.searchParams.set("render_js", "false");
      const r = await fetch(sb.toString());
      if (r.ok) return await r.text();
    } catch (e) {
      console.warn("[detect-supplier-category] ScrapingBee failed:", e);
    }
  }
  return null;
}

// ---------- Layer 1: Breadcrumb ----------
function extractBreadcrumb(html: string, baseUrl: string): DetectionResult | null {
  // Try schema.org BreadcrumbList JSON-LD first (most reliable)
  const jsonLdMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatches) {
    for (const block of jsonLdMatches) {
      const inner = block.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "").trim();
      try {
        const parsed = JSON.parse(inner);
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        for (const node of candidates) {
          const items = node?.["@type"] === "BreadcrumbList" ? node.itemListElement : null;
          if (Array.isArray(items) && items.length > 0) {
            const labels: string[] = [];
            const links: { label: string; href: string }[] = [];
            for (const it of items) {
              const name = it?.name || it?.item?.name;
              const href = typeof it?.item === "string" ? it.item : it?.item?.["@id"];
              if (name && typeof name === "string") {
                labels.push(name.trim());
                if (href && typeof href === "string") links.push({ label: name.trim(), href });
              }
            }
            if (labels.length >= 2) {
              const lastLink = links[links.length - 1];
              return {
                name: labels[labels.length - 1],
                path: labels.join(" > "),
                url: lastLink?.href ? absUrl(lastLink.href, baseUrl) : null,
                confidence: "high",
                source: "breadcrumb",
                breadcrumb_links: links,
                reason: "schema.org BreadcrumbList",
              };
            }
          }
        }
      } catch { /* ignore malformed JSON-LD */ }
    }
  }

  // Try HTML breadcrumb nav patterns
  const navMatch = html.match(/<(nav|ol|ul)[^>]*(?:breadcrumb|aria-label=["']?breadcrumb["']?)[^>]*>([\s\S]*?)<\/\1>/i);
  if (navMatch) {
    const inner = navMatch[2];
    const links: { label: string; href: string }[] = [];
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = linkRegex.exec(inner)) !== null) {
      const href = m[1];
      const label = stripTags(m[2]).trim();
      if (label && href && !/^#/.test(href)) {
        links.push({ label, href: absUrl(href, baseUrl) });
      }
    }
    if (links.length >= 2) {
      const path = links.map((l) => l.label).join(" > ");
      const last = links[links.length - 1];
      return {
        name: last.label,
        path,
        url: last.href,
        confidence: "high",
        source: "breadcrumb",
        breadcrumb_links: links,
        reason: "HTML breadcrumb nav",
      };
    }
  }
  return null;
}

// ---------- Layer 2: JSON-LD Product.category ----------
function extractJsonLdCategory(html: string): DetectionResult | null {
  const matches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (!matches) return null;
  for (const block of matches) {
    const inner = block.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "").trim();
    try {
      const parsed = JSON.parse(inner);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of arr) {
        const types = ([] as string[]).concat(node?.["@type"] ?? []);
        if (types.includes("Product")) {
          const cat = node.category;
          if (typeof cat === "string" && cat.trim().length > 0) {
            const path = cat.replace(/\s*[>/]\s*/g, " > ").trim();
            const parts = path.split(" > ");
            return {
              name: parts[parts.length - 1],
              path,
              url: null,
              confidence: "high",
              source: "json_ld",
              reason: "Product.category in JSON-LD",
            };
          }
        }
      }
    } catch { /* ignore */ }
  }
  return null;
}

// ---------- Layer 3: URL path heuristics ----------
function extractFromUrl(productUrl: string): DetectionResult | null {
  try {
    const u = new URL(productUrl);
    const segments = u.pathname.split("/").filter(Boolean);
    // Common supplier patterns:
    //   target.com/p/<slug>/-/A-XXX        (no category in URL)
    //   target.com/c/<category-slug>/-/N-X  (category page)
    //   walmart.com/ip/<slug>/<id>          (no category)
    //   amazon.com/<slug>/dp/<asin>         (no category)
    //   shop.example.com/collections/<col>/products/<slug>
    const collectionsIdx = segments.indexOf("collections");
    if (collectionsIdx >= 0 && segments[collectionsIdx + 1]) {
      const slug = segments[collectionsIdx + 1];
      const name = humanizeSlug(slug);
      return {
        name,
        path: name,
        url: `${u.origin}/collections/${slug}`,
        confidence: "medium",
        source: "url_path",
        reason: "Shopify-style /collections/ path",
      };
    }
    const catIdx = segments.findIndex((s) => /^c$|^category$|^categories$|^cat$/i.test(s));
    if (catIdx >= 0 && segments[catIdx + 1]) {
      const slug = segments[catIdx + 1];
      const name = humanizeSlug(slug);
      return {
        name,
        path: name,
        url: `${u.origin}/${segments.slice(0, catIdx + 2).join("/")}`,
        confidence: "medium",
        source: "url_path",
        reason: "Generic /c/ or /category/ path",
      };
    }
    // Last resort: take 1st meaningful segment if it doesn't look like a product/SKU
    const first = segments[0];
    if (first && !/^p$|^ip$|^dp$|^product$|^products$/i.test(first) && first.length > 2 && !/^\d+$/.test(first)) {
      const name = humanizeSlug(first);
      return {
        name,
        path: name,
        url: `${u.origin}/${first}`,
        confidence: "low",
        source: "url_path",
        reason: "First URL segment heuristic",
      };
    }
  } catch { /* ignore */ }
  return null;
}

// ---------- Layer 4: AI fallback ----------
async function inferWithAI(html: string, productUrl: string): Promise<DetectionResult | null> {
  if (!LOVABLE_API_KEY) return null;
  // Compact the HTML: title + h1 + first meaningful paragraphs
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim().slice(0, 300);
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "").replace(/<[^>]+>/g, "").trim().slice(0, 300);
  const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? "").slice(0, 400);
  const ogType = (html.match(/<meta[^>]+property=["']og:type["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? "").slice(0, 100);

  const prompt = `Identify the most likely product category for this supplier page.
URL: ${productUrl}
Title: ${title}
H1: ${h1}
Description: ${metaDesc}
OG Type: ${ogType}

Respond with strict JSON: {"name": "<short category name>", "path": "<Top > Mid > Leaf>", "confidence": "low"}.
Use English. Path can be just the leaf if hierarchy is unclear.`;

  try {
    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "You are a product taxonomy classifier. Output only valid JSON." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) {
      console.warn("[detect-supplier-category] AI gateway error:", r.status);
      return null;
    }
    const j = await r.json();
    const content = j?.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content);
    if (parsed?.name) {
      return {
        name: String(parsed.name).slice(0, 120),
        path: parsed.path ? String(parsed.path).slice(0, 300) : String(parsed.name).slice(0, 120),
        url: null,
        confidence: "low",
        source: "ai",
        reason: "AI inference from title/meta",
      };
    }
  } catch (e) {
    console.warn("[detect-supplier-category] AI fallback failed:", e);
  }
  return null;
}

// ---------- Listing Verification ----------
// Tri-state: "verified" | "not_verified_first_page" (soft warning) | "failed" (hard)
type VerificationState = "verified" | "not_verified_first_page" | "failed";
type ListingVerification = {
  listing_verified: boolean; // true only when state === "verified"
  state: VerificationState;
  reason:
    | "verified_on_first_page"
    | "category_url_missing"
    | "listing_fetch_failed"
    | "product_id_not_extractable"
    | "not_present_on_first_page"
    | "extractor_inconclusive";
  category_url_checked: string | null;
  product_id_checked: string | null;
  product_link_count?: number;
  matched_via?: "product_id" | "url_path" | "url_full";
};

/** Try to pull a stable product identifier from the URL (ASIN, /p/123, /-/A-12345, /ip/12345, etc). */
function extractProductIdFromUrl(productUrl: string): { id: string | null; pathTail: string | null; full: string } {
  try {
    const u = new URL(productUrl);
    const segments = u.pathname.split("/").filter(Boolean);
    // Target: /-/A-12345678 → "A-12345678"
    const targetMatch = u.pathname.match(/\/-\/(A-\d+)/i);
    if (targetMatch) return { id: targetMatch[1], pathTail: targetMatch[1], full: u.pathname };
    // Amazon: /dp/ASIN or /gp/product/ASIN
    const amazonMatch = u.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})\b/i);
    if (amazonMatch) return { id: amazonMatch[1].toUpperCase(), pathTail: amazonMatch[1], full: u.pathname };
    // Walmart: /ip/<slug>/<numericId>
    const ipIdx = segments.indexOf("ip");
    if (ipIdx >= 0) {
      const tail = segments[segments.length - 1];
      if (/^\d{4,}$/.test(tail)) return { id: tail, pathTail: tail, full: u.pathname };
    }
    // Shopify: /products/<slug>
    const productsIdx = segments.indexOf("products");
    if (productsIdx >= 0 && segments[productsIdx + 1]) {
      const slug = segments[productsIdx + 1];
      return { id: slug, pathTail: slug, full: u.pathname };
    }
    // Generic: last segment if it looks like an id (long digit string or slug)
    const last = segments[segments.length - 1];
    if (last && (/^\d{4,}$/.test(last) || last.length >= 6)) {
      return { id: last, pathTail: last, full: u.pathname };
    }
    return { id: null, pathTail: null, full: u.pathname };
  } catch {
    return { id: null, pathTail: null, full: productUrl };
  }
}

async function verifyProductOnCategoryListing(
  categoryUrl: string | null,
  productUrl: string,
): Promise<ListingVerification> {
  const productId = extractProductIdFromUrl(productUrl);
  if (!categoryUrl) {
    return {
      listing_verified: false,
      state: "failed",
      reason: "category_url_missing",
      category_url_checked: null,
      product_id_checked: productId.id,
    };
  }
  const html = await fetchHtml(categoryUrl);
  if (!html) {
    return {
      listing_verified: false,
      state: "failed",
      reason: "listing_fetch_failed",
      category_url_checked: categoryUrl,
      product_id_checked: productId.id,
    };
  }

  // Count product-looking links to confirm we actually got a listing page
  const linkRegex = /href=["']([^"']+)["']/gi;
  const hrefs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html)) !== null) hrefs.push(m[1]);
  const productLinkCount = hrefs.filter((h) =>
    /\/(dp|gp\/product|p|ip|products)\//i.test(h) || /\/-\/A-\d+/i.test(h)
  ).length;

  if (!productId.id && !productId.pathTail) {
    return {
      listing_verified: false,
      state: "failed",
      reason: "product_id_not_extractable",
      category_url_checked: categoryUrl,
      product_id_checked: null,
      product_link_count: productLinkCount,
    };
  }

  const haystack = html;
  // Match by product id (most reliable)
  if (productId.id && haystack.includes(productId.id)) {
    return {
      listing_verified: true,
      state: "verified",
      reason: "verified_on_first_page",
      category_url_checked: categoryUrl,
      product_id_checked: productId.id,
      product_link_count: productLinkCount,
      matched_via: "product_id",
    };
  }
  // Fallback: match by full path tail
  if (productId.pathTail && haystack.includes(productId.pathTail)) {
    return {
      listing_verified: true,
      state: "verified",
      reason: "verified_on_first_page",
      category_url_checked: categoryUrl,
      product_id_checked: productId.id ?? productId.pathTail,
      product_link_count: productLinkCount,
      matched_via: "url_path",
    };
  }
  // Fallback: match by full pathname (for slug-based stores)
  if (productId.full && productId.full.length > 3 && haystack.includes(productId.full)) {
    return {
      listing_verified: true,
      state: "verified",
      reason: "verified_on_first_page",
      category_url_checked: categoryUrl,
      product_id_checked: productId.id ?? productId.full,
      product_link_count: productLinkCount,
      matched_via: "url_full",
    };
  }

  // Got a listing-looking page but didn't find the product on page 1.
  // This is a SOFT warning, not a failure. Many suppliers (Target, Walmart, Amazon)
  // paginate, personalize, or rotate listings — absence on page 1 ≠ wrong category.
  if (productLinkCount >= 3) {
    return {
      listing_verified: false,
      state: "not_verified_first_page",
      reason: "not_present_on_first_page",
      category_url_checked: categoryUrl,
      product_id_checked: productId.id,
      product_link_count: productLinkCount,
    };
  }
  return {
    listing_verified: false,
    state: "not_verified_first_page",
    reason: "extractor_inconclusive",
    category_url_checked: categoryUrl,
    product_id_checked: productId.id,
    product_link_count: productLinkCount,
  };
}

// ---------- Helpers ----------
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_+]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
function absUrl(href: string, base: string): string {
  try { return new URL(href, base).toString(); } catch { return href; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing auth" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const productUrl: string | undefined = body?.product_url;
    if (!productUrl || typeof productUrl !== "string") {
      return new Response(JSON.stringify({ error: "product_url required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    let parsed: URL;
    try { parsed = new URL(productUrl); }
    catch {
      return new Response(JSON.stringify({ error: "Invalid URL" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supplierDomain = parsed.hostname.replace(/^www\./, "");
    const html = await fetchHtml(productUrl);

    let result: DetectionResult | null = null;
    if (html) {
      // Layer 1: breadcrumb (strongest)
      result = extractBreadcrumb(html, productUrl);
      // Layer 2: JSON-LD Product.category
      if (!result) result = extractJsonLdCategory(html);
    }
    // Layer 3: URL path
    if (!result) result = extractFromUrl(productUrl);
    // Layer 4: AI fallback
    if (!result && html) result = await inferWithAI(html, productUrl);

    if (!result) {
      return new Response(JSON.stringify({
        ok: false,
        supplier_domain: supplierDomain,
        error: "Could not detect category from this URL",
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Layer 5: Listing verification — does the source product actually appear on the detected category URL?
    let verification: ListingVerification | null = null;
    try {
      verification = await verifyProductOnCategoryListing(result.url, productUrl);
    } catch (e) {
      console.warn("[detect-supplier-category] verification error:", e);
      verification = {
        listing_verified: false,
        state: "failed",
        reason: "listing_fetch_failed",
        category_url_checked: result.url,
        product_id_checked: null,
      };
    }

    // Confidence policy:
    //  - "verified"                → keep original confidence
    //  - "not_verified_first_page" → SOFT warning, do NOT downgrade (Target/Walmart/Amazon paginate)
    //  - "failed"                  → downgrade high → medium (real signal something is off)
    let finalConfidence = result.confidence;
    if (verification && verification.state === "failed" && result.confidence === "high") {
      finalConfidence = "medium";
    }

    const verification_status =
      verification?.state === "verified"
        ? "verified_from_listing"
        : verification?.state === "not_verified_first_page"
        ? "not_verified_first_page"
        : "verification_failed";

    return new Response(JSON.stringify({
      ok: true,
      supplier_domain: supplierDomain,
      detection: {
        ...result,
        confidence: finalConfidence,
        listing_verified: verification?.listing_verified ?? false,
        verification_status,
        verification,
      },
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("[detect-supplier-category] fatal:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? (e as Error).message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
