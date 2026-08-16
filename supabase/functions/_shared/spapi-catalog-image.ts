// Fetch an ASIN's title and main image from SP-API Catalog Items.
//
// WHY THIS EXISTS: Keepa is the primary source for new-listing metadata, but a
// brand-new listing is exactly when Keepa's record is thinnest -- confirmed
// live 2026-08-15, a new-listing row came back with a title and no imagesCSV,
// so the UI showed a placeholder icon. SP-API's catalog is Amazon's own data
// and has the image immediately.
//
// The decisive advantage is quota: SP-API is a COMPLETELY SEPARATE budget from
// Keepa. Catalog lookups here cost zero Keepa tokens, so they cannot slow the
// seller-watch rotation or starve the repricer, which is the constraint every
// other part of this feature is built around.
//
// Modelled on enrich-missing-titles, which already does exactly this
// (includedData=summaries,images, MAIN variant). That function is left
// untouched: it is live, and refactoring it is not the job of a change whose
// purpose is elsewhere. Its inline copy and this module should stay in step.
//
// Uses the UNSIGNED call style of listing-validation-worker -- just
// x-amz-access-token, no AWS SigV4. Amazon dropped the SigV4 requirement for
// SP-API, and the older signed helpers in this repo predate that.
import { exchangeLwaToken } from './lwa-token.ts';
import { waitForApiToken } from './rate-limiter.ts';
import { MARKETPLACE_META } from './marketplace-map.ts';

export interface CatalogItemDetails {
  title: string | null;
  image: string | null;
}

const SPAPI_HOSTS: Record<string, string> = {
  US: 'sellingpartnerapi-na.amazon.com',
  CA: 'sellingpartnerapi-na.amazon.com',
  MX: 'sellingpartnerapi-na.amazon.com',
  BR: 'sellingpartnerapi-na.amazon.com',
  UK: 'sellingpartnerapi-eu.amazon.com',
  DE: 'sellingpartnerapi-eu.amazon.com',
  FR: 'sellingpartnerapi-eu.amazon.com',
  IT: 'sellingpartnerapi-eu.amazon.com',
  ES: 'sellingpartnerapi-eu.amazon.com',
  NL: 'sellingpartnerapi-eu.amazon.com',
  SE: 'sellingpartnerapi-eu.amazon.com',
  PL: 'sellingpartnerapi-eu.amazon.com',
  BE: 'sellingpartnerapi-eu.amazon.com',
  TR: 'sellingpartnerapi-eu.amazon.com',
  JP: 'sellingpartnerapi-fe.amazon.com',
  IN: 'sellingpartnerapi-fe.amazon.com',
};

/**
 * Resolve an access token for this user + marketplace.
 *
 * Prefers the user's own authorization for that marketplace, matching
 * create-amazon-listing, and falls back to the shared token. Returns null
 * rather than throwing -- an absent image must never fail the caller's real
 * work.
 */
export async function getCatalogAccessToken(
  supabase: any,
  userId: string,
  marketplaceCode: string,
): Promise<string | null> {
  try {
    const marketplaceId = MARKETPLACE_META[marketplaceCode]?.amazonMarketplaceId;
    if (!marketplaceId) return null;

    const { data: auth } = await supabase
      .from('seller_authorizations')
      .select('refresh_token')
      .eq('user_id', userId)
      .eq('marketplace_id', marketplaceId)
      .eq('is_active', true)
      .maybeSingle();

    const refreshToken = auth?.refresh_token || Deno.env.get('SPAPI_REFRESH_TOKEN');
    if (!refreshToken) return null;

    return await exchangeLwaToken(refreshToken, supabase, userId);
  } catch (e) {
    console.warn('[spapi-catalog-image] token exchange failed:', (e as Error).message);
    return null;
  }
}

/**
 * Look up one ASIN's title and MAIN image.
 *
 * Catalog Items has no batch form for this shape, so callers should bound how
 * many ASINs they resolve per run. Rate limited through the shared
 * 'catalog_api' bucket so it cannot outrun Amazon's quota or collide with the
 * other catalog callers in this project.
 */
export async function fetchCatalogItemDetails(
  supabase: any,
  accessToken: string,
  asin: string,
  marketplaceCode: string,
): Promise<CatalogItemDetails> {
  const empty: CatalogItemDetails = { title: null, image: null };
  try {
    const marketplaceId = MARKETPLACE_META[marketplaceCode]?.amazonMarketplaceId;
    const host = SPAPI_HOSTS[marketplaceCode];
    if (!marketplaceId || !host) return empty;

    await waitForApiToken(supabase, 'catalog_api');

    const url = new URL(`https://${host}/catalog/2022-04-01/items/${encodeURIComponent(asin)}`);
    url.searchParams.set('marketplaceIds', marketplaceId);
    url.searchParams.set('includedData', 'summaries,images');

    const res = await fetch(url.toString(), {
      headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      // 404 simply means Amazon has no catalog record to offer -- not worth
      // a warning, unlike a throttle or auth failure.
      if (res.status !== 404) {
        console.warn(`[spapi-catalog-image] ${asin} HTTP ${res.status}`);
      }
      return empty;
    }

    const json = await res.json().catch(() => null);
    if (!json) return empty;

    const summaries = json?.summaries || [];
    const summary = summaries.find((s: any) => s.marketplaceId === marketplaceId) || summaries[0];

    const imageGroups = json?.images || [];
    const group = imageGroups.find((g: any) => g.marketplaceId === marketplaceId) || imageGroups[0];
    let image: string | null = null;
    if (group?.images?.length) {
      const main = group.images.find((i: any) => i.variant === 'MAIN') || group.images[0];
      image = main?.link || null;
    }

    return { title: summary?.itemName || null, image };
  } catch (e) {
    console.warn(`[spapi-catalog-image] ${asin} failed:`, (e as Error).message);
    return empty;
  }
}
