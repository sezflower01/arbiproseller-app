// KEEPA-TOKEN-PROBE  (temporary diagnostic -- safe to delete)
//
// Answers one question: what does a /seller?storefront=1 call ACTUALLY cost
// in Keepa tokens, and does that cost scale with the seller's catalog size?
//
// This matters because the shared rate gate (_shared/keepa-rate-gate.ts)
// meters CALLS, not TOKENS -- it assumes every Keepa call is worth the same.
// If storefront calls bill per listing returned, then a 5,000-ASIN seller
// costs many times what a 50-ASIN seller costs, and any capacity plan built
// on "4 calls/min" is wrong. Scaling seller monitoring to hundreds of watches
// depends on which of those is true.
//
// Keepa returns tokensLeft / tokensConsumed / refillRate on EVERY response,
// so this just makes real calls and reports the accounting. Both are
// captured: tokensConsumed is authoritative, and the tokensLeft delta is
// kept as an independent cross-check (refill during the call can make the
// delta read slightly low -- refillRate is reported so it can be corrected).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { acquireKeepaGlobalSlot } from '../_shared/keepa-rate-gate.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const KEEPA_DOMAIN: Record<string, number> = {
  US: 1, GB: 2, DE: 3, FR: 4, JP: 5, CA: 6, IT: 8, ES: 9, IN: 10, MX: 11, BR: 12,
};

// Keep the blast radius small -- this spends real tokens from the same
// budget the live repricer draws on.
const MAX_SAMPLES = 6;
const PRODUCT_PROBE_ASINS = 50; // mirrors MAX_PRODUCT_DETAIL_ASINS in check-seller-watchlist

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Interactive probe, not a background sweep: wait for a slot rather than
// skipping, so a busy repricer doesn't silently produce an empty report.
async function acquireSlotWithRetry(supabase: any): Promise<{ ok: boolean; waitSeconds: number }> {
  const first = await acquireKeepaGlobalSlot(supabase);
  if (first.ok) return first;
  await new Promise((r) => setTimeout(r, Math.min(first.waitSeconds, 20) * 1000));
  return acquireKeepaGlobalSlot(supabase);
}

interface KeepaMeta {
  tokensLeft: number | null;
  tokensConsumed: number | null;
  refillIn: number | null;
  refillRate: number | null;
  tokenFlowReduction: number | null;
}

function readMeta(j: any): KeepaMeta {
  return {
    tokensLeft: typeof j?.tokensLeft === 'number' ? j.tokensLeft : null,
    tokensConsumed: typeof j?.tokensConsumed === 'number' ? j.tokensConsumed : null,
    refillIn: typeof j?.refillIn === 'number' ? j.refillIn : null,
    refillRate: typeof j?.refillRate === 'number' ? j.refillRate : null,
    tokenFlowReduction: typeof j?.tokenFlowReduction === 'number' ? j.tokenFlowReduction : null,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
    const KEEPA_KEY = Deno.env.get('KEEPA_API_KEY')?.trim();
    if (!KEEPA_KEY) return json({ error: 'KEEPA_API_KEY not configured' }, 500);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Privileged only -- this spends tokens. Accepts the same cron-style
    // internal secret / service-role bearer as check-seller-watchlist, or an
    // admin user JWT (has_role) so it can be run from a logged-in browser.
    const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET') || '';
    const providedSecret = req.headers.get('x-internal-secret') || '';
    const authHeader = req.headers.get('Authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    let authorized = (!!internalSecret && providedSecret === internalSecret)
      || (!!SERVICE_ROLE && bearer === SERVICE_ROLE);

    if (!authorized && bearer) {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData } = await userClient.auth.getUser();
      if (userData?.user) {
        const { data: isAdmin } = await admin.rpc('has_role', { _user_id: userData.user.id, _role: 'admin' });
        authorized = !!isAdmin;
      }
    }
    if (!authorized) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const marketplace = String(body.marketplace || 'US').toUpperCase();
    const domainId = KEEPA_DOMAIN[marketplace] ?? 1;
    const includeProductProbe = body.includeProductProbe !== false;
    // Re-run the capacity math for a different plan / budget split without
    // spending any tokens. Requires costPerCheckOverride + refillRateOverride
    // (take them from a previous live run's `capacity.assumptions`).
    const dryRun = body.dryRun === true;

    // Explicit seller list, else sample real active watches.
    let sellerIds: string[] = Array.isArray(body.sellerIds)
      ? body.sellerIds.map((s: unknown) => String(s).trim()).filter(Boolean)
      : [];

    if (!dryRun && sellerIds.length === 0) {
      const { data: watches } = await admin
        .from('seller_watchlist')
        .select('seller_id')
        .eq('status', 'active')
        .eq('marketplace', marketplace)
        .limit(100);
      sellerIds = Array.from(new Set((watches || []).map((w: any) => w.seller_id)));
    }

    sellerIds = sellerIds.slice(0, MAX_SAMPLES);
    if (!dryRun && sellerIds.length === 0) {
      return json({
        error: 'No seller IDs to probe. Pass {"sellerIds":["A1B0EBOAJDDILW"]}, add an active watch first, or use {"dryRun":true} with overrides.',
      }, 400);
    }

    const samples: any[] = [];
    let plan: KeepaMeta | null = null;
    let widestSeller: { sellerId: string; asins: string[] } | null = null;

    for (const sellerId of dryRun ? [] : sellerIds) {
      const slot = await acquireSlotWithRetry(admin);
      if (!slot.ok) {
        samples.push({ sellerId, skipped: true, reason: `rate gate busy, ~${slot.waitSeconds}s` });
        continue;
      }

      const started = Date.now();
      try {
        const url = `https://api.keepa.com/seller?key=${KEEPA_KEY}&domain=${domainId}&seller=${encodeURIComponent(sellerId)}&storefront=1`;
        const res = await fetch(url);
        const elapsedMs = Date.now() - started;

        if (!res.ok) {
          samples.push({ sellerId, error: `HTTP ${res.status}`, elapsedMs });
          continue;
        }

        const j = await res.json().catch(() => ({}));
        const meta = readMeta(j);
        if (!plan) plan = meta;

        const seller = j?.sellers?.[sellerId];
        const asinList: string[] = Array.isArray(seller?.asinList) ? seller.asinList : [];
        const totalStorefrontAsins = seller?.totalStorefrontAsinsCSV?.length
          ? seller.totalStorefrontAsinsCSV[seller.totalStorefrontAsinsCSV.length - 1]
          : asinList.length;

        if (!widestSeller || asinList.length > widestSeller.asins.length) {
          widestSeller = { sellerId, asins: asinList };
        }

        const prior = samples.filter((s) => typeof s.tokensLeftAfter === 'number').pop();
        const tokensLeftDelta = prior && meta.tokensLeft != null
          ? prior.tokensLeftAfter - meta.tokensLeft
          : null;

        samples.push({
          sellerId,
          sellerName: seller?.sellerName || null,
          found: !!seller,
          asinListReturned: asinList.length,
          totalStorefrontAsins,
          tokensConsumed: meta.tokensConsumed,
          tokensLeftAfter: meta.tokensLeft,
          tokensLeftDelta,
          tokensPer1000Asins: meta.tokensConsumed != null && asinList.length > 0
            ? Number(((meta.tokensConsumed / asinList.length) * 1000).toFixed(2))
            : null,
          elapsedMs,
        });
      } catch (e) {
        samples.push({ sellerId, error: (e as Error).message, elapsedMs: Date.now() - started });
      }
    }

    // Second cost driver: the bounded /product batch check-seller-watchlist
    // fires for genuinely-new ASINs. Reuses real ASINs from the widest
    // storefront above so the batch is representative.
    let productProbe: any = null;
    if (!dryRun && includeProductProbe && widestSeller && widestSeller.asins.length > 0) {
      const batch = widestSeller.asins.slice(0, PRODUCT_PROBE_ASINS);
      const slot = await acquireSlotWithRetry(admin);
      if (slot.ok) {
        const started = Date.now();
        try {
          const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=${domainId}&asin=${batch.join(',')}`;
          const res = await fetch(url);
          const elapsedMs = Date.now() - started;
          if (res.ok) {
            const j = await res.json().catch(() => ({}));
            const meta = readMeta(j);
            productProbe = {
              asinsRequested: batch.length,
              productsReturned: Array.isArray(j?.products) ? j.products.length : 0,
              tokensConsumed: meta.tokensConsumed,
              tokensLeftAfter: meta.tokensLeft,
              tokensPerAsin: meta.tokensConsumed != null && batch.length > 0
                ? Number((meta.tokensConsumed / batch.length).toFixed(3))
                : null,
              elapsedMs,
            };
          } else {
            productProbe = { error: `HTTP ${res.status}`, elapsedMs };
          }
        } catch (e) {
          productProbe = { error: (e as Error).message };
        }
      } else {
        productProbe = { skipped: true, reason: `rate gate busy, ~${slot.waitSeconds}s` };
      }
    }

    // ---- Capacity model -------------------------------------------------
    // Turns the measured per-check cost into the actual planning answer:
    // "at N sellers, how often can each one be checked?"
    //
    // Two independent ceilings apply, and the real limit is whichever binds
    // first:
    //   TOKENS -- Keepa refills refillRate tokens/min. A check costs however
    //             many tokens the samples above measured.
    //   CALLS  -- the shared gate admits KEEPA_GUARD_LIMIT calls/min no
    //             matter how cheap a call is (keepa-rate-gate.ts).
    // A cheap-but-frequent workload hits the call ceiling; an expensive one
    // hits the token ceiling.
    const measured = samples.filter((s) => typeof s.tokensConsumed === 'number');
    const avgTokensPerSeller = measured.length
      ? measured.reduce((a, s) => a + s.tokensConsumed, 0) / measured.length
      : null;
    const refillRate = plan?.refillRate ?? null; // tokens per minute

    // Overrides let the table be recomputed for a hypothetical plan or a
    // different repricer split WITHOUT spending tokens again.
    const costOverride = typeof body.costPerCheckOverride === 'number' ? body.costPerCheckOverride : null;
    const refillOverride = typeof body.refillRateOverride === 'number' ? body.refillRateOverride : null;
    // Share of the Keepa budget seller monitoring may claim. The live
    // repricer draws on the same pool, so 100% is not a safe default.
    const budgetShare = typeof body.budgetShare === 'number' ? Math.min(1, Math.max(0.01, body.budgetShare)) : 0.5;
    // Fraction of checks that find new ASINs and therefore trigger the extra
    // bounded /product batch. Most checks find nothing.
    const newListingRate = typeof body.newListingRate === 'number' ? Math.min(1, Math.max(0, body.newListingRate)) : 0.1;
    const gateCallsPerMin = typeof body.gateCallsPerMin === 'number' ? body.gateCallsPerMin : 4; // KEEPA_GUARD_LIMIT

    const sellerCounts: number[] = Array.isArray(body.sellerCounts) && body.sellerCounts.length
      ? body.sellerCounts.map((n: unknown) => Math.max(1, Math.floor(Number(n)))).filter((n: number) => Number.isFinite(n))
      : [1, 5, 10, 20, 50, 100, 200, 400, 600, 1000];

    const effectiveRefill = refillOverride ?? refillRate;
    const sellerCost = costOverride ?? avgTokensPerSeller;
    const productBatchTokens = typeof body.productBatchTokensOverride === 'number'
      ? body.productBatchTokensOverride
      : (typeof productProbe?.tokensConsumed === 'number' ? productProbe.tokensConsumed : 0);

    // A dry run has no measurements of its own, so it can only produce a
    // table if both costs are supplied. Fabricating a default here would
    // yield confident-looking numbers with nothing behind them.
    if (dryRun && (!effectiveRefill || !sellerCost)) {
      return json({
        error: 'dryRun needs {"costPerCheckOverride":<tokens>,"refillRateOverride":<tokens/min>} — copy them from a previous live run\'s capacity.assumptions.',
      }, 400);
    }

    let capacity: any = null;
    if (effectiveRefill && sellerCost) {
      // Expected cost of ONE seller check, amortizing the occasional
      // new-listing /product batch across all checks.
      const tokensPerCheck = sellerCost + newListingRate * productBatchTokens;
      const callsPerCheck = 1 + newListingRate;

      const tokenBudgetPerDay = effectiveRefill * 60 * 24 * budgetShare;
      const callBudgetPerDay = gateCallsPerMin * 60 * 24 * budgetShare;

      const rows = sellerCounts.map((n) => {
        const byTokens = tokenBudgetPerDay / (n * tokensPerCheck);
        const byCalls = callBudgetPerDay / (n * callsPerCheck);
        const checksPerDay = Math.min(byTokens, byCalls);
        const hoursBetween = checksPerDay > 0 ? 24 / checksPerDay : Infinity;
        return {
          sellers: n,
          checksPerSellerPerDay: Number(checksPerDay.toFixed(2)),
          hoursBetweenChecks: Number.isFinite(hoursBetween) ? Number(hoursBetween.toFixed(2)) : null,
          limitedBy: byTokens < byCalls ? 'keepa-tokens' : 'gate-call-rate',
          tokensPerDayUsed: Number((n * checksPerDay * tokensPerCheck).toFixed(0)),
        };
      });

      // The inverse question: for a target freshness, how many sellers fit?
      const targets = [1, 3, 6, 12, 24];
      const maxSellersForInterval = targets.map((h) => {
        const checksPerDay = 24 / h;
        const byTokens = tokenBudgetPerDay / (checksPerDay * tokensPerCheck);
        const byCalls = callBudgetPerDay / (checksPerDay * callsPerCheck);
        return {
          checkEveryHours: h,
          maxSellers: Math.floor(Math.min(byTokens, byCalls)),
          limitedBy: byTokens < byCalls ? 'keepa-tokens' : 'gate-call-rate',
        };
      });

      capacity = {
        assumptions: {
          tokensPerSellerCheck: Number(sellerCost.toFixed(2)),
          productBatchTokens,
          newListingRate,
          effectiveTokensPerCheck: Number(tokensPerCheck.toFixed(2)),
          refillRatePerMin: effectiveRefill,
          budgetShare,
          gateCallsPerMin,
          costSource: costOverride != null ? 'override' : 'measured',
        },
        budget: {
          tokensPerDayTotal: effectiveRefill * 60 * 24,
          tokensPerDayForSellerMonitoring: Math.floor(tokenBudgetPerDay),
          callsPerDayForSellerMonitoring: Math.floor(callBudgetPerDay),
        },
        table: rows,
        maxSellersForInterval,
        note: 'Ceilings assume a resumable queue that spends its whole budget. The CURRENT hourly worker skips rather than waits, so it achieves far less than this.',
      };
    }

    return json({
      ok: true,
      marketplace,
      plan,
      samples,
      productProbe,
      capacity,
    });
  } catch (e) {
    console.error('[keepa-token-probe] error', (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
