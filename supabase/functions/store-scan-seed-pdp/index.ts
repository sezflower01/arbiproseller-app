// PDP-seeded fallback for Store Scan.
// When a category crawl misses a product (e.g. Target hides certain Funkos
// from the action-figures listing pages), an admin can paste the PDP URL
// here to inject it directly into the curated scan results.
//
// Flow:
//   1. Auth caller (must be admin).
//   2. Resolve target supplier_domain + category from the PDP URL.
//   3. Find or create a long-lived "manual_seed" run for that category
//      (one per admin per category; reused across seeds so it stays light).
//   4. Insert a `pending` store_scan_items row tied to that run.
//   5. Trigger store-scan-run in `process_chunk` mode so the matcher runs.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const INTERNAL_SYNC_SECRET = Deno.env.get("INTERNAL_SYNC_SECRET") ?? "";

interface SeedRequest {
  pdp_url: string;
  category_id?: string; // optional override; otherwise inferred from URL
}

// Keep in sync with store-scan-run/normalizeUrlKey (URL_KEY_VERSION = 2).
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

function normalizeDomain(raw: string): string {
  try {
    const u = new URL(raw);
    return u.host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function extractProductId(absUrl: string, supplierDomain: string): string | null {
  try {
    const u = new URL(absUrl);
    const path = u.pathname;
    if (supplierDomain.includes("target.com")) {
      const m = path.match(/\/-\/A-(\d+)\b/i);
      if (m) return `target:A-${m[1]}`;
    }
    if (supplierDomain.includes("walmart.com")) {
      const m = path.match(/\/ip\/[^/]+\/(\d{5,})\b/i);
      if (m) return `walmart:${m[1]}`;
    }
    if (supplierDomain.includes("bestbuy.com")) {
      const m = path.match(/\/(\d{5,})\.p\b/i);
      if (m) return `bestbuy:${m[1]}`;
    }
    if (supplierDomain.includes("homedepot.com")) {
      const m = path.match(/\/p\/[^/]+\/(\d{5,})\b/i);
      if (m) return `homedepot:${m[1]}`;
    }
    const generic = path.match(/(\d{6,})(?:\D*)$/);
    if (generic) return `${supplierDomain}:${generic[1]}`;
    return null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "missing_auth" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "unauthenticated" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Admin gate — only admins can seed (data is shared with regular users).
    const { data: roleRow } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) {
      return new Response(JSON.stringify({ error: "admin_only" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = (await req.json().catch(() => ({}))) as SeedRequest;
    const pdpUrl = (body.pdp_url ?? "").trim();
    if (!pdpUrl || !/^https?:\/\//i.test(pdpUrl)) {
      return new Response(JSON.stringify({ error: "valid_pdp_url_required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supplierDomain = normalizeDomain(pdpUrl);
    if (!supplierDomain) {
      return new Response(JSON.stringify({ error: "invalid_url" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve category — prefer explicit override.
    let categoryId: string | null = body.category_id ?? null;
    let categoryUrls: string[] = [];

    if (categoryId) {
      const { data: cat } = await admin
        .from("scan_categories")
        .select("id, supplier_domain, urls")
        .eq("id", categoryId)
        .maybeSingle();
      if (!cat) {
        return new Response(JSON.stringify({ error: "category_not_found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!supplierDomain.includes((cat as any).supplier_domain.toLowerCase())) {
        return new Response(
          JSON.stringify({
            error: "domain_mismatch",
            detail: `PDP domain ${supplierDomain} does not match category ${(cat as any).supplier_domain}`,
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      categoryUrls = ((cat as any).urls ?? []) as string[];
    } else {
      // Auto-pick a category for this supplier (first active one)
      const { data: cats } = await admin
        .from("scan_categories")
        .select("id, urls")
        .eq("supplier_domain", supplierDomain)
        .eq("is_active", true)
        .order("name", { ascending: true })
        .limit(1);
      if (!cats || cats.length === 0) {
        return new Response(
          JSON.stringify({ error: "no_category_for_supplier", supplier_domain: supplierDomain }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      categoryId = (cats[0] as any).id;
      categoryUrls = ((cats[0] as any).urls ?? []) as string[];
    }

    const urlKey = normalizeUrlKey(pdpUrl);
    const productId = extractProductId(pdpUrl, supplierDomain);

    // Find-or-create the long-lived seed run for this admin+category.
    const SEED_SCOPE_URL = `seed://${categoryId}`;
    let { data: seedRun } = await admin
      .from("store_scan_runs")
      .select("id, status")
      .eq("user_id", user.id)
      .eq("category_id", categoryId)
      .eq("scope_type", "manual_seed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!seedRun) {
      const { data: createdRun, error: createErr } = await admin
        .from("store_scan_runs")
        .insert({
          user_id: user.id,
          supplier_domain: supplierDomain,
          scope_type: "manual_seed",
          scope_urls: [SEED_SCOPE_URL],
          category_id: categoryId,
          status: "running",
          started_at: new Date().toISOString(),
          max_products_cap: 10000,
        })
        .select("id, status")
        .single();
      if (createErr) throw createErr;
      seedRun = createdRun as any;
    } else {
      // Reactivate the run so the chunk loop will pick up the new pending row.
      await admin
        .from("store_scan_runs")
        .update({ status: "running", chunk_lease_until: null })
        .eq("id", (seedRun as any).id);
    }

    const runId = (seedRun as any).id as string;

    // Skip if this exact PDP is already seeded in this run with a matched ASIN.
    const { data: existing } = await admin
      .from("store_scan_items")
      .select("id, status, matched_asin")
      .eq("run_id", runId)
      .eq("user_id", user.id)
      .or(`url_key.eq.${urlKey}${productId ? `,product_id.eq.${productId}` : ""}`)
      .maybeSingle();

    if (existing && (existing as any).matched_asin) {
      return new Response(
        JSON.stringify({
          ok: true,
          status: "already_seeded",
          item_id: (existing as any).id,
          run_id: runId,
          matched_asin: (existing as any).matched_asin,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let itemId: string;
    if (existing) {
      // Reset to pending so the matcher reprocesses it.
      const { data: updated, error: upErr } = await admin
        .from("store_scan_items")
        .update({ status: "pending", error: null })
        .eq("id", (existing as any).id)
        .select("id")
        .single();
      if (upErr) throw upErr;
      itemId = (updated as any).id;
    } else {
      const { data: inserted, error: insErr } = await admin
        .from("store_scan_items")
        .insert({
          run_id: runId,
          user_id: user.id,
          source_url: pdpUrl,
          url_key: urlKey,
          product_id: productId,
          status: "pending",
          is_new: true,
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      itemId = (inserted as any).id;
    }

    // Trigger the matcher chunk loop. process_chunk needs the internal secret.
    let triggered = false;
    let triggerError: string | null = null;
    if (INTERNAL_SYNC_SECRET) {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/store-scan-run`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SERVICE_KEY}`,
            "x-internal-secret": INTERNAL_SYNC_SECRET,
          },
          body: JSON.stringify({ mode: "process_chunk", run_id: runId }),
        });
        triggered = res.ok;
        if (!res.ok) triggerError = `chunk_trigger_${res.status}`;
      } catch (e: any) {
        triggerError = `chunk_trigger_exception: ${e?.message ?? e}`;
      }
    } else {
      triggerError = "no_internal_secret_configured";
    }

    return new Response(
      JSON.stringify({
        ok: true,
        status: "seeded",
        run_id: runId,
        item_id: itemId,
        category_id: categoryId,
        supplier_domain: supplierDomain,
        url_key: urlKey,
        product_id: productId,
        chunk_triggered: triggered,
        trigger_error: triggerError,
        category_scope_urls: categoryUrls,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("[store-scan-seed-pdp] error:", err?.message ?? err);
    return new Response(
      JSON.stringify({ error: err?.message ?? "unknown" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
