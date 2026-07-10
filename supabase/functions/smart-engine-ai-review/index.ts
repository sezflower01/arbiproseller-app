import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { routeBatch, type RouterCase, type RoutingDecision } from "../_shared/caseRouter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Phase 2: Flash/Pro routing.
//   FLASH_MODEL: cheap bulk path
//   PRO_MODEL  : deep review for escalated cases
const FLASH_MODEL = "google/gemini-2.5-flash";
const PRO_MODEL   = "google/gemini-2.5-pro";
const PROMPT_VERSION = "v2.0-routed";

const SYSTEM_PROMPT = `You are an expert Amazon repricing analyst. You analyze repricer decisions and provide judgment on whether the pricing engine made the right call.

For each ASIN case, provide:
1. judgment: "optimal", "contextual_correct", or "needs_review"
2. reasoning: A 1-2 sentence explanation of why this decision was correct or needs attention
3. suggestion: If needs_review, suggest what parameter or behavior should be adjusted. If optimal, say "No change needed."
4. confidence: "high", "medium", or "low"

Rules:
- Holding when you're already the lowest FBA seller is ALWAYS correct (self-undercut prevention)
- Holding when BB winner is FBM/filtered is correct
- Raising price near the next competitor ceiling is optimal
- Not chasing a BB price that's below your profit floor is correct
- Having no competitor data means monitoring-only hold is correct
- Price oscillation guards are protective and correct

Respond with a JSON array of objects with keys: asin, judgment, reasoning, suggestion, confidence.`;

const TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "analyze_cases",
    description: "Return analysis for each ASIN case",
    parameters: {
      type: "object",
      properties: {
        analyses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              asin: { type: "string" },
              judgment: { type: "string", enum: ["optimal", "contextual_correct", "needs_review"] },
              reasoning: { type: "string" },
              suggestion: { type: "string" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["asin", "judgment", "reasoning", "suggestion", "confidence"],
            additionalProperties: false,
          },
        },
      },
      required: ["analyses"],
      additionalProperties: false,
    },
  },
};

function buildCaseSummaries(cases: any[]): string {
  return cases.map((c: any, i: number) =>
    `Case ${i + 1}: ASIN ${c.asin} (${c.marketplace})
- Event: ${c.event_type} | Decision: ${c.decision_label}
- My Price: $${c.current_price?.toFixed(2) ?? "?"} | BB: $${c.buy_box_price?.toFixed(2) ?? "?"} | Lowest FBA: $${c.lowest_fba_price?.toFixed(2) ?? "?"}
- Next Competitor: $${c.next_competitor_price?.toFixed(2) ?? "?"} | Min: $${c.min_price?.toFixed(2) ?? "?"} | Max: $${c.max_price?.toFixed(2) ?? "?"}
- Floor: $${c.profit_floor?.toFixed(2) ?? "?"} | BB Owner: ${c.was_bb_owner ? "Yes" : "No"}
- Engine Mode: ${c.engine_mode ?? "?"} | Price Changed: ${c.was_price_changed ? "Yes" : "No"}
- Constraints: ${JSON.stringify(c.constraints_json ?? [])}
- Signal: ${c.tuning_signal ?? "none"}`,
  ).join("\n\n");
}

async function callTier(
  model: string,
  cases: any[],
  apiKey: string,
): Promise<{ analyses: any[]; error?: string }> {
  if (cases.length === 0) return { analyses: [] };
  const summaries = buildCaseSummaries(cases);
  const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Analyze these ${cases.length} repricer decisions:\n\n${summaries}\n\nRespond with a JSON array only.` },
      ],
      tools: [TOOL_SCHEMA],
      tool_choice: { type: "function", function: { name: "analyze_cases" } },
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`AI error tier=${model} status=${resp.status}:`, errText);
    return { analyses: [], error: `${resp.status}: ${errText.slice(0, 200)}` };
  }
  const data = await resp.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (toolCall?.function?.arguments) {
    try {
      const parsed = JSON.parse(toolCall.function.arguments);
      return { analyses: parsed.analyses || [] };
    } catch {
      return { analyses: [], error: "tool_call_parse_failed" };
    }
  }
  return { analyses: [] };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing auth");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!lovableApiKey) throw new Error("LOVABLE_API_KEY not configured");

    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) throw new Error("Unauthorized");

    const adminClient = createClient(supabaseUrl, supabaseKey);

    // MODULE ACCESS GUARD
    const { checkModuleAccess } = await import("../_shared/module-access-guard.ts");
    const access = await checkModuleAccess(adminClient, user.id, "repricer", "admin");
    if (!access.allowed) {
      console.warn(`[smart-engine-ai-review] MODULE BLOCKED user=${user.id} reason=${access.reason}`);
      return new Response(JSON.stringify({ error: access.reason }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { cases } = body;
    if (!cases || !Array.isArray(cases) || cases.length === 0) {
      throw new Error("No cases provided");
    }

    // ---- PHASE 2: route each case to flash / pro / skip ----
    const routerCases: RouterCase[] = cases.map((c: any) => ({
      asin: c.asin,
      marketplace: c.marketplace,
      current_price: c.current_price,
      profit_floor: c.profit_floor,
      was_bb_owner: c.was_bb_owner,
      was_price_changed: c.was_price_changed,
      decision_label: c.decision_label,
      tuning_signal: c.tuning_signal,
      unnecessary_undercut_reasons: c.unnecessary_undercut_reasons,
    }));

    const { decisions, summary: routeSummary } = await routeBatch(adminClient, user.id, routerCases);
    const decisionByAsin = new Map<string, RoutingDecision>(decisions.map((d) => [d.asin, d]));

    const proCases   = cases.filter((c: any) => decisionByAsin.get(c.asin)?.tier === "pro");
    const flashCases = cases.filter((c: any) => decisionByAsin.get(c.asin)?.tier === "flash");
    const skipCases  = cases.filter((c: any) => decisionByAsin.get(c.asin)?.tier === "skip");

    console.log(`[router] user=${user.id} pro=${proCases.length} flash=${flashCases.length} skip=${skipCases.length} cap_used=${routeSummary.cap_used}/${routeSummary.cap}`);

    // ---- Call both tiers in parallel ----
    const [proResult, flashResult] = await Promise.all([
      callTier(PRO_MODEL,   proCases,   lovableApiKey),
      callTier(FLASH_MODEL, flashCases, lovableApiKey),
    ]);

    // Bubble up hard failures (402/429 surface friendlier messages)
    for (const r of [proResult, flashResult]) {
      if (r.error?.startsWith("402")) {
        return new Response(JSON.stringify({ error: "AI credits exhausted — add funds in Settings > Workspace > Usage" }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (r.error?.startsWith("429")) {
        return new Response(JSON.stringify({ error: "Rate limited — try again in a moment" }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Merge analyses + add deterministic notes for skipped cases
    const analyses: any[] = [
      ...proResult.analyses.map((a) => ({ ...a, _tier: "pro" })),
      ...flashResult.analyses.map((a) => ({ ...a, _tier: "flash" })),
      ...skipCases.map((c: any) => ({
        asin: c.asin,
        judgment: "optimal",
        reasoning: "Confirmed-correct hold (BB owner, no price change, no new tuning signal). No LLM call required.",
        suggestion: "No change needed.",
        confidence: "high",
        _tier: "skip",
      })),
    ];

    // ---- Persist batch (with tier rollup) ----
    const { data: batchRow } = await adminClient
      .from("smart_engine_ai_review_batches")
      .insert({
        user_id: user.id,
        selected_case_count: cases.length,
        selection_strategy: "phase2_router",
        ai_model: `${PRO_MODEL}+${FLASH_MODEL}`,
        ai_summary: `${routeSummary.pro} pro · ${routeSummary.flash} flash · ${routeSummary.skip} skip — ${analyses.filter((a) => a.judgment === "needs_review").length} need review`,
        recommendation_count: analyses.filter((a) => a.judgment === "needs_review").length,
        prompt_version: PROMPT_VERSION,
        total_signals_seen: cases.length,
        pro_count: routeSummary.pro,
        flash_count: routeSummary.flash,
        skip_count: routeSummary.skip,
      })
      .select("id")
      .single();

    // ---- Persist individual reviews with tier + escalation reasons ----
    if (batchRow?.id) {
      const reviewRows = cases.map((c: any) => {
        const analysis = analyses.find((a: any) => a.asin === c.asin) || {};
        const dec = decisionByAsin.get(c.asin);
        const modelUsed =
          dec?.tier === "pro"   ? PRO_MODEL
          : dec?.tier === "flash" ? FLASH_MODEL
          : "rule_based_skip";
        return {
          batch_id: batchRow.id,
          user_id: user.id,
          asin: c.asin,
          sku: c.sku,
          marketplace: c.marketplace,
          event_type: c.event_type,
          decision_label: c.decision_label,
          pricing_context: {
            current_price: c.current_price,
            buy_box_price: c.buy_box_price,
            lowest_fba_price: c.lowest_fba_price,
            next_competitor_price: c.next_competitor_price,
            min_price: c.min_price,
            max_price: c.max_price,
            profit_floor: c.profit_floor,
            engine_mode: c.engine_mode,
            was_price_changed: c.was_price_changed,
            was_bb_owner: c.was_bb_owner,
            source_action_type: c.action_type,
            source_tuning_signal: c.tuning_signal,
          },
          constraints_json: c.constraints_json,
          ai_judgment: analysis.judgment || null,
          ai_reasoning_summary: analysis.reasoning || null,
          ai_tuning_suggestion: analysis.suggestion || null,
          ai_confidence: analysis.confidence || "medium",
          accepted_status: "pending",
          prompt_version: PROMPT_VERSION,
          model_used: modelUsed,
          model_tier: dec?.tier ?? "flash",
          escalation_reasons: dec?.reasons ?? [],
          selection_reason: dec?.cap_exhausted
            ? "downgraded_pro_to_flash_cap_exhausted"
            : (dec?.reasons?.[0] ?? null),
        };
      });
      await adminClient.from("smart_engine_ai_reviews").insert(reviewRows);
    }

    return new Response(JSON.stringify({
      batch_id: batchRow?.id,
      analyses,
      case_count: cases.length,
      routing: routeSummary,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("smart-engine-ai-review error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? (e as Error).message : "Unknown error" }), {
      status: e instanceof Error && (e as Error).message === "Unauthorized" ? 401 : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
