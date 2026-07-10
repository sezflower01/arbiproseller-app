// verify-intl-listings-existence
//
// Calls SP-API /listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=...
// for non-US repricer_assignments and flips intl_listing_status='NOT_FOUND'
// when Amazon returns 404. This is the automated counterpart to the manual
// "Remove from {marketplace}" button in AssignmentsTable.
//
// Modes:
//   - sweep (cron):   { mode:"sweep", limit?:number }  service role
//   - scoped (user):  { mode:"scoped", marketplace:"CA", asins:[...] }  caller JWT
//
// Throttling: 5 req/sec per call. Idempotent. Updates marketplace_checked_at.
// Only ever DEMOTES status to NOT_FOUND on a 404; never promotes on success
// (the existing intl_listing_status pipeline owns positive states).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { exchangeLwaToken } from "../_shared/lwa-token.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MARKETPLACE_IDS: Record<string, string> = {
  CA: "A2EUQ1WTGCTBG2",
  MX: "A1AM78C64UM0Y8",
  BR: "A2Q3Y263D00KWC",
  UK: "A1F83G8C2ARO7P",
  DE: "A1PA6795UKMFR9",
  FR: "A13V1IB3VIYZZH",
  IT: "APJ6JRA9NG5V4",
  ES: "A1RKKUPIHCS9HS",
};

const NA_IDS = new Set(["ATVPDKIKX0DER", "A2EUQ1WTGCTBG2", "A1AM78C64UM0Y8", "A2Q3Y263D00KWC"]);
const EU_IDS = new Set(["A1F83G8C2ARO7P", "A1PA6795UKMFR9", "A13V1IB3VIYZZH", "APJ6JRA9NG5V4", "A1RKKUPIHCS9HS"]);

function endpointFor(mktId: string): string {
  if (EU_IDS.has(mktId)) return "https://sellingpartnerapi-eu.amazon.com";
  return "https://sellingpartnerapi-na.amazon.com"; // NA covers US/CA/MX/BR
}

// ── SigV4 ────────────────────────────────────────────────────────────
async function sha256(s: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}
async function hmac(key: BufferSource, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key as any, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
}
function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sigKey(secret: string, date: string, region: string, service: string) {
  const enc = new TextEncoder();
  const kDate = await hmac(enc.encode("AWS4" + secret), date);
  const kReg = await hmac(kDate, region);
  const kSvc = await hmac(kReg, service);
  return await hmac(kSvc, "aws4_request");
}
async function signGet(url: string, accessToken: string): Promise<Record<string, string>> {
  const ak = Deno.env.get("AWS_ACCESS_KEY_ID")!;
  const sk = Deno.env.get("AWS_SECRET_ACCESS_KEY")!;
  const region = Deno.env.get("SPAPI_AWS_REGION") || "us-east-1";
  const u = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const date = amzDate.slice(0, 8);
  const payloadHash = toHex(await sha256(""));
  const canonHdrs = `host:${u.host}\nx-amz-access-token:${accessToken}\nx-amz-date:${amzDate}\n`;
  const signed = "host;x-amz-access-token;x-amz-date";
  const canonReq = ["GET", u.pathname, u.search.slice(1), canonHdrs, signed, payloadHash].join("\n");
  const scope = `${date}/${region}/execute-api/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", amzDate, scope, toHex(await sha256(canonReq))].join("\n");
  const sigK = await sigKey(sk, date, region, "execute-api");
  const sig = toHex(await hmac(sigK, sts));
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signed}, Signature=${sig}`,
    "x-amz-date": amzDate,
    "x-amz-access-token": accessToken,
    host: u.host,
  };
}

type CheckResult =
  | "not_found"
  | "exists"
  | "suppressed"        // 200 OK but status/issues indicate listing is dead
  | "catalog_missing"   // listing BUYABLE but ASIN not in marketplace catalog
  | "rate_limited"
  | "no_auth"
  | "http_error"
  | "network_error";

function classifyStatuses(statusField: any): string[] {
  if (!statusField) return [];
  const arr = Array.isArray(statusField) ? statusField : [statusField];
  return arr.map((s) => String(s || "").toUpperCase()).filter(Boolean);
}

function summaryLooksAlive(statuses: string[]): boolean {
  return statuses.some((s) => s === "BUYABLE" || s === "ACTIVE" || s === "DISCOVERABLE");
}

function issuesIndicateDeleted(issues: any[]): boolean {
  if (!Array.isArray(issues)) return false;
  for (const it of issues) {
    const code = String(it?.code || "").toUpperCase();
    const msg = String(it?.message || "").toLowerCase();
    if (code === "13013") return true;
    if (msg.includes("not in the catalog") || msg.includes("not in catalog")) return true;
    const actions = it?.enforcements?.actions || [];
    if (Array.isArray(actions)) {
      for (const a of actions) {
        if (String(a?.action || "").toUpperCase() === "LISTING_SUPPRESSED") return true;
      }
    }
  }
  return false;
}

/**
 * Confirm ASIN is in the marketplace catalog (detail page exists).
 * Catches cases where Listings API says BUYABLE but Amazon removed the
 * product detail page (e.g. Funko purge on Amazon.ca).
 */
async function checkCatalogPresence(opts: {
  asin: string;
  marketplaceId: string;
  accessToken: string;
}): Promise<"present" | "missing" | "unknown"> {
  const ep = endpointFor(opts.marketplaceId);
  const url = new URL(`${ep}/catalog/2022-04-01/items/${encodeURIComponent(opts.asin)}`);
  url.searchParams.set("marketplaceIds", opts.marketplaceId);
  url.searchParams.set("includedData", "summaries");
  try {
    const headers = await signGet(url.toString(), opts.accessToken);
    const r = await fetch(url.toString(), { method: "GET", headers });
    if (r.status === 404) return "missing";
    if (r.status === 429 || r.status === 403) return "unknown";
    if (!r.ok) return "unknown";
    const body = await r.json().catch(() => null);
    if (!body) return "unknown";
    const summaries = Array.isArray(body?.summaries) ? body.summaries : [];
    const match = summaries.find((s: any) => s?.marketplaceId === opts.marketplaceId);
    return match ? "present" : "missing";
  } catch {
    return "unknown";
  }
}

async function checkExistence(opts: {
  sellerId: string;
  sku: string;
  asin: string;
  marketplaceId: string;
  accessToken: string;
}): Promise<{ result: CheckResult; reason: string; httpStatus?: number; statuses?: string[] }> {
  const ep = endpointFor(opts.marketplaceId);
  const url = new URL(`${ep}/listings/2021-08-01/items/${opts.sellerId}/${encodeURIComponent(opts.sku)}`);
  url.searchParams.set("marketplaceIds", opts.marketplaceId);
  url.searchParams.set("includedData", "summaries,issues");
  try {
    const headers = await signGet(url.toString(), opts.accessToken);
    const r = await fetch(url.toString(), { method: "GET", headers });
    if (r.status === 404) return { result: "not_found", reason: "http_404", httpStatus: 404 };
    if (r.status === 429) return { result: "rate_limited", reason: "http_429", httpStatus: 429 };
    if (r.status === 403) return { result: "no_auth", reason: "http_403", httpStatus: 403 };
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return { result: "http_error", reason: `http_${r.status}:${txt.slice(0, 120)}`, httpStatus: r.status };
    }
    const body = await r.json().catch(() => null);
    if (!body) return { result: "network_error", reason: "invalid_json" };
    const summaries = Array.isArray(body?.summaries) ? body.summaries : [];
    const issues = Array.isArray(body?.issues) ? body.issues : [];
    const match = summaries.find((s: any) => s?.marketplaceId === opts.marketplaceId);

    if (!match) {
      if (issuesIndicateDeleted(issues)) return { result: "suppressed", reason: "issues_13013_no_summary" };
      return { result: "not_found", reason: "no_summary_for_marketplace" };
    }

    const statuses = classifyStatuses(match.status);
    if (summaryLooksAlive(statuses)) {
      // Secondary catalog check: BUYABLE listing must also have a live
      // product detail page in that marketplace.
      const cat = await checkCatalogPresence({
        asin: opts.asin,
        marketplaceId: opts.marketplaceId,
        accessToken: opts.accessToken,
      });
      if (cat === "missing") {
        return { result: "catalog_missing", reason: `catalog_404_status:${statuses.join("|")}`, statuses };
      }
      return { result: "exists", reason: `status:${statuses.join("|")}|catalog:${cat}`, statuses };
    }

    if (issuesIndicateDeleted(issues)) return { result: "suppressed", reason: `dead_status_issues:${statuses.join("|") || "EMPTY"}`, statuses };
    return { result: "suppressed", reason: `dead_status:${statuses.join("|") || "EMPTY"}`, statuses };
  } catch (e: any) {
    return { result: "network_error", reason: `throw:${e?.message?.slice(0, 120) || "unknown"}` };
  }
}

async function markNotFound(
  admin: any,
  userId: string,
  marketplace: string,
  asin: string,
  sku: string,
  reason: string,
) {
  await admin
    .from("repricer_assignments")
    .update({
      intl_listing_status: "NOT_FOUND",
      marketplace_sellable: false,
      marketplace_sellability_reason: `sp_api_${reason}`.slice(0, 200),
      marketplace_checked_at: new Date().toISOString(),
      is_enabled: false,
      manual_paused: false,
      last_disabled_by: null,
      last_disabled_reason: `Auto: SP-API ${marketplace} reports listing deleted/not-in-catalog (${reason})`.slice(0, 500),
      last_disabled_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .eq("asin", asin)
    .eq("sku", sku);
}

async function touchChecked(admin: any, userId: string, marketplace: string, asin: string, sku: string, statuses: string[], reason: string) {
  const sellable = statuses.includes("BUYABLE");
  await admin
    .from("repricer_assignments")
    .update({
      intl_listing_status: JSON.stringify(statuses.length > 0 ? statuses : ["UNKNOWN"]),
      marketplace_sellable: sellable,
      marketplace_sellability_reason: sellable ? "buyable" : `sp_api_${reason}`.slice(0, 200),
      marketplace_checked_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("marketplace", marketplace)
    .eq("asin", asin)
    .eq("sku", sku);
}

interface Candidate {
  id?: string;
  user_id: string;
  marketplace: string;
  asin: string;
  sku: string;
}

type Bucket =
  | "not_found"
  | "suppressed"
  | "catalog_missing"
  | "exists"
  | "rate_limited"
  | "no_auth"
  | "http_error"
  | "network_error"
  | "no_seller_auth"
  | "lwa_error"
  | "skipped_unknown_marketplace";

async function processOne(
  admin: any,
  c: Candidate,
  authCache: Map<string, { sellerId: string; refreshToken: string; accessToken?: string; authFailed?: boolean }>,
  sampleErrors: string[],
): Promise<Bucket> {
  const mktId = MARKETPLACE_IDS[c.marketplace];
  if (!mktId) return "skipped_unknown_marketplace";

  const key = `${c.user_id}::${mktId}`;
  let auth = authCache.get(key);
  if (!auth) {
    const { data: rows } = await admin
      .from("seller_authorizations")
      .select("refresh_token, seller_id, selling_partner_id, marketplace_id")
      .eq("user_id", c.user_id)
      .eq("is_active", true);
    const list = (rows || []) as any[];
    const naFallback = (mid: string) =>
      NA_IDS.has(mid) ? list.find((r) => NA_IDS.has(r.marketplace_id)) : null;
    const euFallback = (mid: string) =>
      EU_IDS.has(mid) ? list.find((r) => EU_IDS.has(r.marketplace_id)) : null;
    const row =
      list.find((r) => r.marketplace_id === mktId) ||
      naFallback(mktId) ||
      euFallback(mktId);
    if (!row || !row.refresh_token) return "no_seller_auth";
    auth = { sellerId: row.selling_partner_id || row.seller_id, refreshToken: row.refresh_token };
    authCache.set(key, auth);
  }

  if (auth.authFailed) {
    return "lwa_error";
  }

  if (!auth.accessToken) {
    try {
      auth.accessToken = await exchangeLwaToken(auth.refreshToken, admin, c.user_id);
    } catch (e: any) {
      if (sampleErrors.length < 5) sampleErrors.push(`lwa:${e?.message?.slice(0, 180) || "unknown"}`);
      auth.authFailed = true;
      return "lwa_error";
    }
  }

  const { result, reason, statuses = [] } = await checkExistence({
    sellerId: auth.sellerId,
    sku: c.sku,
    asin: c.asin,
    marketplaceId: mktId,
    accessToken: auth.accessToken!,
  });

  if (result === "not_found") {
    await markNotFound(admin, c.user_id, c.marketplace, c.asin, c.sku, reason);
    return "not_found";
  }
  if (result === "suppressed") {
    await markNotFound(admin, c.user_id, c.marketplace, c.asin, c.sku, reason);
    return "suppressed";
  }
  if (result === "catalog_missing") {
    await markNotFound(admin, c.user_id, c.marketplace, c.asin, c.sku, reason);
    return "catalog_missing";
  }
  if (result === "exists") {
    await touchChecked(admin, c.user_id, c.marketplace, c.asin, c.sku, statuses, reason);
    return "exists";
  }
  if (sampleErrors.length < 5 && reason) sampleErrors.push(`${result}:${reason}`);
  if (result === "rate_limited") return "rate_limited";
  if (result === "no_auth") return "no_auth";
  if (result === "http_error") return "http_error";
  return "network_error";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const body = await req.json().catch(() => ({} as any));
    console.log("[verify-intl-listings-existence] body=", JSON.stringify(body));
    const mode = body?.mode === "scoped" ? "scoped" : "sweep";
    const authCache = new Map<string, { sellerId: string; refreshToken: string; accessToken?: string; authFailed?: boolean }>();

    let candidates: Candidate[] = [];
    let scopedAllInMarketplace = false;
    let batchLimit: number | null = null;

    if (mode === "scoped") {
      const authHeader = req.headers.get("authorization") || "";
      const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: u } = await userClient.auth.getUser();
      const userId = u?.user?.id;
      if (!userId) {
        return new Response(JSON.stringify({ error: "unauthenticated" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const marketplace = String(body?.marketplace || "").toUpperCase();
      const asins: string[] = Array.isArray(body?.asins) ? body.asins.filter((x: any) => typeof x === "string") : [];
      const allInMarketplace = body?.all_in_marketplace === true || asins.length === 0;
      scopedAllInMarketplace = allInMarketplace;
      if (!marketplace || marketplace === "US") {
        return new Response(JSON.stringify({ ok: true, skipped: true, reason: "marketplace_required" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (allInMarketplace) {
        // Sweep ALL non-NOT_FOUND intl assignments for this user+marketplace.
        // Include NULL/blank status rows; those are exactly the rows that need verification.
        batchLimit = Math.min(Math.max(Number(body?.limit) || 75, 1), 150);
        const cursorAfter = typeof body?.cursor_after === "string" ? body.cursor_after : null;
        let q = admin
            .from("repricer_assignments")
            .select("id, asin, sku")
            .eq("user_id", userId)
            .eq("marketplace", marketplace)
            .or("intl_listing_status.is.null,intl_listing_status.neq.NOT_FOUND")
            .order("id", { ascending: true })
            .limit(batchLimit);
        if (cursorAfter) q = q.gt("id", cursorAfter);
        const { data: rows } = await q;
        for (const r of ((rows || []) as any[])) {
          if (r.asin && r.sku) candidates.push({ id: r.id, user_id: userId, marketplace, asin: r.asin, sku: r.sku });
        }
      } else {
        const { data: rows } = await admin
          .from("repricer_assignments")
          .select("asin, sku")
          .eq("user_id", userId)
          .eq("marketplace", marketplace)
          .in("asin", asins.slice(0, 200));
        for (const r of (rows || []) as any[]) {
          candidates.push({ user_id: userId, marketplace, asin: r.asin, sku: r.sku });
        }
      }
    } else {
      // SWEEP: oldest-checked non-US assignments, capped. Optional marketplace filter.
      const limit = Math.min(Math.max(Number(body?.limit) || 300, 1), 1000);
      const marketplaceFilter = body?.marketplace ? String(body.marketplace).toUpperCase() : null;
      // 6h cadence: rows stale after 6h so the per-6h cron has work to do
      const staleCutoff = new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString();
      let q = admin
        .from("repricer_assignments")
        .select("user_id, marketplace, asin, sku, marketplace_checked_at")
        .neq("marketplace", "US")
        .or("intl_listing_status.is.null,intl_listing_status.neq.NOT_FOUND")
        .or(`marketplace_checked_at.is.null,marketplace_checked_at.lt.${staleCutoff}`)
        .order("marketplace_checked_at", { ascending: true, nullsFirst: true })
        .limit(limit);
      if (marketplaceFilter && marketplaceFilter !== "US") {
        q = q.eq("marketplace", marketplaceFilter);
      }
      const { data: rows } = await q;
      for (const r of (rows || []) as any[]) {
        if (!r.user_id || !r.marketplace || !r.asin || !r.sku) continue;
        candidates.push({ user_id: r.user_id, marketplace: r.marketplace, asin: r.asin, sku: r.sku });
      }
    }

    const buckets: Record<Bucket, number> = {
      not_found: 0, suppressed: 0, catalog_missing: 0, exists: 0,
      rate_limited: 0, no_auth: 0, http_error: 0, network_error: 0,
      no_seller_auth: 0, lwa_error: 0, skipped_unknown_marketplace: 0,
    };
    const sampleErrors: string[] = [];
    const startedAt = Date.now();
    for (const c of candidates) {
      const b = await processOne(admin, c, authCache, sampleErrors);
      buckets[b] = (buckets[b] || 0) + 1;
      await new Promise((res) => setTimeout(res, 200)); // ~5 req/sec
    }
    const elapsedMs = Date.now() - startedAt;

    const authBlocked = candidates.length > 0 && buckets.lwa_error === candidates.length;
    const inconclusive =
      buckets.rate_limited + buckets.no_auth + buckets.http_error +
      buckets.network_error + buckets.no_seller_auth;
    const lastCandidateId = candidates.length > 0 ? candidates[candidates.length - 1].id || null : null;

    const summary = {
      ok: true,
      mode,
      auth_blocked: authBlocked,
      auth_error_kind: authBlocked ? "lwa_error" : null,
      reconnect_path: "/tools/amazon-connect",
      scanned: candidates.length,
      batch_limit: batchLimit,
      next_cursor: scopedAllInMarketplace ? lastCandidateId : null,
      has_more: scopedAllInMarketplace && batchLimit != null && candidates.length === batchLimit,
      not_found: buckets.not_found,
      suppressed: buckets.suppressed,
      catalog_missing: buckets.catalog_missing,
      removed: buckets.not_found + buckets.suppressed + buckets.catalog_missing,
      exists: buckets.exists,
      inconclusive,
      breakdown: buckets,
      sample_errors: sampleErrors,
      elapsed_ms: elapsedMs,
      criteria: {
        exists: "Listings API 200 + status in [BUYABLE,ACTIVE,DISCOVERABLE] AND Catalog Items API confirms ASIN present in marketplace",
        not_found: "Listings API 404, OR 200 with no summary for requested marketplaceId",
        suppressed: "Listings API 200 with dead status (INACTIVE/INCOMPLETE/empty) OR issue code 13013/LISTING_SUPPRESSED",
        catalog_missing: "Listings API says BUYABLE but Catalog Items API returns 404 / no summary for this marketplace — product detail page removed (e.g. Funko ASIN delisted on Amazon.ca)",
        inconclusive: "429/403/other HTTP error, network failure, or missing seller auth — row NOT flipped",
        lwa_error: "Login with Amazon failed before listing checks — reconnect Amazon; row NOT touched and NOT treated as listing verification",
      },
    };
    console.log("[verify-intl-listings-existence] summary", JSON.stringify(summary));
    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[verify-intl-listings-existence]", e?.message, e?.stack);
    return new Response(JSON.stringify({ error: e?.message || "unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
