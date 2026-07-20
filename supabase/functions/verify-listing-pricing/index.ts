import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { z } from 'https://esm.sh/zod@3.23.8';
import { signRequest, getLWAAccessToken, getSpApiEndpoint } from '../_shared/sp-api-sigv4.ts';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

const BodySchema = z.object({
  asin: z.string().min(1).max(32).optional().nullable(),
  sku: z.string().min(1).max(255),
  marketplace: z.enum(['US', 'CA', 'MX', 'BR']).default('US'),
});

const MARKETPLACE_IDS: Record<string, string> = {
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',
};

function firstScheduleValue(value: any): number | null {
  const raw = value?.[0]?.schedule?.[0]?.value_with_tax ?? value?.[0]?.schedule?.[0]?.value;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parsePricing(body: any, marketplaceId: string) {
  const purchasableOffers = Array.isArray(body?.attributes?.purchasable_offer)
    ? body.attributes.purchasable_offer
    : [];
  const offer = purchasableOffers.find((po: any) => po?.marketplace_id === marketplaceId) ?? purchasableOffers[0] ?? null;

  return {
    price: firstScheduleValue(offer?.our_price),
    min: firstScheduleValue(offer?.minimum_seller_allowed_price),
    max: firstScheduleValue(offer?.maximum_seller_allowed_price),
    currency: offer?.currency ?? null,
  };
}

function issueActions(issue: any): string[] {
  return (issue?.enforcements?.actions || []).map((a: any) => String(a?.action || '')).filter(Boolean);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ success: false, error: 'Missing authorization' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return new Response(JSON.stringify({ success: false, error: parsed.error.flatten().fieldErrors }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { asin, sku, marketplace } = parsed.data;
    const marketplaceId = MARKETPLACE_IDS[marketplace];

    const { data: authRows, error: authError } = await supabase
      .from('seller_authorizations')
      .select('refresh_token, marketplace_id, seller_id, selling_partner_id, is_active')
      .eq('user_id', user.id);

    if (authError) throw authError;

    const activeAuths = (authRows || []).filter((a: any) => a.is_active !== false && a.refresh_token);
    let sellerAuth = activeAuths.find((a: any) => a.marketplace_id === marketplaceId);

    if (!sellerAuth && activeAuths.length > 0) {
      const sellerId = activeAuths[0].seller_id || activeAuths[0].selling_partner_id;
      const { data: fallbackAuth } = await supabase
        .from('seller_authorizations')
        .select('refresh_token, marketplace_id, seller_id, selling_partner_id, is_active')
        .eq('seller_id', sellerId)
        .eq('marketplace_id', marketplaceId)
        .maybeSingle();
      if (fallbackAuth?.is_active !== false) sellerAuth = fallbackAuth;
    }

    if (!sellerAuth) {
      return new Response(JSON.stringify({ success: false, error: `No Amazon authorization found for ${marketplace}` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const sellerId = sellerAuth.seller_id || sellerAuth.selling_partner_id;
    if (!sellerId) throw new Error('Amazon seller id is missing');

    const accessToken = await getLWAAccessToken(sellerAuth.refresh_token);
    const endpoint = getSpApiEndpoint(marketplaceId);
    const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;
    const query = new URLSearchParams({
      marketplaceIds: marketplaceId,
      includedData: 'summaries,issues,attributes',
      issueLocale: 'en_US',
    }).toString();
    const url = `${endpoint}${path}?${query}`;
    const signedHeaders = await signRequest('GET', url, '', accessToken);

    const response = await fetch(url, { method: 'GET', headers: signedHeaders });
    const text = await response.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 1000) };
    }

    const issues = Array.isArray(body?.issues) ? body.issues : [];
    const pricingIssues = issues.filter((issue: any) => {
      const categories = Array.isArray(issue?.categories) ? issue.categories : [];
      const message = String(issue?.message || '').toLowerCase();
      return categories.includes('INVALID_PRICE') || message.includes('price') || message.includes('pricing');
    });
    const isPricingSuppressed = pricingIssues.some((issue: any) => {
      const severity = String(issue?.severity || '').toUpperCase();
      return severity === 'ERROR' && issueActions(issue).includes('LISTING_SUPPRESSED');
    });

    // This is a live, user-triggered check (the "Reactivate" button). Before
    // this fix it was purely read-only -- even a confirmed clean read never
    // touched repricer_assignments, so a listing the user actually fixed
    // stayed stuck showing "Suppressed" until someone separately ran
    // detect-pricing-suppressions (which only runs when a user clicks
    // "Check now" on the suppressions panel, not from here). Feed a clean
    // read into the SAME two-strike clear state machine detect-pricing-
    // suppressions uses, so Reactivate can actually progress/finish clearing
    // the flag instead of being purely informational.
    if (response.ok && !isPricingSuppressed) {
      try {
        const { data: assignment } = await supabase
          .from('repricer_assignments')
          .select('id, is_pricing_suppression, pricing_suppression_pending_clear_at, pricing_suppression_detected_at, pricing_suppression_raw_code, pricing_suppression_raw_message, pricing_suppression_categories, pricing_suppression_enforcement_actions, pricing_suppression_severity')
          .eq('user_id', user.id)
          .eq('sku', sku)
          .eq('marketplace', marketplace)
          .maybeSingle();

        if (assignment?.is_pricing_suppression) {
          if (!assignment.pricing_suppression_pending_clear_at) {
            await supabase.from('repricer_assignments').update({
              pricing_suppression_pending_clear_at: new Date().toISOString(),
              pricing_suppression_last_checked_at: new Date().toISOString(),
            }).eq('id', assignment.id);
          } else {
            const clearedAt = new Date().toISOString();
            await supabase.from('repricer_pricing_suppression_history').insert({
              user_id: user.id,
              sku,
              asin: asin ?? null,
              marketplace,
              raw_code: assignment.pricing_suppression_raw_code,
              raw_message: assignment.pricing_suppression_raw_message,
              categories: assignment.pricing_suppression_categories,
              enforcement_actions: assignment.pricing_suppression_enforcement_actions,
              severity: assignment.pricing_suppression_severity,
              was_pricing_suppression: true,
              detected_at: assignment.pricing_suppression_detected_at || clearedAt,
              cleared_at: clearedAt,
            });
            await supabase.from('repricer_assignments').update({
              is_pricing_suppression: false,
              pricing_suppression_raw_code: null,
              pricing_suppression_raw_message: null,
              pricing_suppression_categories: null,
              pricing_suppression_enforcement_actions: null,
              pricing_suppression_severity: null,
              pricing_suppression_detected_at: null,
              pricing_suppression_cleared_at: clearedAt,
              pricing_suppression_pending_clear_at: null,
              pricing_suppression_last_checked_at: clearedAt,
            }).eq('id', assignment.id);
          }
        }
      } catch (clearErr: any) {
        console.error('[verify-listing-pricing] clear-state update failed:', clearErr?.message || clearErr);
        // Non-fatal -- the live verification result below is still returned;
        // nightly detection will pick up the clear on its next pass either way.
      }
    }

    return new Response(JSON.stringify({
      success: response.ok,
      httpStatus: response.status,
      asin: asin ?? body?.asin ?? null,
      sku,
      marketplace,
      marketplaceId,
      checkedAt: new Date().toISOString(),
      summariesCount: Array.isArray(body?.summaries) ? body.summaries.length : 0,
      pricing: parsePricing(body, marketplaceId),
      issues,
      pricingIssues,
      isPricingSuppressed,
      error: response.ok ? null : (body?.errors || body),
    }), {
      status: response.ok ? 200 : response.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[verify-listing-pricing] Error:', error?.message || error);
    return new Response(JSON.stringify({ success: false, error: error?.message || 'Verification failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});