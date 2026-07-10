// Phase 1: Category diff scan
// Fetches category pages via Firecrawl (only active scraper), extracts product
// cards, diffs against category_products, queues changed/new items for PDP refresh.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Quota / provider error classification — surfaced to UI so users can see the real reason.
type ProviderErrorKind = "quota_exhausted" | "rate_limited" | "auth_failed" | "blocked" | "transient" | "unknown";
function classifyProviderError(provider: string, status: number, body: string): ProviderErrorKind {
  const b = (body || "").toLowerCase();
  if (status === 401 || /api[_ -]?key|unauthor|invalid token|monthly.*limit|credit/i.test(b)) {
    if (/limit|credit|quota|exhaust|monthly|exceed/i.test(b)) return "quota_exhausted";
    return "auth_failed";
  }
  if (status === 402 || /payment|insufficient|credit|quota|exhaust|monthly/i.test(b)) return "quota_exhausted";
  if (status === 429) return "rate_limited";
  if (status === 403) return "blocked";
  if (status >= 500) return "transient";
  return "unknown";
}

// ----- Helpers -----
// Keep this canonicalizer in sync with store-scan-run/normalizeUrlKey
// (URL_KEY_VERSION = 2). Bump versions together when the rules change.
const URL_KEY_VERSION = 2;
const TRACKING_PARAMS = [
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "ref", "ref_", "tag", "linkCode", "psc", "gclid", "fbclid", "afid",
  "ascsubtag", "source", "lnk", "clkid", "trkid", "preselect",
  "sid", "scid", "sscid", "cm_mmc", "cm_sp", "icid", "intcmp",
  "mc_cid", "mc_eid", "mkt_tok", "_branch_match_id", "_ga", "_gl",
  "yclid", "msclkid", "dclid", "igshid", "spm", "pf_rd_p", "pf_rd_r",
  "pd_rd_w", "pd_rd_wg", "pd_rd_r", "pd_rd_i", "th", "qid", "sr",
];
function normalizeUrlKey(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));
    const entries = [...u.searchParams.entries()].sort(([ak, av], [bk, bv]) => {
      if (ak === bk) return av.localeCompare(bv);
      return ak.localeCompare(bk);
    });
    const search = entries.length > 0
      ? `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`
      : "";
    let path = (u.pathname || "/").replace(/\/+$/g, "");
    if (!path) path = "/";
    const host = u.host.toLowerCase().replace(/^www\./, "");
    return `${host}${path}${search}`;
  } catch {
    return String(raw ?? "")
      .trim()
      .toLowerCase()
      .replace(/#.*$/, "")
      .replace(/\/+$/g, "");
  }
}

function normalizeTitle(s?: string | null): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizePrice(p?: number | null): string {
  if (p == null || isNaN(Number(p))) return "";
  return Number(p).toFixed(2);
}

function normalizeAvailability(s?: string | null): string {
  return (s ?? "").trim().toLowerCase();
}

async function sha1(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function makeFingerprint(p: {
  url_key: string;
  title?: string | null;
  price?: number | null;
  availability?: string | null;
}): Promise<string> {
  const payload = [
    p.url_key,
    normalizeTitle(p.title),
    normalizePrice(p.price),
    normalizeAvailability(p.availability),
  ].join("||");
  return sha1(payload);
}

interface ExtractedCard {
  url: string;
  title?: string;
  price?: number;
  image?: string;
  availability?: string;
  productId?: string;
}

// ----- Firecrawl fetch (sole scraper) -----
async function fetchHtmlViaFirecrawl(url: string): Promise<{ html: string; cost: number }> {
  if (!FIRECRAWL_API_KEY) {
    const err = new Error("firecrawl_not_configured: FIRECRAWL_API_KEY missing");
    (err as any).provider = "firecrawl";
    (err as any).kind = "auth_failed";
    throw err;
  }
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
      waitFor: 2500,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const kind = classifyProviderError("firecrawl", res.status, text);
    const err = new Error(`firecrawl_${kind} ${res.status}: ${text.slice(0, 200)}`);
    (err as any).provider = "firecrawl";
    (err as any).kind = kind;
    (err as any).status = res.status;
    throw err;
  }
  const data = await res.json().catch(() => null) as { data?: { html?: string }; html?: string } | null;
  const html = (data?.data?.html ?? data?.html ?? "") as string;
  if (!html || html.length < 500) {
    const err = new Error(`firecrawl_empty: returned ${html?.length ?? 0} bytes`);
    (err as any).provider = "firecrawl";
    (err as any).kind = "transient";
    throw err;
  }
  // Firecrawl scrape ≈ 1 credit, very rough USD estimate
  return { html, cost: 0.002 };
}

// ----- Single-provider fetch (Firecrawl only) -----
interface FetchResult {
  html: string;
  cost: number;
  via: "firecrawl";
}
async function fetchHtmlSingleProvider(
  url: string,
  errorBag: { lastProvider: string | null; lastKind: ProviderErrorKind | null; lastMessage: string | null },
): Promise<FetchResult> {
  try {
    const r = await fetchHtmlViaFirecrawl(url);
    errorBag.lastProvider = null;
    errorBag.lastKind = null;
    errorBag.lastMessage = null;
    return { html: r.html, cost: r.cost, via: "firecrawl" };
  } catch (e) {
    const provider = (e as any)?.provider ?? "firecrawl";
    const kind = ((e as any)?.kind ?? "unknown") as ProviderErrorKind;
    const msg = e instanceof Error ? (e as Error).message : String(e);
    errorBag.lastProvider = provider;
    errorBag.lastKind = kind;
    errorBag.lastMessage = msg;
    console.error(`[diff-scan] firecrawl failed (${kind}) for ${url}: ${msg.slice(0, 200)}`);
    throw e;
  }
}

// ----- Generic card extraction -----
// Phase 1: best-effort generic extraction. Per-supplier extractors can be added later.
function extractProductCards(html: string, baseUrl: string): ExtractedCard[] {
  const cards: ExtractedCard[] = [];
  const seen = new Set<string>();

  // Strategy: find anchors that look like product links + try to grab nearby price text
  // Very permissive — Phase 1 goal is to validate the diff pipeline, not perfect extraction.
  const linkRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const priceRe = /\$\s?(\d{1,4}(?:,\d{3})*(?:\.\d{2})?)/;
  const imgRe = /<img[^>]+src=["']([^"']+)["']/i;

  let match: RegExpExecArray | null;
  const baseHost = (() => { try { return new URL(baseUrl).host; } catch { return ""; } })();

  while ((match = linkRe.exec(html)) !== null) {
    const rawHref = match[1];
    const inner = match[2];
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) continue;

    let absUrl: string;
    try {
      absUrl = new URL(rawHref, baseUrl).toString();
    } catch {
      continue;
    }

    // Filter to same host (skip external)
    let host = "";
    try { host = new URL(absUrl).host; } catch { continue; }
    if (baseHost && host !== baseHost) continue;

    // Heuristic: product URLs usually contain /p/, /product, /dp/, or end with id-like segment
    const path = (() => { try { return new URL(absUrl).pathname; } catch { return ""; } })();
    const looksProduct =
      /\/(p|dp|product|products|item|items|pd|pdp)\b/i.test(path) ||
      /\/[A-Z0-9]{6,}/.test(path);
    if (!looksProduct) continue;

    const key = normalizeUrlKey(absUrl);
    if (seen.has(key)) continue;
    seen.add(key);

    // Title = anchor text content stripped
    const titleText = inner
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Price: look in a 600-char window around the link
    const start = Math.max(0, match.index - 300);
    const end = Math.min(html.length, match.index + match[0].length + 300);
    const window = html.slice(start, end);
    const pm = window.match(priceRe);
    const price = pm ? Number(pm[1].replace(/,/g, "")) : undefined;

    // Image
    const im = window.match(imgRe);
    let image: string | undefined;
    if (im) {
      try { image = new URL(im[1], baseUrl).toString(); } catch { /* ignore */ }
    }

    cards.push({
      url: absUrl,
      title: titleText || undefined,
      price: Number.isFinite(price) ? price : undefined,
      image,
    });
  }

  return cards;
}

// ----- Main handler -----
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startMs = Date.now();
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  try {
    // Auth: require admin user JWT
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) {
      return new Response(JSON.stringify({ error: "Missing Authorization" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    // Allow both admins and regular authenticated users to trigger scans on
    // admin-curated categories. URLs stay hidden behind category_id.
    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    const isAdmin = !!roleRow;

    const body = await req.json().catch(() => ({}));
    const categoryId: string | undefined = body.category_id;
    if (!categoryId) {
      return new Response(JSON.stringify({ error: "category_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load category
    const { data: cat, error: catErr } = await supabase
      .from("scan_categories")
      .select("id, name, supplier_domain, urls, scan_tier, is_active")
      .eq("id", categoryId)
      .maybeSingle();
    if (catErr || !cat) {
      return new Response(JSON.stringify({ error: "Category not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Acquire lock by inserting a 'running' job (uq partial index enforces single)
    const { data: jobRow, error: jobErr } = await supabase
      .from("category_scan_jobs")
      .insert({
        category_id: categoryId,
        scan_type: "diff",
        triggered_by: isAdmin ? "manual" : "user",
        triggered_by_user: userId,
        scraper_provider: "firecrawl",
      })
      .select("id")
      .maybeSingle();

    if (jobErr || !jobRow) {
      return new Response(JSON.stringify({
        error: "Could not acquire scan lock — another scan is already running for this category.",
      }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const jobId = jobRow.id;

    let added = 0, removed = 0, changed = 0, unchanged = 0;
    let fetchFailed = 0, parseFailed = 0, pdpQueued = 0;
    let totalCost = 0;
    let lastError: string | null = null;
    let missPassSkipped = false;
    let missPassSkipReason: string | null = null;
    // Provider error tracking — surfaced to the UI so users can distinguish
    // "0 results" from "scraper quota exhausted".
    let lastProviderError: { provider: string; kind: ProviderErrorKind; message: string } | null = null;
    let firecrawlSuccessCount = 0;

    try {
      // Aggregate cards across all category URLs
      const allCards = new Map<string, ExtractedCard>();
      for (const url of cat.urls ?? []) {
        const errorBag: { lastProvider: string | null; lastKind: ProviderErrorKind | null; lastMessage: string | null } =
          { lastProvider: null, lastKind: null, lastMessage: null };
        try {
          const { html, cost } = await fetchHtmlSingleProvider(url, errorBag);
          totalCost += cost;
          firecrawlSuccessCount++;
          const cards = extractProductCards(html, url);
          if (cards.length === 0) parseFailed++;
          for (const c of cards) {
            const k = normalizeUrlKey(c.url);
            if (!allCards.has(k)) allCards.set(k, c);
          }
        } catch (e) {
          fetchFailed++;
          const msg = e instanceof Error ? (e as Error).message : String(e);
          lastError = msg;
          if (errorBag.lastProvider) {
            lastProviderError = {
              provider: errorBag.lastProvider,
              kind: errorBag.lastKind ?? "unknown",
              message: errorBag.lastMessage ?? msg,
            };
          }
          console.error(`[diff-scan] fetch failed for ${url}:`, msg);
        }
      }

      const extractedCount = allCards.size;

      // Look up previous successful run's extracted count for partial-parse detection
      const { data: prevJob } = await supabase
        .from("category_scan_jobs")
        .select("extracted_count")
        .eq("category_id", categoryId)
        .eq("status", "completed")
        .eq("miss_pass_skipped", false)
        .gt("extracted_count", 0)
        .order("completed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const previousExtractedCount: number | null = prevJob?.extracted_count ?? null;

      // Load existing products for this category
      const { data: existing } = await supabase
        .from("category_products")
        .select("id, url_key, current_title, current_price, availability, fingerprint, status, miss_count")
        .eq("category_id", categoryId);

      const existingByKey = new Map<string, NonNullable<typeof existing>[number]>();
      (existing ?? []).forEach((row) => existingByKey.set(row.url_key, row));

      const seenKeys = new Set<string>();
      const now = new Date().toISOString();

      // Process scanned cards
      for (const [urlKey, card] of allCards.entries()) {
        seenKeys.add(urlKey);
        const newFp = await makeFingerprint({
          url_key: urlKey,
          title: card.title,
          price: card.price,
          availability: card.availability,
        });

        const prev = existingByKey.get(urlKey);
        if (!prev) {
          // NEW
          const { data: ins } = await supabase
            .from("category_products")
            .insert({
              category_id: categoryId,
              supplier_domain: cat.supplier_domain,
              url_key: urlKey,
              product_url: card.url,
              current_title: card.title,
              current_price: card.price,
              current_image: card.image,
              availability: card.availability,
              fingerprint: newFp,
              status: "active",
              miss_count: 0,
              pending_pdp_refresh: true,
              pdp_refresh_reason: "new_product",
              first_seen_at: now,
              last_seen_at: now,
              last_checked_at: now,
            })
            .select("id")
            .maybeSingle();
          if (ins) { added++; pdpQueued++; }
        } else if (prev.fingerprint !== newFp) {
          // CHANGED — log per-field diffs and mark for PDP refresh
          const updates: Record<string, unknown> = {
            current_title: card.title ?? prev.current_title,
            current_price: card.price ?? prev.current_price,
            current_image: card.image,
            availability: card.availability ?? prev.availability,
            fingerprint: newFp,
            status: "active",
            miss_count: 0,
            pending_pdp_refresh: true,
            pdp_refresh_reason: "fingerprint_changed",
            last_seen_at: now,
            last_checked_at: now,
          };
          await supabase.from("category_products").update(updates).eq("id", prev.id);

          const logRows: Array<Record<string, unknown>> = [];
          if (normalizePrice(prev.current_price) !== normalizePrice(card.price ?? null)) {
            logRows.push({
              product_id: prev.id, category_id: categoryId, scan_job_id: jobId,
              changed_field: "price",
              old_value: prev.current_price?.toString() ?? null,
              new_value: card.price?.toString() ?? null,
            });
          }
          if (normalizeTitle(prev.current_title) !== normalizeTitle(card.title)) {
            logRows.push({
              product_id: prev.id, category_id: categoryId, scan_job_id: jobId,
              changed_field: "title",
              old_value: prev.current_title ?? null,
              new_value: card.title ?? null,
            });
          }
          if (normalizeAvailability(prev.availability) !== normalizeAvailability(card.availability)) {
            logRows.push({
              product_id: prev.id, category_id: categoryId, scan_job_id: jobId,
              changed_field: "availability",
              old_value: prev.availability ?? null,
              new_value: card.availability ?? null,
            });
          }
          if (logRows.length > 0) {
            await supabase.from("product_change_log").insert(logRows);
          }
          changed++; pdpQueued++;
        } else {
          // UNCHANGED — bump last_seen / last_checked, clear miss_count
          await supabase
            .from("category_products")
            .update({ last_seen_at: now, last_checked_at: now, miss_count: 0, status: "active" })
            .eq("id", prev.id);
          unchanged++;
        }
      }

      // Soft-remove guards: skip miss-count increment if data is untrustworthy.
      // - fetch_failed: any URL fetch errored → unfair to penalize missing items
      // - parse_failed: any URL returned zero cards → likely extractor breakage
      // - partial_parse: this run extracted < 30% of last successful run → likely partial breakage
      if (fetchFailed > 0) {
        missPassSkipped = true;
        missPassSkipReason = "fetch_failed";
      } else if (parseFailed > 0) {
        missPassSkipped = true;
        missPassSkipReason = "parse_failed";
      } else if (
        previousExtractedCount != null &&
        previousExtractedCount > 0 &&
        extractedCount < Math.ceil(previousExtractedCount * 0.3)
      ) {
        missPassSkipped = true;
        missPassSkipReason = "partial_parse";
      }

      if (!missPassSkipped) {
        // Handle missing rows (soft-remove after 3 misses)
        for (const [key, prev] of existingByKey.entries()) {
          if (seenKeys.has(key)) continue;
          if (prev.status === "removed") continue;
          const newMiss = (prev.miss_count ?? 0) + 1;
          const shouldRemove = newMiss >= 3;
          await supabase
            .from("category_products")
            .update({
              miss_count: newMiss,
              status: shouldRemove ? "removed" : prev.status,
              last_checked_at: now,
            })
            .eq("id", prev.id);
          if (shouldRemove) removed++;
        }
      } else {
        console.warn(
          `[diff-scan] miss pass SKIPPED for category ${categoryId} — reason=${missPassSkipReason} ` +
          `(extracted=${extractedCount}, prev=${previousExtractedCount ?? "n/a"}, fetchFail=${fetchFailed}, parseFail=${parseFailed})`
        );
      }

      // Update category freshness
      await supabase
        .from("scan_categories")
        .update({
          last_scanned_at: now,
          last_successful_scan_at: now,
        })
        .eq("id", categoryId);

      // Complete job — Firecrawl is the only active provider in this flow.
      const duration = Date.now() - startMs;
      const effectiveProvider = "firecrawl";
      await supabase
        .from("category_scan_jobs")
        .update({
          status: "completed",
          added_count: added,
          removed_count: removed,
          changed_count: changed,
          unchanged_count: unchanged,
          fetch_failed_count: fetchFailed,
          parse_failed_count: parseFailed,
          pdp_queued_count: pdpQueued,
          duration_ms: duration,
          estimated_cost: totalCost,
          completed_at: now,
          error: lastError,
          miss_pass_skipped: missPassSkipped,
          miss_pass_skip_reason: missPassSkipReason,
          extracted_count: extractedCount,
          previous_extracted_count: previousExtractedCount,
          scraper_provider: effectiveProvider,
        })
        .eq("id", jobId);

      return new Response(JSON.stringify({
        success: true,
        job_id: jobId,
        stats: {
          added, removed, changed, unchanged,
          fetch_failed: fetchFailed, parse_failed: parseFailed,
          pdp_queued: pdpQueued, duration_ms: duration, estimated_cost: totalCost,
          extracted_count: extractedCount,
          previous_extracted_count: previousExtractedCount,
          miss_pass_skipped: missPassSkipped,
          miss_pass_skip_reason: missPassSkipReason,
          scraper_provider: effectiveProvider,
          firecrawl_success: firecrawlSuccessCount,
        },
        provider_error: lastProviderError, // null when everything succeeded
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (innerErr) {
      const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
      await supabase
        .from("category_scan_jobs")
        .update({
          status: "failed",
          error: msg,
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - startMs,
          added_count: added, removed_count: removed, changed_count: changed,
          unchanged_count: unchanged, fetch_failed_count: fetchFailed,
          parse_failed_count: parseFailed, pdp_queued_count: pdpQueued,
          estimated_cost: totalCost,
          miss_pass_skipped: missPassSkipped,
          miss_pass_skip_reason: missPassSkipReason,
        })
        .eq("id", jobId);
      throw innerErr;
    }
  } catch (e) {
    const msg = e instanceof Error ? (e as Error).message : String(e);
    console.error("[category-diff-scan] error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
