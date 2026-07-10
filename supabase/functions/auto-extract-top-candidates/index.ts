import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkModuleAccess } from "../_shared/module-access-guard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface ExtractorResult {
  url?: string;
  domain?: string | null;
  title?: string | null;
  price_current?: number | null;
  price_original?: number | null;
  currency?: string | null;
  availability?: string | null;
  image_url?: string | null;
  extraction_method?: string;
  confidence_score?: number;
  needs_review?: boolean;
  review_reasons?: string[];
  phase1_status?: string;
  phase2_status?: string;
  block_provider?: string | null;
  final_resolution?: string;
  error?: string | null;
}

function classifyResolution(r: ExtractorResult): "extracted" | "blocked" | "unresolved" | "invalid" {
  const fr = r.final_resolution || "";
  if (fr === "price_extracted") return "extracted";
  if (fr.startsWith("blocked_") || fr === "phase2_timeout" || fr === "phase2_render_failed") return "blocked";
  if (fr === "non_product_page") return "invalid";
  return "unresolved";
}

// Mirror the client-side computeQualityBadge logic so list views can rely on it.
function computeQualityBadge(
  total: number,
  extracted: number,
  blocked: number,
  needsReview: number,
  avgConfidence: number | null,
): "strong" | "mixed" | "review_needed" | "empty" {
  if (total === 0) return "empty";
  const blockedRate = total > 0 ? blocked / total : 0;
  const extractedRate = total > 0 ? extracted / total : 0;
  const reviewRate = extracted > 0 ? needsReview / extracted : 0;

  if (
    extracted >= 2 &&
    extractedRate >= 0.2 &&
    blockedRate < 0.6 &&
    (avgConfidence == null || avgConfidence >= 0.6) &&
    reviewRate < 0.5
  ) return "strong";
  if (extracted === 0 || (blockedRate >= 0.7 && extracted < 2)) return "review_needed";
  if (needsReview > 0 || (avgConfidence != null && avgConfidence < 0.5) || extractedRate < 0.1) return "review_needed";
  return "mixed";
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

    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json();
    const runId: string = body.run_id;
    const limit: number = Math.min(Math.max(body.limit || 10, 1), 20);
    // Cost-saving controls: early-stop once we find candidates that meet desired ROI
    const minRoiPct: number | null =
      typeof body.min_roi_pct === "number" && body.min_roi_pct > 0 ? body.min_roi_pct : null;
    let amazonPrice: number | null =
      typeof body.amazon_price === "number" && body.amazon_price > 0 ? body.amazon_price : null;

    if (!runId) {
      return new Response(JSON.stringify({ error: "Missing run_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load run + top candidates
    const { data: run, error: runErr } = await supabase
      .from("source_discovery_runs")
      .select("*")
      .eq("id", runId)
      .single();
    if (runErr || !run) {
      return new Response(JSON.stringify({ error: "Run not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // MODULE ACCESS GUARD: supplier_discovery:run required (admin bypasses).
    // Enforced against the run owner since extraction cost is billed to them.
    const access = await checkModuleAccess(supabase, run.user_id, "supplier_discovery", "run");
    if (!access.allowed) {
      console.warn(`[auto-extract-top-candidates] BLOCKED run=${runId} owner=${run.user_id} reason=${access.reason}`);
      return new Response(JSON.stringify({ error: access.reason || "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // If client didn't pass an Amazon price hint, try inventory then keepa.
    // Used purely to enable ROI-aware early-stop; never blocks extraction.
    if (minRoiPct != null && amazonPrice == null && run.asin) {
      const { data: inv } = await supabase
        .from("inventory")
        .select("amazon_price, price")
        .eq("user_id", run.user_id)
        .eq("asin", run.asin)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (inv?.amazon_price && Number(inv.amazon_price) > 0) amazonPrice = Number(inv.amazon_price);
      else if (inv?.price && Number(inv.price) > 0) amazonPrice = Number(inv.price);
      if (amazonPrice == null) {
        const { data: keepa } = await supabase
          .from("keepa_products")
          .select("buy_box_price, amazon_price")
          .eq("asin", run.asin)
          .maybeSingle();
        if (keepa?.buy_box_price && Number(keepa.buy_box_price) > 0) amazonPrice = Number(keepa.buy_box_price);
        else if (keepa?.amazon_price && Number(keepa.amazon_price) > 0) amazonPrice = Number(keepa.amazon_price);
      }
    }

    const { data: candidates } = await supabase
      .from("source_candidates")
      .select("id, source_url")
      .eq("run_id", runId)
      .is("extracted_at", null)
      .order("match_score", { ascending: false })
      .limit(limit);

    const list = candidates || [];
    const roiActive = minRoiPct != null && amazonPrice != null;
    console.log(
      `[auto-extract] run=${runId} candidates=${list.length} minRoi=${minRoiPct ?? "off"} amzPrice=${amazonPrice ?? "n/a"} roiActive=${roiActive}`,
    );

    let earlyStopped = 0;
    let passedRoi = 0;
    // After we find at least 1 candidate that passes the desired ROI, allow up to
    // EARLY_STOP_BUFFER more extractions before stopping (saves ScrapingBee + AI cost).
    const EARLY_STOP_BUFFER = 2;
    let processedAfterFirstPass = 0;

    const extractorUrl = `${supabaseUrl}/functions/v1/extract-product-price`;

    let extracted = 0, blocked = 0, unresolved = 0, invalid = 0, needsReview = 0;

    for (const c of list) {
      try {
        const r = await fetch(extractorUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token || anonKey}`,
            apikey: anonKey,
          },
          body: JSON.stringify({ url: c.source_url }),
        });

        if (!r.ok) {
          console.warn(`[auto-extract] extractor non-OK ${r.status} for ${c.source_url}`);
          await supabase
            .from("source_candidates")
            .update({
              final_resolution: "fetch_error",
              extracted_at: new Date().toISOString(),
              last_checked_at: new Date().toISOString(),
            })
            .eq("id", c.id);
          unresolved++;
          continue;
        }

        const result: ExtractorResult = await r.json();

        const cls = classifyResolution(result);
        if (cls === "extracted") extracted++;
        else if (cls === "blocked") blocked++;
        else if (cls === "invalid") invalid++;
        else unresolved++;
        if (result.needs_review) needsReview++;

        await supabase
          .from("source_candidates")
          .update({
            phase1_status: result.phase1_status ?? null,
            phase2_status: result.phase2_status ?? null,
            block_provider: result.block_provider ?? null,
            final_resolution: result.final_resolution ?? null,
            extraction_method: result.extraction_method ?? null,
            current_price: result.price_current ?? null,
            original_price: result.price_original ?? null,
            currency: result.currency ?? null,
            availability: result.availability ?? null,
            confidence_score: result.confidence_score ?? null,
            needs_review: result.needs_review ?? null,
            review_reasons: result.review_reasons ?? null,
            image_url: result.image_url ?? null,
            extracted_at: new Date().toISOString(),
            last_checked_at: new Date().toISOString(),
          })
          .eq("id", c.id);

        // ROI-aware early stop (cost saver): once we have a candidate that beats the
        // user's desired REAL ROI (after estimated Amazon fees), only run a small
        // buffer of additional extractions. Matches client-side computeRoiPct().
        if (roiActive && cls === "extracted" && result.price_current && result.price_current > 0) {
          const estFees = amazonPrice! * 0.15 + 3.5; // 15% referral + ~$3.50 FBA
          const profit = amazonPrice! - estFees - result.price_current;
          const roi = (profit / result.price_current) * 100;
          if (roi >= (minRoiPct as number)) passedRoi++;
        }
      } catch (e) {
        console.warn(`[auto-extract] error for ${c.source_url}:`, e instanceof Error ? (e as Error).message : e);
        await supabase
          .from("source_candidates")
          .update({
            final_resolution: "fetch_error",
            extracted_at: new Date().toISOString(),
            last_checked_at: new Date().toISOString(),
          })
          .eq("id", c.id);
        unresolved++;
      }

      if (roiActive && passedRoi > 0) {
        processedAfterFirstPass++;
        if (processedAfterFirstPass >= EARLY_STOP_BUFFER) {
          earlyStopped = list.length - (extracted + blocked + unresolved + invalid);
          console.log(`[auto-extract] early-stop: passedRoi=${passedRoi} buffer=${EARLY_STOP_BUFFER} skipped=${earlyStopped}`);
          break;
        }
      }
    }

    // Compute top valid price across all candidates of this run
    const { data: topRow } = await supabase
      .from("source_candidates")
      .select("current_price, source_url, domain")
      .eq("run_id", runId)
      .eq("final_resolution", "price_extracted")
      .gt("current_price", 0)
      .order("current_price", { ascending: true })
      .limit(1)
      .maybeSingle();

    // Compute persisted summary fields (quality_badge + avg confidence)
    const totalsExtracted = (run.extracted_count || 0) + extracted;
    const totalsBlocked = (run.blocked_count || 0) + blocked;
    const totalsUnresolved = (run.unresolved_count || 0) + unresolved;
    const totalsInvalid = (run.invalid_count || 0) + invalid;
    const totalsNeedsReview = (run.needs_review_count || 0) + needsReview;
    const totalCandidates = run.total_candidates || 0;

    const { data: confRows } = await supabase
      .from("source_candidates")
      .select("confidence_score")
      .eq("run_id", runId)
      .eq("final_resolution", "price_extracted")
      .gt("current_price", 0);

    let avgConf: number | null = null;
    if (confRows && confRows.length > 0) {
      const arr = confRows
        .map((r) => (typeof r.confidence_score === "number" ? r.confidence_score : 0))
        .filter((n) => n > 0);
      if (arr.length > 0) avgConf = arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    const qualityBadge = computeQualityBadge(
      totalCandidates,
      totalsExtracted,
      totalsBlocked,
      totalsNeedsReview,
      avgConf,
    );

    // Update run summary (persist quality + top domain so list views don't recompute)
    await supabase
      .from("source_discovery_runs")
      .update({
        extracted_count: totalsExtracted,
        blocked_count: totalsBlocked,
        unresolved_count: totalsUnresolved,
        invalid_count: totalsInvalid,
        needs_review_count: totalsNeedsReview,
        top_valid_price: topRow?.current_price ?? null,
        top_valid_url: topRow?.source_url ?? null,
        top_valid_domain: topRow?.domain ?? null,
        quality_badge: qualityBadge,
        status: "completed",
      })
      .eq("id", runId);

    return new Response(
      JSON.stringify({
        run_id: runId,
        processed: list.length - earlyStopped,
        extracted,
        blocked,
        unresolved,
        invalid,
        needs_review: needsReview,
        quality_badge: qualityBadge,
        top_valid_domain: topRow?.domain ?? null,
        roi_active: roiActive,
        roi_passed: passedRoi,
        early_stopped: earlyStopped,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? (e as Error).message : String(e);
    console.error("auto-extract-top-candidates error:", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
