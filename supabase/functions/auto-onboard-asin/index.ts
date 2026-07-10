import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing auth" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { asin, sku, marketplace = "US" } = await req.json();
    if (!asin || !sku) {
      return new Response(JSON.stringify({ error: "asin and sku required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = user.id;

    // Check if assignment already exists with a rule
    const { data: existing } = await supabase
      .from("repricer_assignments")
      .select("id, rule_id, min_price_override, max_price_override")
      .eq("user_id", userId)
      .eq("asin", asin)
      .eq("marketplace", marketplace)
      .maybeSingle();

    // If already has a rule assigned, just recalculate min/max if missing
    const alreadyAssigned = existing?.rule_id;

    // Fetch user auto-onboarding settings (non-rule-id parts only — rule comes from repricer_rules.is_default)
    let { data: settings } = await supabase
      .from("user_settings")
      .select(
        "auto_assign_enabled, auto_assign_rule_id, auto_minmax_enabled, auto_min_strategy, auto_max_strategy, auto_min_buffer_pct, auto_max_buffer_pct, auto_require_cost, auto_skip_manual_minmax"
      )
      .eq("user_id", userId)
      .maybeSingle();

    // Resolve the default rule:
    // 1) repricer_rules.is_default = true  (UNIFIED source of truth — set from Rules tab)
    // 2) legacy user_settings.auto_assign_rule_id (back-compat)
    // 3) safe fallback: Momentum Builder → Balanced Pro → any non-aggressive rule
    let resolvedRuleId: string | null = null;

    const { data: flaggedDefault } = await supabase
      .from("repricer_rules")
      .select("id")
      .eq("user_id", userId)
      .eq("is_default", true)
      .maybeSingle();

    if (flaggedDefault?.id) {
      resolvedRuleId = flaggedDefault.id;
    } else if (settings?.auto_assign_rule_id) {
      resolvedRuleId = settings.auto_assign_rule_id;
    } else {
      const { data: userRules } = await supabase
        .from("repricer_rules")
        .select("id, smart_profile, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });

      const preferred =
        userRules?.find((r: any) => r.smart_profile === "MOMENTUM_BUILDER") ||
        userRules?.find((r: any) => r.smart_profile === "BALANCED_PRO") ||
        userRules?.find((r: any) => r.smart_profile !== "VELOCITY_DOMINATOR" && r.smart_profile !== "LIQUIDATION") ||
        null;

      if (!preferred) {
        console.log(`[auto-onboard-asin] No safe default rule for user ${userId} — refusing to auto-pick aggressive preset`);
        return new Response(
          JSON.stringify({
            skipped: true,
            reason: "no_safe_default_rule",
            hint: "Mark a rule as Default in the Repricer → Rules tab (Momentum Builder recommended).",
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      resolvedRuleId = preferred.id;
    }

    if (!settings) {
      settings = {
        auto_assign_enabled: true,
        auto_assign_rule_id: resolvedRuleId,
        auto_minmax_enabled: true,
        auto_min_strategy: "price_buffer",
        auto_max_strategy: "price_buffer",
        auto_min_buffer_pct: 15,
        auto_max_buffer_pct: 30,
        auto_require_cost: true,
        auto_skip_manual_minmax: true,
      } as any;
    } else {
      settings.auto_assign_rule_id = resolvedRuleId;
    }


    if (!settings!.auto_assign_enabled) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "auto_assign_disabled" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Skip if already assigned and skip_existing
    if (alreadyAssigned && settings!.auto_skip_manual_minmax) {
      // Still recalculate min/max if they're missing
      if (existing.min_price_override && existing.max_price_override) {
        return new Response(
          JSON.stringify({ skipped: true, reason: "already_assigned_with_bounds" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Fetch unit cost — Contract A via shared helpers
    // created_listings: amount=UNIT, cost=TOTAL, units=purchase qty.
    // inventory:       cost=UNIT, amount=TOTAL value, units=stock qty.
    const { getListingUnitCost, getInventoryUnitCost } = await import(
      "../_shared/cost-contract.ts"
    );

    const { data: costData } = await supabase
      .from("created_listings")
      .select("cost, units, amount")
      .eq("user_id", userId)
      .eq("asin", asin)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let unitCost = getListingUnitCost(costData ?? {}) ?? 0;

    // Fallback: inventory unit cost (Contract A: inventory.cost is already UNIT)
    if (unitCost <= 0) {
      const { data: invData } = await supabase
        .from("inventory")
        .select("cost, amount, units")
        .eq("user_id", userId)
        .eq("asin", asin)
        .maybeSingle();
      const invUnit = getInventoryUnitCost(invData ?? {}) ?? 0;
      if (invUnit > 0) unitCost = invUnit;
    }

    if (settings!.auto_require_cost && unitCost <= 0) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "no_cost" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // === HOME-CURRENCY-AWARE FX CONVERSION ===
    // Set up FX *before* price resolution so we can convert home-currency
    // fallbacks (inventory.my_price, etc.) into the marketplace's local currency.
    const { convertCurrency, getSellerHomeCurrency } = await import('../_shared/fx-utils.ts');
    const homeCurrency = await getSellerHomeCurrency(supabase, userId);
    const currencyForMkt: Record<string, string> = { US: 'USD', CA: 'CAD', MX: 'MXN', BR: 'BRL' };
    const targetCurrency = currencyForMkt[marketplace] || 'USD';
    let fxRate = 1;
    let unitCostLocal = unitCost;
    if (unitCost > 0 && homeCurrency !== targetCurrency) {
      const fxResult = await convertCurrency(unitCost, homeCurrency, targetCurrency, supabase);
      fxRate = fxResult.fxRate;
      unitCostLocal = fxResult.converted;
    }
    // Also derive home→local FX even when cost is zero (used for inventory price fallbacks)
    let homeToLocalFx = fxRate;
    if (homeCurrency !== targetCurrency && fxRate === 1) {
      const probe = await convertCurrency(1, homeCurrency, targetCurrency, supabase);
      homeToLocalFx = probe.fxRate;
    }

    const marketplaceIdMap: Record<string, string> = {
      US: "ATVPDKIKX0DER",
      CA: "A2EUQ1WTGCTBG2",
      MX: "A1AM78C64UM0Y8",
      BR: "A2Q3Y263D00KWC",
    };
    const targetMarketplaceId = marketplaceIdMap[marketplace] || marketplaceIdMap.US;

    // Resolve current price IN MARKETPLACE LOCAL CURRENCY.
    // Track the source so we can FX-convert home-currency fallbacks safely.
    let currentPrice = 0;
    let currentPriceSource: 'mkt_cache' | 'mkt_snapshot' | 'mkt_bb_cache' | 'home_inventory' | 'home_listing' | 'none' = 'none';

    // Source 1: marketplace-specific my_price cache (already in local currency)
    {
      const { data: priceCache } = await supabase
        .from("asin_my_price_cache")
        .select("my_price, marketplace_id, currency")
        .eq("user_id", userId)
        .eq("asin", asin)
        .eq("seller_sku", sku)
        .eq("marketplace_id", targetMarketplaceId)
        .order("fetched_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (priceCache?.my_price && priceCache.my_price > 0) {
        currentPrice = priceCache.my_price;
        currentPriceSource = 'mkt_cache';
        console.log(
          `[auto-onboard-asin] Marketplace cache hit for ${asin}/${sku} in ${marketplace}: ${priceCache.currency ?? targetCurrency} ${priceCache.my_price}`
        );
      }
    }

    // Source 2: competitor snapshot buybox / lowest fba (already in local currency)
    if (currentPrice <= 0) {
      const { data: snapshot } = await supabase
        .from("repricer_competitor_snapshots")
        .select("buybox_price, lowest_fba_price")
        .eq("user_id", userId)
        .eq("asin", asin)
        .eq("marketplace", marketplace)
        .order("fetched_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (snapshot?.buybox_price && snapshot.buybox_price > 0) {
        currentPrice = snapshot.buybox_price;
        currentPriceSource = 'mkt_snapshot';
      } else if (snapshot?.lowest_fba_price && snapshot.lowest_fba_price > 0) {
        currentPrice = snapshot.lowest_fba_price;
        currentPriceSource = 'mkt_snapshot';
      }
    }

    // Source 3: buy_box_cache (assume marketplace-correct)
    if (currentPrice <= 0) {
      const { data: bbCache } = await supabase
        .from("buy_box_cache")
        .select("price")
        .eq("asin", asin)
        .order("fetched_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (bbCache?.price && bbCache.price > 0) {
        currentPrice = bbCache.price;
        currentPriceSource = 'mkt_bb_cache';
      }
    }

    // Source 4 (LAST RESORT, home-currency): inventory.my_price/price — must FX-convert
    if (currentPrice <= 0) {
      const { data: invPrice } = await supabase
        .from("inventory")
        .select("my_price, price, amazon_price")
        .eq("user_id", userId)
        .eq("asin", asin)
        .maybeSingle();
      const homePrice = invPrice?.my_price || invPrice?.price || invPrice?.amazon_price || 0;
      if (homePrice > 0) {
        currentPrice = marketplace === 'US' ? homePrice : homePrice * homeToLocalFx;
        currentPriceSource = 'home_inventory';
        console.log(`[auto-onboard-asin] Home inventory price ${homeCurrency} ${homePrice} → ${targetCurrency} ${currentPrice.toFixed(2)} (fx=${homeToLocalFx.toFixed(4)})`);
      }
    }

    // Source 5 (LAST RESORT, home-currency): created_listings.price — FX-convert
    if (currentPrice <= 0) {
      const { data: listing } = await supabase
        .from("created_listings")
        .select("price")
        .eq("user_id", userId)
        .eq("asin", asin)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (listing?.price && listing.price > 0) {
        currentPrice = marketplace === 'US' ? listing.price : listing.price * homeToLocalFx;
        currentPriceSource = 'home_listing';
      }
    }

    console.log(`[auto-onboard-asin] Price resolution for ${asin} (${marketplace}): localPrice=${currentPrice.toFixed(2)} ${targetCurrency} (source=${currentPriceSource}, costLocal=${unitCostLocal.toFixed(2)} ${targetCurrency}, fx=${fxRate.toFixed(4)})`);

    // Calculate min/max (all in local currency)
    let minPrice: number | null = null;
    let maxPrice: number | null = null;

    if (settings!.auto_minmax_enabled) {
      if (settings!.auto_min_strategy === "cost_buffer" && unitCostLocal > 0) {
        minPrice = Math.round(unitCostLocal * (1 + settings!.auto_min_buffer_pct / 100) * 100) / 100;
      } else if (settings!.auto_min_strategy === "price_buffer" && currentPrice > 0) {
        minPrice = Math.round(currentPrice * (1 - settings!.auto_min_buffer_pct / 100) * 100) / 100;
      }

      // Fallback: if cost_buffer strategy couldn't set min (no cost), derive from currentPrice
      if (minPrice === null && currentPrice > 0) {
        minPrice = Math.round(currentPrice * (1 - (settings!.auto_min_buffer_pct || 15) / 100) * 100) / 100;
        console.log(`[auto-onboard-asin] Min fallback from price: ${minPrice} (cost missing)`);
      }

      if (settings!.auto_max_strategy === "price_buffer" && currentPrice > 0) {
        maxPrice = Math.round(currentPrice * (1 + settings!.auto_max_buffer_pct / 100) * 100) / 100;
      } else if (settings!.auto_max_strategy === "buybox_buffer" && currentPrice > 0) {
        maxPrice = Math.round(currentPrice * (1 + settings!.auto_max_buffer_pct / 100) * 100) / 100;
      }
    }

    // === CURRENCY-SANITY GUARD ===
    // For non-US marketplaces, fetch the live marketplace BB. If the computed max
    // is wildly below it (< 30%), the price source was almost certainly USD-mislabeled.
    // Refuse to write bad bounds — the next sync cycle with marketplace data will fix it.
    if (marketplace !== 'US' && (minPrice !== null || maxPrice !== null)) {
      const { data: bbCheck } = await supabase
        .from('repricer_competitor_snapshots')
        .select('buybox_price, lowest_fba_price')
        .eq('user_id', userId)
        .eq('asin', asin)
        .eq('marketplace', marketplace)
        .order('fetched_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const mktBB = bbCheck?.buybox_price || bbCheck?.lowest_fba_price || 0;
      if (mktBB > 0 && maxPrice !== null && maxPrice < mktBB * 0.3) {
        console.warn(
          `[auto-onboard-asin] 🚨 CURRENCY GUARD: ${asin}/${marketplace} computed max=${maxPrice} ${targetCurrency} is < 30% of marketplace BB=${mktBB} ${targetCurrency} (priceSource=${currentPriceSource}). Refusing to write USD-style bounds.`
        );
        minPrice = null;
        maxPrice = null;
      }
    }

    // PLAN LIMIT ENFORCEMENT: Count only legitimately sellable assignments
    // Exclude intl assignments with bad eligibility status (they don't consume real capacity)
    const BAD_INTL_STATUSES = ['UNKNOWN', 'NOT_FOUND', 'INACTIVE', '[]', ''];
    
    // Count US enabled assignments (all count)
    const { count: usActiveCount } = await supabase
      .from("repricer_assignments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("is_enabled", true)
      .eq("marketplace", "US");

    // Count intl enabled assignments, excluding ineligible ones
    const { count: intlActiveCount } = await supabase
      .from("repricer_assignments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("is_enabled", true)
      .neq("marketplace", "US")
      .not("intl_listing_status", "in", `(${BAD_INTL_STATUSES.join(",")})`);

    const currentActiveCount = (usActiveCount ?? 0) + (intlActiveCount ?? 0);

    // Get user's plan limit
    const { data: subData } = await supabase
      .from("user_subscriptions")
      .select("plan_id")
      .eq("user_id", userId)
      .maybeSingle();

    const { data: overrideData } = await supabase
      .from("admin_subscription_override")
      .select("override_enabled, override_plan_id")
      .eq("user_id", userId)
      .maybeSingle();

    const effectivePlanId = (overrideData?.override_enabled && overrideData?.override_plan_id)
      ? overrideData.override_plan_id
      : (subData?.plan_id ?? "tier_100");

    const { data: planData } = await supabase
      .from("subscription_plans")
      .select("listing_limit")
      .eq("id", effectivePlanId)
      .single();

    const planLimit = planData?.listing_limit ?? 100;

    // If already at or over limit and this is a NEW assignment, skip
    if (!existing && (currentActiveCount ?? 0) >= planLimit) {
      console.log(`[auto-onboard-asin] ⚠️ Plan limit reached (${currentActiveCount}/${planLimit}), skipping ${asin}`);
      return new Response(
        JSON.stringify({ skipped: true, reason: "plan_limit_reached", current: currentActiveCount, limit: planLimit }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build assignment
    const isNewAssignment = !existing;
    const assignment: any = {
      user_id: userId,
      asin,
      sku,
      marketplace,
      rule_id: alreadyAssigned || settings!.auto_assign_rule_id,
      is_enabled: true,
    };
    if (minPrice !== null) assignment.min_price_override = minPrice;
    if (maxPrice !== null) assignment.max_price_override = maxPrice;
    // Force immediate HOT lane pickup for new assignments so market data is fetched within minutes
    if (isNewAssignment) {
      assignment.last_price_change_at = new Date().toISOString();
    }

    // Skip overwriting manual min/max if configured
    if (settings!.auto_skip_manual_minmax && existing?.min_price_override) {
      delete assignment.min_price_override;
    }
    if (settings!.auto_skip_manual_minmax && existing?.max_price_override) {
      delete assignment.max_price_override;
    }

    const { error: upsertErr } = await supabase
      .from("repricer_assignments")
      .upsert(assignment, { onConflict: "user_id,sku,marketplace", ignoreDuplicates: false });

    if (upsertErr) {
      console.error("Upsert error:", upsertErr);
      return new Response(
        JSON.stringify({ error: upsertErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const effectiveMin = assignment.min_price_override ?? existing?.min_price_override;
    const effectiveMax = assignment.max_price_override ?? existing?.max_price_override;

    console.log(
      `[auto-onboard-asin] ✅ ${asin} (${marketplace}): rule=${assignment.rule_id} min=${effectiveMin || "kept"} max=${effectiveMax || "kept"}`
    );

    // Push min/max bounds to Amazon immediately (fire-and-forget)
    if (effectiveMin && effectiveMax) {
      try {
        const pushResp = await fetch(`${supabaseUrl}/functions/v1/update-amazon-price`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({
            user_id: userId,
            asin,
            sku,
            marketplace,
            newMinPrice: effectiveMin,
            newMaxPrice: effectiveMax,
            updateMinMaxOnly: true,
            internal: true,
          }),
        });
        const pushResult = await pushResp.json().catch(() => null);
        if (pushResp.ok && pushResult?.success) {
          console.log(`[auto-onboard-asin] ✅ Bounds pushed to Amazon for ${asin}/${marketplace}: min=${effectiveMin} max=${effectiveMax}`);
          await supabase.from('repricer_assignments').update({ bounds_synced_at: new Date().toISOString() })
            .eq('user_id', userId).eq('asin', asin).eq('marketplace', marketplace);
        } else {
          console.warn(`[auto-onboard-asin] ⚠️ Bounds push failed for ${asin}: ${pushResult?.error || pushResp.status}`);
        }
      } catch (pushErr: any) {
        console.warn(`[auto-onboard-asin] ⚠️ Bounds push error for ${asin}: ${pushErr.message}`);
      }
    }

    return new Response(
      JSON.stringify({
        onboarded: true,
        asin,
        marketplace,
        rule_id: assignment.rule_id,
        min_price: assignment.min_price_override || existing?.min_price_override,
        max_price: assignment.max_price_override || existing?.max_price_override,
        unit_cost: unitCost,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("auto-onboard-asin error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
