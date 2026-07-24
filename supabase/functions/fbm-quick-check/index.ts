import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { requireInternalCall } from '../_shared/require-internal.ts';
import { exchangeLwaToken } from '../_shared/lwa-token.ts';
import { getSpApiEndpoint, signRequest } from '../_shared/sp-api-sigv4.ts';

// Fast FBM onboarding check.
//
// FBM quantity normally only refreshes every 4h, because the only way to get
// it in bulk is Amazon's GET_MERCHANT_LISTINGS_ALL_DATA report — a whole-
// catalog async report that takes minutes to generate (see sync-fbm-cleanup).
// That's fine for keeping existing listings current, but it means a seller
// who just added units to a formerly-zero FBM listing in Seller Central could
// wait up to 4 hours before the repricer notices.
//
// This function closes that gap cheaply: instead of re-requesting the heavy
// report, it calls the Listings Items API per-SKU (includedData=
// fulfillmentAvailability) — but ONLY for FBM listings we already know are at
// zero. That candidate set is small (not-yet-active listings), so the whole
// check is fast and light enough to run every few minutes.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

const MARKETPLACE_ID_MAP: Record<string, string> = {
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',
};

const CANDIDATE_LIMIT = 50;
const PER_CALL_DELAY_MS = 300;

function extractFbmQuantity(listingData: any): number | null {
  const avail = Array.isArray(listingData?.fulfillmentAvailability) ? listingData.fulfillmentAvailability : [];
  for (const entry of avail) {
    const q = Number(entry?.quantity);
    if (Number.isFinite(q)) return q;
  }
  return null;
}

async function fetchLiveFbmQuantity(params: {
  accessToken: string;
  sellerId: string;
  sku: string;
  marketplaceId: string;
}): Promise<number | null> {
  const { accessToken, sellerId, sku, marketplaceId } = params;
  const endpoint = getSpApiEndpoint(marketplaceId);
  const path = `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`;
  const url = `${endpoint}${path}?marketplaceIds=${marketplaceId}&includedData=fulfillmentAvailability`;
  const headers = await signRequest('GET', url, '', accessToken);
  const response = await fetch(url, { method: 'GET', headers: { ...headers, 'Content-Type': 'application/json' } });
  const text = await response.text();
  if (!response.ok) {
    console.warn(`[fbm-quick-check] Live quantity fetch failed SKU=${sku}: ${response.status} ${text.slice(0, 200)}`);
    return null;
  }
  return extractFbmQuantity(JSON.parse(text));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const forbidden = requireInternalCall(req);
  if (forbidden) return forbidden;

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const body = await req.json().catch(() => ({}));
    const userId = body.user_id as string;
    const marketplace = (body.marketplace || 'US') as string;
    if (!userId) {
      return new Response(JSON.stringify({ ok: false, error: 'user_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const marketplaceId = MARKETPLACE_ID_MAP[marketplace] || MARKETPLACE_ID_MAP.US;

    // Candidates: FBM listings we currently believe are out of stock. Anything
    // already showing available>0 is already onboarded via the normal path.
    const { data: candidates, error: candErr } = await supabase
      .from('inventory')
      .select('id, asin, sku, available')
      .eq('user_id', userId)
      .eq('source', 'amazon_sync_fbm')
      .or('available.is.null,available.eq.0')
      .not('listing_status', 'in', '(DELETED,NOT_IN_CATALOG,INCOMPLETE)')
      .limit(CANDIDATE_LIMIT);

    if (candErr) throw candErr;
    if (!candidates || candidates.length === 0) {
      return new Response(JSON.stringify({ ok: true, checked: 0, found_stock: 0, activated: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: sellerAuthRows } = await supabase
      .from('seller_authorizations')
      .select('seller_id, marketplace_id, refresh_token')
      .eq('user_id', userId);

    const sellerAuth = (sellerAuthRows || []).find((a: any) => a.marketplace_id === marketplaceId)
      || (sellerAuthRows || [])[0]
      || null;

    if (!sellerAuth?.refresh_token) {
      return new Response(JSON.stringify({ ok: true, checked: 0, found_stock: 0, activated: 0, skipped: 'no_seller_auth' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const accessToken = await exchangeLwaToken(sellerAuth.refresh_token, supabase, userId);

    let checked = 0;
    const nowStocked: Array<{ id: string; qty: number }> = [];

    for (const item of candidates) {
      checked++;
      try {
        const qty = await fetchLiveFbmQuantity({
          accessToken,
          sellerId: sellerAuth.seller_id,
          sku: item.sku,
          marketplaceId,
        });
        if (qty != null && qty > 0) {
          nowStocked.push({ id: item.id, qty });
        }
      } catch (e: any) {
        console.warn(`[fbm-quick-check] SKU=${item.sku} check failed: ${e?.message || e}`);
      }
      await new Promise(r => setTimeout(r, PER_CALL_DELAY_MS));
    }

    if (nowStocked.length > 0) {
      for (const row of nowStocked) {
        await supabase
          .from('inventory')
          .update({ available: row.qty, last_inventory_sync_at: new Date().toISOString() })
          .eq('id', row.id);
      }

      // Reuse the same onboarding path everything else uses — creates/enables
      // the repricer assignment, computes min/max, raises price to floor.
      let activated = 0;
      try {
        const assignResp = await fetch(`${supabaseUrl}/functions/v1/auto-assign-bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` },
          body: JSON.stringify({ user_id: userId, marketplace }),
        });
        if (assignResp.ok) {
          const assignData = await assignResp.json();
          activated = Number(assignData.created || 0) + Number(assignData.reenabled || 0);
        } else {
          console.warn(`[fbm-quick-check] auto-assign-bulk returned ${assignResp.status}: ${await assignResp.text()}`);
        }
      } catch (e: any) {
        console.warn('[fbm-quick-check] auto-assign-bulk call failed:', e?.message || e);
      }

      return new Response(JSON.stringify({ ok: true, checked, found_stock: nowStocked.length, activated }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true, checked, found_stock: 0, activated: 0 }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('[fbm-quick-check] Error:', e);
    return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
