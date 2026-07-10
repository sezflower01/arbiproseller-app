import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { checkMarketplaceAccess } from '../_shared/marketplace-guard.ts';
import { checkModuleAccess } from '../_shared/module-access-guard.ts';
import { logHealthSignal, HealthSignals } from "../_shared/health-signal.ts";
import { requireInternalOrUser } from '../_shared/require-internal.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface EvaluateRequest {
  assignmentId?: string;
  asin?: string;
  marketplace?: string;
  ruleId?: string;
  currentPrice?: number;
}

interface EvaluationResult {
  assignmentId?: string;
  asin: string;
  marketplace: string;
  currentPrice: number | null | undefined;
  recommendedPrice: number | null;
  reason: string;
  ruleId: string | null;
  ruleName: string | null;
  strategy: string | null;
  snapshot: {
    buybox_price: number | null;
    lowest_fba_price: number | null;
    lowest_fbm_price: number | null;
    lowest_overall_price: number | null;
    offers_count: number;
    fetched_at: string | null;
  } | null;
  safeguards: {
    min_price: number | null;
    max_price: number | null;
    min_profit: number | null;
    min_roi: number | null;
    applied: string[];
    [key: string]: any;
  };
}

// Strategy calculation functions
function calculateTargetPrice(
  strategy: string,
  undercutAmount: number,
  snapshot: any,
  targetSellerIds: string[],
  excludedSellers: string[],
  targetAnchor: string = 'smart',
  isBuyboxOwner: boolean = false,
  competeWithFbm: boolean = true,
  myFulfillmentType: 'FBA' | 'FBM' = 'FBA',
  ownSellerId: string | null = null
): { price: number | null; reason: string; competitorMode?: string; diagnostics?: any } {
  const offers = (snapshot?.offers_json || []) as any[];
  const conditionScope = snapshot?._condition_scope || 'New';

  const isOwnOffer = (o: any): boolean => {
    if (o?.is_self === true) return true;
    if (ownSellerId && o?.seller_id === ownSellerId) return true;
    return false;
  };

  // Filter out excluded sellers (and our own offers), and filter by condition
  let eligibleOffers = offers.filter((o: any) => {
    if (excludedSellers.includes(o.seller_id) || o.is_buybox_winner || isOwnOffer(o)) return false;
    // Condition-aware: Used items only compete with Used offers
    if (conditionScope === 'Used' && o.condition && o.condition !== 'Used' && !o.condition?.toLowerCase?.().includes('used')) return false;
    if (conditionScope === 'New' && o.condition === 'Used') return false;
    return true;
  });

  // Classify competitor landscape
  let fbaCompetitors = eligibleOffers.filter((o: any) => o.is_fba);
  let fbmCompetitors = eligibleOffers.filter((o: any) => !o.is_fba);
  let hasFbaCompetitors = fbaCompetitors.length > 0;
  let hasFbmCompetitors = fbmCompetitors.length > 0;
  const hasNoCompetitors = eligibleOffers.length === 0;

  // ============================================================
  // FBM-AWARE COHORT SELECTION
  // If I am FBM:
  //   - Compete only against FBM cohort when FBM competitors exist
  //   - Fall back to FBA cohort only when no FBM competitors exist
  //   - Never apply the FBM_ONLY_PREMIUM branch (that's for FBA sellers in an FBM-only market)
  // ============================================================
  const diagnostics: any = {
    my_fulfillment_type: myFulfillmentType,
    own_seller_id_present: Boolean(ownSellerId),
    own_offers_excluded: offers.filter(isOwnOffer).length,
    fba_competitors_total: fbaCompetitors.length,
    fbm_competitors_total: fbmCompetitors.length,
  };

  if (myFulfillmentType === 'FBM') {
    if (hasFbmCompetitors) {
      const ignoredFba = fbaCompetitors.length;
      eligibleOffers = fbmCompetitors;
      fbaCompetitors = [];
      hasFbaCompetitors = false;
      diagnostics.competitor_cohort = 'FBM_ONLY';
      diagnostics.fbm_competitors_found = fbmCompetitors.length;
      diagnostics.fba_competitors_ignored = ignoredFba;
      console.log(`[calculateTargetPrice] FBM-SELLER COHORT: restricted to ${fbmCompetitors.length} FBM competitors (ignored ${ignoredFba} FBA)`);
    } else if (hasFbaCompetitors) {
      diagnostics.competitor_cohort = 'FBA_FALLBACK';
      diagnostics.cohort_fallback_reason = 'no FBM competitors detected';
      console.log(`[calculateTargetPrice] FBM-SELLER COHORT: no FBM competitors → falling back to FBA cohort (${fbaCompetitors.length})`);
    } else {
      diagnostics.competitor_cohort = 'NONE';
    }
  } else {
    diagnostics.competitor_cohort = hasFbaCompetitors ? 'FBA_PRIMARY' : (hasFbmCompetitors ? 'FBM_ONLY_MARKET' : 'NONE');
  }

  // === SCENARIO C: No competitors at all → signal for raise toward max ===
  if (hasNoCompetitors && isBuyboxOwner) {
    const currentPrice = snapshot?.buybox_price || snapshot?.my_price;
    const maxPrice = snapshot?.max_price; // Will be clamped by safeguards later
    if (currentPrice) {
      console.log(`[calculateTargetPrice] NO COMPETITORS — monopoly profit mode, hold at current $${currentPrice.toFixed(2)} (safeguards will handle raise)`);
      return { price: currentPrice, reason: `No competitors — holding price (monopoly/raise logic applies via safeguards)`, competitorMode: 'NO_COMPETITION' };
    }
  }

  // === SCENARIO B: Only FBM competitors, no FBA → price above FBM with premium ===
  // ONLY valid for FBA sellers. An FBM seller pricing ABOVE the FBM cohort is self-defeating.
  if (myFulfillmentType === 'FBA' && !hasFbaCompetitors && hasFbmCompetitors && !competeWithFbm) {
    const lowestFbm = Math.min(...fbmCompetitors.map((o: any) => o.total_price));
    // Configurable premium: max(FBM + fixed amount, FBM × (1 + percent))
    // Defaults: 10% or $2.00 fixed, whichever is higher
    const fbmPremiumPct = (snapshot?._fbm_premium_percent ?? 10) / 100;
    const fbmPremiumFixed = snapshot?._fbm_premium_fixed ?? 2.0;
    const pctPrice = Math.round(lowestFbm * (1 + fbmPremiumPct) * 100) / 100;
    const fixedPrice = Math.round((lowestFbm + fbmPremiumFixed) * 100) / 100;
    const premiumPrice = Math.max(pctPrice, fixedPrice);
    console.log(`[calculateTargetPrice] FBM-ONLY: lowest FBM=$${lowestFbm.toFixed(2)} → premium price=$${premiumPrice.toFixed(2)} (pct=${(fbmPremiumPct*100).toFixed(0)}%=$${pctPrice.toFixed(2)}, fixed=+$${fbmPremiumFixed.toFixed(2)}=$${fixedPrice.toFixed(2)})`);
    return { price: premiumPrice, reason: `FBM-only market: $${lowestFbm.toFixed(2)} + FBA premium → $${premiumPrice.toFixed(2)}`, competitorMode: 'FBM_ONLY_PREMIUM' };
  }

  // If not competing with FBM, filter out FBM offers for normal strategy
  if (!competeWithFbm) {
    eligibleOffers = eligibleOffers.filter((o: any) => o.is_fba);
    console.log(`[calculateTargetPrice] compete_with_fbm=false — filtered to ${eligibleOffers.length} FBA-only offers`);
  }

  // Check if buybox winner is FBA (used to skip FBM buybox when not competing with FBM)
  const buyboxIsFba = snapshot?.buybox_is_fba ?? true; // default true if unknown

  // If we own the Buy Box and are the lowest eligible offer, hold price — no need to undercut ourselves
  if (isBuyboxOwner && strategy !== 'BEAT_SPECIFIC_SELLER_MINUS') {
    const buyboxPrice = snapshot?.buybox_price;
    const otherOffers = eligibleOffers.filter((o: any) => !o.is_buybox_winner);
    const lowestOther = otherOffers.length > 0 ? Math.min(...otherOffers.map((o: any) => o.total_price)) : null;

    if (buyboxPrice && (!lowestOther || buyboxPrice <= lowestOther)) {
      console.log(`[calculateTargetPrice] BB owner & lowest — holding at $${buyboxPrice.toFixed(2)}`);
      return { price: buyboxPrice, reason: `Holding price: BB owner & lowest ($${buyboxPrice.toFixed(2)})` };
    }
  }

  // === GAP-AWARE SMART RAISE: If already lowest in cohort by a safe margin, raise toward next competitor ===
  if (strategy !== 'BEAT_SPECIFIC_SELLER_MINUS') {
    const myPrice = snapshot?.my_price || snapshot?.current_price;
    // Cohort-aware: FBM seller raises against FBM cohort; FBA seller against FBA cohort
    const cohortPool = myFulfillmentType === 'FBM'
      ? eligibleOffers // already restricted to FBM (or FBA fallback) above
      : eligibleOffers.filter((o: any) => o.is_fba);
    const cohortLabel = myFulfillmentType === 'FBM' ? (diagnostics.competitor_cohort === 'FBA_FALLBACK' ? 'FBA' : 'FBM') : 'FBA';
    const nextCohortPrice = cohortPool.length > 0 ? Math.min(...cohortPool.map((o: any) => o.total_price)) : null;

    if (myPrice && myPrice > 0 && nextCohortPrice && nextCohortPrice > myPrice) {
      const gapAbs = nextCohortPrice - myPrice;
      const gapPct = gapAbs / myPrice;
      const safeGap = gapPct >= 0.02 || gapAbs >= 0.15;

      if (safeGap) {
        const raiseStep = Math.max(0.01, Math.round(gapAbs * 0.15 * 100) / 100);
        const raiseTarget = Math.round((myPrice + raiseStep) * 100) / 100;
        const ceiling = Math.round((nextCohortPrice - 0.01) * 100) / 100;
        const smartRaisePrice = Math.min(raiseTarget, ceiling);

        if (smartRaisePrice > myPrice) {
          console.log(`[calculateTargetPrice] GAP-AWARE SMART RAISE [${cohortLabel}]: lowest at $${myPrice.toFixed(2)}, next ${cohortLabel}=$${nextCohortPrice.toFixed(2)} (gap=$${gapAbs.toFixed(2)}) — raising to $${smartRaisePrice.toFixed(2)}`);
          return { price: smartRaisePrice, reason: `Smart raise: lowest ${cohortLabel} ($${myPrice.toFixed(2)}), next ${cohortLabel} $${nextCohortPrice.toFixed(2)} — raising to $${smartRaisePrice.toFixed(2)} (gap recovery +$${raiseStep.toFixed(2)})`, diagnostics };
        }

        console.log(`[calculateTargetPrice] GAP-AWARE HOLD [${cohortLabel}]: already lowest at $${myPrice.toFixed(2)}, next=$${nextCohortPrice.toFixed(2)} — at ceiling`);
        return { price: myPrice, reason: `Holding: already lowest ${cohortLabel} ($${myPrice.toFixed(2)}), next ${cohortLabel} $${nextCohortPrice.toFixed(2)} — at ceiling`, diagnostics };
      }
    }
  }

  // Helper: get anchor price based on target_anchor setting
  // When compete_with_fbm=false and BB is FBM, skip BB and go straight to lowest FBA
  function getAnchorPrice(): { price: number | null; reason: string } {
    const rawBuyboxPrice = snapshot?.buybox_price;
    // Only use BB as anchor if it's FBA, or if we compete with FBM
    const buyboxPrice = (competeWithFbm || buyboxIsFba) ? rawBuyboxPrice : null;
    const fbaOffers = eligibleOffers.filter((o: any) => o.is_fba);
    const lowestFba = fbaOffers.length > 0 ? Math.min(...fbaOffers.map((o: any) => o.total_price)) : null;
    const lowestOverall = eligibleOffers.length > 0 ? Math.min(...eligibleOffers.map((o: any) => o.total_price)) : null;

    if (!competeWithFbm && !buyboxIsFba && rawBuyboxPrice) {
      console.log(`[getAnchorPrice] Skipping FBM Buy Box ($${rawBuyboxPrice.toFixed(2)}) — compete_with_fbm=false, falling back to Lowest FBA`);
    }

    switch (targetAnchor) {
      case 'buybox':
        if (!buyboxPrice) {
          // Fallback to lowest FBA when BB is FBM and we don't compete with FBM
          if (lowestFba) return { price: Math.max(0.01, lowestFba - undercutAmount), reason: `Lowest FBA ($${lowestFba.toFixed(2)}) - $${undercutAmount.toFixed(2)} undercut [BB is FBM, FBA-only mode]` };
          return { price: null, reason: 'No Buy Box price available (BB is FBM, no FBA fallback)' };
        }
        return { price: Math.max(0.01, buyboxPrice - undercutAmount), reason: `Buy Box ($${buyboxPrice.toFixed(2)}) - $${undercutAmount.toFixed(2)} undercut` };

      case 'lowest_fba':
        if (!lowestFba) return { price: null, reason: 'No FBA offers found' };
        return { price: Math.max(0.01, lowestFba - undercutAmount), reason: `Lowest FBA ($${lowestFba.toFixed(2)}) - $${undercutAmount.toFixed(2)} undercut` };

      case 'lowest_offer':
        if (!lowestOverall) return { price: null, reason: 'No offers found' };
        return { price: Math.max(0.01, lowestOverall - undercutAmount), reason: `Lowest overall ($${lowestOverall.toFixed(2)}) - $${undercutAmount.toFixed(2)} undercut` };

      case 'smart_recapture': {
        const myCurrentPrice = snapshot?.my_price || snapshot?.current_price;
        if (lowestFba && myCurrentPrice && lowestFba < myCurrentPrice) {
          return { price: Math.max(0.01, lowestFba - undercutAmount), reason: `Lowest FBA ($${lowestFba.toFixed(2)}) - $${undercutAmount.toFixed(2)} undercut [smart_recapture: not lowest]` };
        }
        if (buyboxPrice) {
          return { price: Math.max(0.01, buyboxPrice - undercutAmount), reason: `Buy Box ($${buyboxPrice.toFixed(2)}) - $${undercutAmount.toFixed(2)} undercut [smart_recapture: already lowest]` };
        }
        if (lowestFba) {
          return { price: Math.max(0.01, lowestFba - undercutAmount), reason: `Lowest FBA ($${lowestFba.toFixed(2)}) - $${undercutAmount.toFixed(2)} undercut [smart_recapture fallback]` };
        }
        return { price: null, reason: 'No Buy Box or FBA offers available' };
      }

      case 'smart':
      default:
        if (buyboxPrice) {
          return { price: Math.max(0.01, buyboxPrice - undercutAmount), reason: `Buy Box ($${buyboxPrice.toFixed(2)}) - $${undercutAmount.toFixed(2)} undercut [smart]` };
        }
        if (lowestFba) {
          return { price: Math.max(0.01, lowestFba - undercutAmount), reason: `Lowest FBA ($${lowestFba.toFixed(2)}) - $${undercutAmount.toFixed(2)} undercut [smart fallback]` };
        }
        return { price: null, reason: 'No Buy Box or FBA offers available' };
    }
  }

  const _strategyResult: { price: number | null; reason: string; competitorMode?: string } = (() => {
    switch (strategy) {
      case 'MATCH_LOWEST_FBA_MINUS': {
        const fbaOffers = eligibleOffers.filter((o: any) => o.is_fba);
        if (fbaOffers.length === 0) {
          return { price: null, reason: 'No FBA offers found' };
        }
        const lowestFba = Math.min(...fbaOffers.map((o: any) => o.total_price));
        return {
          price: Math.max(0.01, lowestFba - undercutAmount),
          reason: `Lowest FBA ($${lowestFba.toFixed(2)}) - $${undercutAmount.toFixed(2)} undercut`
        };
      }

      case 'MATCH_LOWEST_OVERALL_MINUS': {
        if (eligibleOffers.length === 0) {
          return { price: null, reason: 'No offers found' };
        }
        const lowest = Math.min(...eligibleOffers.map((o: any) => o.total_price));
        return {
          price: Math.max(0.01, lowest - undercutAmount),
          reason: `Lowest overall ($${lowest.toFixed(2)}) - $${undercutAmount.toFixed(2)} undercut`
        };
      }

      case 'BEAT_BUYBOX_MINUS': {
        return getAnchorPrice();
      }

      case 'STAY_WITHIN_BUYBOX_RANGE': {
        const anchor = getAnchorPrice();
        if (!anchor.price) return anchor;
        return {
          price: anchor.price + undercutAmount,
          reason: anchor.reason.replace('undercut', 'match')
        };
      }

      case 'BEAT_SPECIFIC_SELLER_MINUS': {
        if (targetSellerIds.length === 0) {
          return { price: null, reason: 'No target sellers specified' };
        }
        const targetOffers = eligibleOffers.filter((o: any) =>
          targetSellerIds.includes(o.seller_id)
        );
        if (targetOffers.length === 0) {
          return { price: null, reason: 'Target sellers not found in offers' };
        }
        const lowestTarget = Math.min(...targetOffers.map((o: any) => o.total_price));
        return {
          price: Math.max(0.01, lowestTarget - undercutAmount),
          reason: `Target seller ($${lowestTarget.toFixed(2)}) - $${undercutAmount.toFixed(2)} undercut`
        };
      }

      case 'MIN_PROFIT_GUARD': {
        return { price: null, reason: 'MIN_PROFIT_GUARD is a safeguard, not a pricing strategy' };
      }

      default:
        return { price: null, reason: `Unknown strategy: ${strategy}` };
    }
  })();
  return { ..._strategyResult, diagnostics };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  const __forbidden = await requireInternalOrUser(req);
  if (__forbidden) return __forbidden;


  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body: EvaluateRequest & { dry_run?: boolean; internal?: boolean; user_id?: string } = await req.json();
    const {
      assignmentId,
      asin,
      marketplace = 'US',
      ruleId,
      currentPrice,
      dry_run = false,
      internal = false,
      user_id: internalUserId,
    } = body;

    // Auth check: allow either a signed-in user JWT or a trusted internal service-to-service call
    const authHeader = req.headers.get('Authorization');
    const internalHeader = req.headers.get('x-internal-secret');
    const isTrustedInternalCall = Boolean(
      internal &&
      internalUserId &&
      ((internalHeader && internalSecret && internalHeader === internalSecret) ||
        (authHeader && authHeader === `Bearer ${supabaseKey}`))
    );

    let user: { id: string } | null = null;

    if (isTrustedInternalCall) {
      user = { id: internalUserId! };
    } else {
      if (!authHeader?.startsWith('Bearer ')) {
        return new Response(
          JSON.stringify({ success: false, error: 'Unauthorized' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const token = authHeader.replace('Bearer ', '');
      const authClient = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: authHeader } },
      });

      const { data: claimsData } = await authClient.auth.getClaims(token);
      const claimUserId = typeof claimsData?.claims?.sub === 'string' ? claimsData.claims.sub : null;

      if (claimUserId) {
        user = { id: claimUserId };
      } else {
        const { data: { user: authUser }, error: userError } = await authClient.auth.getUser(token);
        if (userError || !authUser) {
          return new Response(
            JSON.stringify({ success: false, error: 'Unauthorized' }),
            { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        user = { id: authUser.id };
      }
    }

    // SERVER-SIDE MARKETPLACE GUARD: Non-admins restricted to home marketplace
    if (!isTrustedInternalCall) {
      const guard = await checkMarketplaceAccess(supabase, user.id, marketplace);
      if (!guard.allowed) {
        console.warn(`[MARKETPLACE_GUARD] ${guard.reason}`);
        return new Response(JSON.stringify({ success: false, error: guard.reason }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // MODULE ACCESS GUARD: triggering an evaluation = repricer:run
      const access = await checkModuleAccess(supabase, user.id, 'repricer', 'run');
      if (!access.allowed) {
        console.warn(`[repricer-evaluate] MODULE BLOCKED user=${user.id} reason=${access.reason}`);
        return new Response(JSON.stringify({ success: false, error: access.reason }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    console.log(`[repricer-evaluate] User ${user.id} evaluating`, { assignmentId, asin, marketplace, ruleId });

    // Get assignment if assignmentId provided
    let assignment: any = null;
    let rule: any = null;
    let targetAsin = asin;
    let targetMarketplace = marketplace;
    let targetCurrentPrice = currentPrice;

    let inventoryAvailable: number | null = null;
    let inventoryReserved = 0;

    if (assignmentId) {
      const { data: assignmentData, error: assignmentError } = await supabase
        .from('repricer_assignments')
        .select('*, repricer_rules!repricer_assignments_rule_id_fkey(*)')
        .eq('id', assignmentId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (assignmentError || !assignmentData) {
        throw new Error('Assignment not found');
      }
      
      assignment = assignmentData;
      rule = assignmentData.repricer_rules;
      targetAsin = assignmentData.asin;
      targetMarketplace = assignmentData.marketplace;

      // === ELIGIBILITY CHECK: Skip inactive listings and zero-sellable-stock items ===
      const { data: invCheck } = await supabase
        .from('inventory')
        .select('available, reserved, listing_status')
        .eq('user_id', user.id)
        .eq('sku', assignmentData.sku)
        .maybeSingle();

      if (invCheck) {
        const ls = (invCheck.listing_status || '').toUpperCase();
        const isInactive = ls === 'INACTIVE' || ls === 'NOT_FOUND' || ls === 'INCOMPLETE';
        const sellableQty = (invCheck.available || 0);
        inventoryAvailable = invCheck.available ?? inventoryAvailable;
        inventoryReserved = invCheck.reserved || 0;

        if (isInactive) {
          console.log(`[repricer-evaluate] SKIP ${targetAsin}: listing is ${ls}`);
          return new Response(JSON.stringify({
            recommendedPrice: null,
            reason: `Listing is ${ls} — not eligible for repricing`,
            guardsApplied: ['LISTING_INACTIVE'],
            skipReason: 'LISTING_INACTIVE',
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        if (sellableQty === 0) {
          const reservedQty = invCheck.reserved || 0;
          if (reservedQty === 0) {
            console.log(`[repricer-evaluate] SKIP ${targetAsin}: no sellable inventory (available=0, reserved=0)`);
            return new Response(JSON.stringify({
              recommendedPrice: null,
              reason: `No sellable inventory (0 available, 0 reserved) — skipping evaluation`,
              guardsApplied: ['NO_SELLABLE_QTY'],
              skipReason: 'NO_SELLABLE_QTY',
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          // reserved > 0: allow evaluation in stock-gated maximize mode (pre-position pricing)
          console.log(`[repricer-evaluate] STOCK-GATED ${targetAsin}: available=0, reserved=${reservedQty} — running in pre-position pricing mode`);
        }
      }
    } else if (ruleId) {
      // Get rule directly for testing
      const { data: ruleData, error: ruleError } = await supabase
        .from('repricer_rules')
        .select('*')
        .eq('id', ruleId)
        .eq('user_id', user.id)
        .maybeSingle();

      if (ruleError || !ruleData) {
        throw new Error('Rule not found');
      }
      rule = ruleData;
    }

    if (!targetAsin) {
      throw new Error('ASIN is required');
    }

    if (!rule) {
      throw new Error('No rule specified for evaluation');
    }

    // === HARD SAFETY: Min price must exist (Pure Min/Max architecture) ===
    const effectiveMinStd = assignment?.min_price_override ?? rule.min_price;
    if (!effectiveMinStd || effectiveMinStd <= 0) {
      console.error(`[SAFETY] DO_NOT_REPRICE: Min price missing for ${targetAsin}`);
      return new Response(JSON.stringify({
        recommendedPrice: null,
        reason: 'Min price is required but missing or zero — set a Min price to enable repricing',
        guardsApplied: ['MIN_PRICE_REQUIRED'],
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get current price and cost from inventory if not provided
    let inventoryCost: number | null = null;
    if (targetCurrentPrice === undefined || targetCurrentPrice === null) {
      const { data: inventoryItem } = await supabase
        .from('inventory')
        .select('price, my_price, cost, last_price_update_at, last_price_update_status')
        .eq('user_id', user.id)
        .eq('asin', targetAsin)
        .maybeSingle();

      targetCurrentPrice = inventoryItem?.my_price || inventoryItem?.price || null;
      inventoryCost = inventoryItem?.cost || null;

      // ── FBM FALLBACK: FBM listings created via our tool live in `created_listings`
      // and never get an inventory row from the Summaries API. Without this fallback
      // the engine sees `My Price: missing` and records no decision.
      if (!targetCurrentPrice || targetCurrentPrice <= 0) {
        const { data: createdListing } = await supabase
          // Phase 2: shared source-of-truth view (validation gate + ghost filter)
          .from('active_created_listings')
          .select('price, cost, amount, units')
          .eq('user_id', user.id)
          .eq('asin', targetAsin)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (createdListing?.price && createdListing.price > 0) {
          targetCurrentPrice = Number(createdListing.price);
          // VERIFIED BUG FIX (2026-06-17): `created_listings.cost` is the BATCH
          // TOTAL (e.g. 125 for 10 units), `amount` is the PER-UNIT cost (12.5).
          // Using `.cost` as a unit cost previously inflated ROI floors by Nx
          // (where N = units in the purchase batch), causing FBM lanes to refuse
          // to compete on price. Prefer `.amount`; fall back to cost/units; only
          // fall back to raw `.cost` when units is unknown or 1.
          if (!inventoryCost) {
            // Use shared resolver so the contract is unit-tested in isolation
            // (see supabase/functions/_tests/repricer-evaluate/fbm_cost_resolver_test.ts).
            const { resolveFbmUnitCost } = await import('../_shared/fbm-cost-resolver.ts');
            const resolved = resolveFbmUnitCost({
              cost: createdListing.cost,
              amount: createdListing.amount,
              units: createdListing.units,
            });
            if (resolved.unitCost && resolved.unitCost > 0) inventoryCost = resolved.unitCost;
            // Telemetry: tag which fallback path resolved the unit cost so we
            // can detect upstream regressions (e.g. a writer that stops
            // populating `amount` causing the platform to silently rely on
            // cost/units divisions forever). Searchable: COST_FALLBACK_PATH.
            console.log(`[repricer-evaluate] COST_FALLBACK_PATH path=${resolved.path} asin=${targetAsin} cost=${createdListing.cost} amount=${createdListing.amount} units=${createdListing.units} resolved=${inventoryCost}`);
          }
          console.log(`[repricer-evaluate] FBM FALLBACK: using created_listings price $${targetCurrentPrice.toFixed(2)} cost=$${inventoryCost ?? 'n/a'} for ${targetAsin} (no inventory row)`);
        }
      }
    } else {
      const { data: inventoryItem } = await supabase
        .from('inventory')
        .select('cost, my_price, price, last_price_update_at, last_price_update_status')
        .eq('user_id', user.id)
        .eq('asin', targetAsin)
        .maybeSingle();
      inventoryCost = inventoryItem?.cost || null;

      const inventoryLivePrice = inventoryItem?.my_price ?? inventoryItem?.price ?? null;
      const inventoryPriceUpdateTs = inventoryItem?.last_price_update_at ? new Date(inventoryItem.last_price_update_at).getTime() : 0;
      const assignmentLastAppliedTs = assignment?.last_applied_at ? new Date(assignment.last_applied_at).getTime() : 0;
      if (
        inventoryLivePrice != null &&
        inventoryItem?.last_price_update_status === 'success' &&
        inventoryPriceUpdateTs >= assignmentLastAppliedTs &&
        Math.abs(inventoryLivePrice - targetCurrentPrice) >= 0.01
      ) {
        console.log(`[repricer-evaluate] CURRENT PRICE OVERRIDE: using inventory/live $${inventoryLivePrice.toFixed(2)} instead of request $${targetCurrentPrice?.toFixed(2)}`);
        targetCurrentPrice = inventoryLivePrice;
      }
    }

    // Get latest competitor snapshot
    const { data: snapshot } = await supabase
      .from('repricer_competitor_snapshots')
      .select('*')
      .eq('user_id', user.id)
      .eq('asin', targetAsin)
      .eq('marketplace', targetMarketplace)
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: sellerAuth } = await supabase
      .from('seller_authorizations')
      .select('seller_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();
    const ownSellerId = sellerAuth?.seller_id || null;

    // Calculate target price based on strategy
    const rawIsBuyboxOwner = snapshot?.is_buybox_owner === true;
    // Stale BB owner sanity check: if our price is >5% above BB, we can't be winning
    let isBuyboxOwner = rawIsBuyboxOwner && !(
      targetCurrentPrice && snapshot?.buybox_price && 
      targetCurrentPrice > snapshot.buybox_price * 1.05
    );
    if (rawIsBuyboxOwner && !isBuyboxOwner) {
      console.log(`[repricer-evaluate] STALE BB OVERRIDE: price $${targetCurrentPrice?.toFixed(2)} >> BB $${snapshot?.buybox_price?.toFixed(2)} — not treating as BB owner`);
    }
    if ((inventoryAvailable ?? 0) === 0 && inventoryReserved > 0 && isBuyboxOwner) {
      console.log(`[repricer-evaluate] RESERVED-STOCK OVERRIDE: available=0, reserved=${inventoryReserved} — not treating ${targetAsin} as active BB owner for hold logic`);
      isBuyboxOwner = false;
    }
    const competeWithFbm = rule.compete_with_fbm ?? true;
    // Inject configurable FBM premium into snapshot for calculateTargetPrice
    if (snapshot) {
      snapshot._fbm_premium_percent = rule.fbm_premium_percent ?? 10;
      snapshot._fbm_premium_fixed = rule.fbm_premium_fixed ?? 2.0;
      // Inject condition scope for condition-aware filtering
      const isUsedBySku = assignment?.sku?.startsWith('amzn.gr.');
      snapshot._condition_scope = rule.condition_scope === 'Used' || (rule.condition_scope === 'Any' && isUsedBySku) ? 'Used' : 'New';
    }
    console.log(`[repricer-evaluate] Rule settings: compete_with_fbm=${competeWithFbm}, fbm_premium=${rule.fbm_premium_percent ?? 10}%/$${rule.fbm_premium_fixed ?? 2.0}, buybox_is_fba=${snapshot?.buybox_is_fba}, buybox_price=${snapshot?.buybox_price}`);
    // === Detect MY fulfillment type (FBA vs FBM) ===
    // Source of truth: inventory.source ('amazon_sync_fbm' = FBM) or created_listings (FBM-only path)
    let myFulfillmentType: 'FBA' | 'FBM' = 'FBA';
    {
      const { data: invSrc } = await supabase
        .from('inventory')
        .select('source')
        .eq('user_id', user.id)
        .eq('asin', targetAsin)
        .maybeSingle();
      if (invSrc?.source === 'amazon_sync_fbm') {
        myFulfillmentType = 'FBM';
      } else if (!invSrc) {
        // No inventory row — check if listing was created via our FBM tool
        const { data: cl } = await supabase
          // Phase 2: shared source-of-truth view (validation gate + ghost filter)
          .from('active_created_listings')
          .select('id')
          .eq('user_id', user.id)
          .eq('asin', targetAsin)
          .limit(1)
          .maybeSingle();
        if (cl) myFulfillmentType = 'FBM';
      }
    }
    console.log(`[repricer-evaluate] My fulfillment type for ${targetAsin}: ${myFulfillmentType}`);

    const { price: rawTargetPrice, reason, diagnostics: fulfillmentDiagnostics } = calculateTargetPrice(
      rule.strategy,
      rule.undercut_amount ?? 0.01,
      snapshot,
      rule.target_seller_ids || [],
      rule.excluded_sellers || [],
      rule.target_anchor || 'smart',
      isBuyboxOwner,
      competeWithFbm,
      myFulfillmentType,
      ownSellerId
    );

    // Apply safeguards
    const safeguardsApplied: string[] = [];
    let finalPrice = rawTargetPrice;

    // COST_MISSING_MIN_USED tag for visibility
    if ((!inventoryCost || inventoryCost <= 0) && effectiveMinStd > 0) {
      safeguardsApplied.push('COST_MISSING_MIN_USED');
      console.warn(`[SAFETY] COST_MISSING_MIN_USED: ${targetAsin} — cost is null/zero, using Min price ($${effectiveMinStd.toFixed(2)}) as sole floor`);
    }

    // Get min/max from assignment override or rule
    const effectiveMinPrice = assignment?.min_price_override ?? rule.min_price;
    const effectiveMaxPrice = assignment?.max_price_override ?? rule.max_price;

    // ============================================================
    // Min ROI Protection — enforced as a hard floor when min_roi_enabled
    // ROI analytics only when NOT enabled (compute and log, but never block)
    // ============================================================
    let roiFloorPrice: number | null = null;
    let roiFloorSource: 'cached_fees' | 'fallback_static' | 'none' = 'none';
    const minRoiEnabled = rule.min_roi_enabled ?? false;
    const minRoiMarketplaceOverrides = rule.min_roi_marketplace_overrides || {};
    const enableDynamicRoi = rule.enable_dynamic_roi ?? false;
    
    // Determine effective ROI: marketplace override > rule default > fallback
    const marketplaceRoiOverride = minRoiEnabled
      ? (minRoiMarketplaceOverrides[targetMarketplace] ?? rule.min_roi_percent ?? null)
      : null;
    const targetRoiPercent = marketplaceRoiOverride ?? rule.min_roi_percent ?? 40;

    if ((minRoiEnabled || enableDynamicRoi) && inventoryCost && inventoryCost > 0) {
      const { data: feeCache } = await supabase
        .from('asin_fee_cache')
        .select('referral_rate, fba_fee_fixed, is_media, updated_at')
        .eq('user_id', user.id)
        .eq('asin', targetAsin)
        .eq('marketplace', targetMarketplace)
        .maybeSingle();

      if (feeCache && feeCache.referral_rate > 0) {
        const referralRate = feeCache.referral_rate;
        const fbaFeeFixed = feeCache.fba_fee_fixed || 0;
        const closingFee = feeCache.is_media ? 1.80 : 0;
        const cacheAge = feeCache.updated_at 
          ? Math.floor((Date.now() - new Date(feeCache.updated_at).getTime()) / (1000 * 60 * 60 * 24))
          : null;
        if (cacheAge && cacheAge > 14) {
          console.warn(`[ROI-FLOOR] ${targetAsin}: Fee cache is ${cacheAge} days old — consider refreshing`);
        }

        const requiredProfit = inventoryCost * (targetRoiPercent / 100);
        const numerator = inventoryCost + fbaFeeFixed + closingFee + requiredProfit;
        const denominator = 1 - referralRate;

        if (denominator > 0) {
          roiFloorPrice = Math.ceil(numerator / denominator * 100) / 100;
          roiFloorSource = 'cached_fees';
          console.log(`[ROI-FLOOR] ${targetAsin}: ${minRoiEnabled ? 'ENFORCED' : 'analytics_only'} source=cached_fees (${cacheAge ?? '?'}d old), cost=$${inventoryCost.toFixed(2)}, fees=(${(referralRate*100).toFixed(1)}% + $${fbaFeeFixed.toFixed(2)} + $${closingFee.toFixed(2)}), targetROI=${targetRoiPercent}% → ROI floor=$${roiFloorPrice.toFixed(2)}`);
        }
      } else {
        roiFloorSource = 'fallback_static';
        if (minRoiEnabled) {
          console.warn(`[ROI-FLOOR] ${targetAsin}: Min ROI enabled but fee cache unavailable — will block lowering`);
        }
      }
    } else if (minRoiEnabled && (!inventoryCost || inventoryCost <= 0)) {
      console.warn(`[ROI-FLOOR] ${targetAsin}: Min ROI enabled but cost missing — will block lowering`);
    }

    // Build effective floor: if min_roi_enabled, ROI floor becomes a hard floor
    let effectiveFloor = effectiveMinPrice || 0;
    let runtimeMaxOverride: number | null = null;
    
    if (minRoiEnabled && roiFloorPrice && roiFloorPrice > 0) {
      effectiveFloor = Math.max(effectiveFloor, roiFloorPrice);
      safeguardsApplied.push(`MIN_ROI_FLOOR: $${roiFloorPrice.toFixed(2)} (${targetRoiPercent}% ROI)`);
      
      // Runtime max override if ROI floor exceeds stored max
      const currentMax = effectiveMaxPrice;
      if (currentMax !== null && roiFloorPrice > currentMax) {
        runtimeMaxOverride = Math.round((roiFloorPrice + 0.50) * 100) / 100;
        safeguardsApplied.push(`MIN_ROI_MAX_OVERRIDE: $${currentMax.toFixed(2)} → $${runtimeMaxOverride.toFixed(2)}`);
      }
    } else if (minRoiEnabled && (!roiFloorPrice || roiFloorPrice <= 0)) {
      // Min ROI enabled but cannot calculate floor — block lowering (hold current price)
      safeguardsApplied.push('MIN_ROI_DATA_MISSING');
    }
    
    const effectiveMaxFinal = runtimeMaxOverride ?? effectiveMaxPrice;

    // ============================================================
    // STRATEGY ENGINE — Milestone B
    // Read active strategy state and (optionally) apply floor relaxation.
    // SAFETY: relaxation NEVER lowers below MAX($5, roiFloor). Manual
    // floor portion is softened by a state-specific factor (0.85–1.00),
    // bounded by absolute $5 and ROI floor (both preserved).
    // ============================================================
    let strategyState: string = 'profit_max';
    let floorRelaxed = false;
    let floorRelaxedReason: string | null = null;
    const originalFloor = effectiveFloor;
    try {
      const { data: stateData } = await supabase.rpc('get_active_strategy_state', {
        _user_id: user.id,
        _asin: targetAsin,
        _marketplace_id: targetMarketplace,
      });
      strategyState = (stateData as string) || 'profit_max';
    } catch (e) {
      console.warn('[STRATEGY] state lookup failed, defaulting profit_max', (e as Error).message);
    }

    const dynamicRelaxEnabled = (rule as any).enable_dynamic_floor_relaxation === true;
    if (dynamicRelaxEnabled && (effectiveMinPrice ?? 0) > 0 && strategyState !== 'profit_max') {
      try {
        const { data: factorRaw } = await supabase.rpc('repricer_floor_relaxation_factor', {
          _state: strategyState,
        });
        const factor = Number(factorRaw ?? 1);
        if (factor < 1 && factor >= 0.85) {
          const ABSOLUTE_FLOOR = 5.00; // never go below $5
          const relaxedManual = Math.max(ABSOLUTE_FLOOR, (effectiveMinPrice as number) * factor);
          const newFloor = Math.max(relaxedManual, roiFloorPrice ?? 0);
          if (newFloor < effectiveFloor) {
            effectiveFloor = newFloor;
            floorRelaxed = true;
            floorRelaxedReason = `Strategy "${strategyState}": floor softened by ${Math.round((1 - factor) * 100)}% (was $${originalFloor.toFixed(2)} → $${effectiveFloor.toFixed(2)}); ROI/$5 floors preserved`;
            safeguardsApplied.push(`STRATEGY_${strategyState.toUpperCase()}_FLOOR_RELAXED`);
          } else {
            floorRelaxedReason = `Strategy "${strategyState}": relaxation blocked by ROI/$5 hard floor`;
          }
        }
      } catch (e) {
        console.warn('[STRATEGY] relaxation factor lookup failed', (e as Error).message);
      }
    } else if (!dynamicRelaxEnabled) {
      floorRelaxedReason = 'Dynamic floor relaxation disabled on this rule';
    } else if (strategyState === 'profit_max') {
      floorRelaxedReason = 'Healthy state — no relaxation needed';
    }

    if (finalPrice !== null && finalPrice !== undefined) {
      // Min ROI data missing: block any lowering, hold current price
      if (minRoiEnabled && safeguardsApplied.includes('MIN_ROI_DATA_MISSING') && finalPrice < (targetCurrentPrice || 0)) {
        finalPrice = targetCurrentPrice ?? finalPrice;
        safeguardsApplied.push('MIN_ROI_HOLD: cost/fees missing, holding current price');
      }
      
      if (effectiveFloor > 0 && (finalPrice as number) < effectiveFloor) {
        finalPrice = effectiveFloor;
        safeguardsApplied.push(`⚠️ Safeguard: clamped to Min floor $${effectiveFloor.toFixed(2)}`);
      }

      // Max price guard (uses runtime override if Min ROI raised it)
      if (effectiveMaxFinal !== null && (finalPrice as number) > effectiveMaxFinal) {
        finalPrice = effectiveMaxFinal;
        safeguardsApplied.push(`Ceiling applied: $${effectiveMaxFinal.toFixed(2)}`);
      }

      // Profit analytics only (never blocks pricing)
      if (rule.min_profit !== null && rule.floor_source === 'cost_plus') {
        const { data: inventoryItem } = await supabase
          .from('inventory')
          .select('cost')
          .eq('user_id', user.id)
          .eq('asin', targetAsin)
          .maybeSingle();

        if ((inventoryItem as any)?.cost) {
          const minPriceForProfit = (inventoryItem as any).cost + rule.min_profit;
          if ((finalPrice as number) < minPriceForProfit) {
            console.log(`[repricer-evaluate] Profit analytics only: final price $${(finalPrice as number).toFixed(2)} is below profit target $${minPriceForProfit.toFixed(2)} — min/max remain the only blocking bounds`);
          }
        }
      }

      // Max change percent guard
      if (targetCurrentPrice && rule.max_change_percent) {
        const maxChange = targetCurrentPrice * (rule.max_change_percent / 100);
        const lowerBound = targetCurrentPrice - maxChange;
        const upperBound = targetCurrentPrice + maxChange;

        if ((finalPrice as number) < lowerBound) {
          finalPrice = lowerBound;
          safeguardsApplied.push(`Max ${rule.max_change_percent}% decrease applied`);
        } else if ((finalPrice as number) > upperBound) {
          finalPrice = upperBound;
          safeguardsApplied.push(`Max ${rule.max_change_percent}% increase applied`);
        }
      }

      // Min change threshold - skip if change is too small
      if (targetCurrentPrice && rule.min_change_threshold) {
        const change = Math.abs((finalPrice as number) - targetCurrentPrice);
        if (change < rule.min_change_threshold) {
          finalPrice = null;
          safeguardsApplied.push(`Change ($${change.toFixed(2)}) below threshold ($${rule.min_change_threshold.toFixed(2)})`);
        }
      }

      // Round to 2 decimal places
      if (finalPrice !== null && finalPrice !== undefined) {
        finalPrice = Math.round(finalPrice * 100) / 100;
      }
    }

    // AGE OVERLAY — Removed (was no-op, no data populated)

    const result: EvaluationResult = {
      assignmentId: assignment?.id,
      asin: targetAsin,
      marketplace: targetMarketplace,
      currentPrice: targetCurrentPrice,
      recommendedPrice: finalPrice,
      reason: safeguardsApplied.length > 0 ? `${reason} | ${safeguardsApplied.join(', ')}` : reason,
      ruleId: rule.id,
      ruleName: rule.name,
      strategy: rule.strategy,
      snapshot: snapshot ? {
        buybox_price: snapshot.buybox_price,
        lowest_fba_price: snapshot.lowest_fba_price,
        lowest_fbm_price: snapshot.lowest_fbm_price,
        lowest_overall_price: snapshot.lowest_overall_price,
        offers_count: snapshot.offers_count || 0,
        fetched_at: snapshot.fetched_at,
      } : null,
      safeguards: {
        min_price: effectiveMinPrice,
        max_price: effectiveMaxPrice,
        min_profit: rule.min_profit,
        min_roi: rule.min_roi,
        roi_floor: roiFloorPrice,
        roi_floor_source: roiFloorSource,
        static_min: effectiveMinPrice,
        effective_floor: effectiveFloor > 0 ? effectiveFloor : null,
        dynamic_roi_enabled: enableDynamicRoi,
        target_roi_percent: enableDynamicRoi ? targetRoiPercent : null,
        applied: safeguardsApplied,
        my_fulfillment_type: myFulfillmentType,
        competitor_cohort: fulfillmentDiagnostics?.competitor_cohort ?? null,
        cohort_fallback_reason: fulfillmentDiagnostics?.cohort_fallback_reason ?? null,
        fbm_competitors_found: fulfillmentDiagnostics?.fbm_competitors_found ?? fulfillmentDiagnostics?.fbm_competitors_total ?? null,
        fba_competitors_ignored: fulfillmentDiagnostics?.fba_competitors_ignored ?? null,
        fba_competitors_total: fulfillmentDiagnostics?.fba_competitors_total ?? null,
        fbm_competitors_total: fulfillmentDiagnostics?.fbm_competitors_total ?? null,
        // Strategy Engine (Milestone B)
        strategy_state: strategyState,
        floor_relaxed: floorRelaxed,
        floor_relaxed_reason: floorRelaxedReason,
        original_floor: originalFloor > 0 ? originalFloor : null,
        before_price: targetCurrentPrice ?? null,
        target_price: rawTargetPrice ?? null,
      },
    };

    // Update assignment with recommendation if applicable (skip for dry runs)
    if (assignment && finalPrice !== null && !dry_run) {
      await supabase
        .from('repricer_assignments')
        .update({
          last_evaluated_at: new Date().toISOString(),
          last_recommended_price: finalPrice,
          last_recommendation_reason: result.reason,
        })
        .eq('id', assignment.id);
    }

    console.log(`[repricer-evaluate] Result for ${targetAsin}:`, {
      currentPrice: targetCurrentPrice,
      recommendedPrice: finalPrice,
      reason: result.reason,
    });

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('[repricer-evaluate] Error:', error);
    try {
      const uid = (typeof user !== 'undefined' && user?.id) ? user.id : null;
      const asinForSig = (typeof targetAsin !== 'undefined') ? targetAsin : undefined;
      if (uid) HealthSignals.repricerEvalFailure(uid, 'repricer-evaluate', asinForSig, (error as Error)?.message?.slice(0, 500) || 'unknown');
    } catch (_) {}
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message || 'Failed to evaluate pricing' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
