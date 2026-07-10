// Phase 1: Own-Buy-Box pending-price tracking (DATA CAPTURE ONLY).
//
// Given a pending order being persisted, compute the BB tracking fields
// to write alongside (NOT replacing) the existing estimated_price chain.
//
// Rules:
//   - Prefer the most-recent repricer_competitor_snapshots row for this
//     (user, asin, marketplace) that was fetched AT OR BEFORE order_date.
//   - If the closest snapshot is after the order, still record it; qualified only
//     becomes true when the absolute snapshot age is within the freshness window.
//   - Freshness window: 2 hours. Rationale: Amazon's Orders API typically
//     reveals a new order 60-120 minutes after purchase, so our order-ingest
//     capture lands ~T+88min. A 15-min rule was empirically impossible to
//     satisfy (1 / 4,270 orders over 30 days). This metric is therefore
//     labeled "Closest BB observed at order discovery", not "BB at order time".
//   - Owner match = snapshot.buybox_seller_id == seller_authorizations.seller_id
//     for (user, marketplace).
//   - Fulfillment match: AFN/FBA order ⇒ snapshot.buybox_is_fba must be true.
//     MFN/FBM order ⇒ snapshot.buybox_is_fba must be false.
//   - qualified = freshness AND ownership AND fulfillment match AND price > 0.
//
// We always populate the tracking columns (even if not qualified) so the
// 30-day accuracy report can distinguish disqualification reasons.

const MARKETPLACE_CODE_TO_ID: Record<string, string> = {
  US: "ATVPDKIKX0DER",
  CA: "A2EUQ1WTGCTBG2",
  MX: "A1AM78C64UM0Y8",
  BR: "A2Q3Y263D00KWC",
};

const FRESHNESS_WINDOW_SECONDS = 2 * 60 * 60;

export interface BbOwnEstimateFields {
  bb_estimate_price: number | null;
  bb_estimate_owner_match: boolean | null;
  bb_estimate_snapshot_age_seconds: number | null;
  bb_estimate_captured_at: string;
  bb_estimate_qualified: boolean;
  bb_estimate_marketplace: string | null;
  bb_estimate_snapshot_fetched_at: string | null;
  bb_estimate_buybox_is_fba: boolean | null;
  bb_estimate_snapshot_id: string | null;
}

// Tiny in-invocation cache so repeated lookups don't re-query.
type SellerIdCache = Map<string, string | null>; // key = `${userId}|${marketplaceCode}`

export function makeSellerIdCache(): SellerIdCache {
  return new Map();
}

function toPositiveNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function boolish(value: unknown): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

function offerTotalPrice(offer: any): number | null {
  const direct = toPositiveNumber(offer?.total_price) ?? toPositiveNumber(offer?.BuyingPrice?.LandedPrice?.Amount);
  if (direct) return direct;
  const price = toPositiveNumber(offer?.price) ?? toPositiveNumber(offer?.ListingPrice?.Amount);
  const shipping = toPositiveNumber(offer?.shipping) ?? toPositiveNumber(offer?.Shipping?.Amount) ?? 0;
  return price ? Math.round((price + shipping) * 100) / 100 : null;
}

function offerIsFba(offer: any): boolean | null {
  const explicit = boolish(offer?.is_fba ?? offer?.IsFulfilledByAmazon);
  if (explicit !== null) return explicit;
  const fulfillment = String(offer?.fulfillment ?? offer?.FulfillmentChannel ?? "").toUpperCase();
  if (fulfillment === "FBA" || fulfillment === "AFN" || fulfillment === "AMAZON") return true;
  if (fulfillment === "FBM" || fulfillment === "MFN" || fulfillment === "MERCHANT") return false;
  return null;
}

function findOwnFeaturedOffer(
  offersJson: unknown,
  ownSellerId: string | null,
  orderIsFba: boolean,
  orderIsFbm: boolean,
): { price: number; isFba: boolean } | null {
  if (!ownSellerId || !Array.isArray(offersJson)) return null;
  for (const offer of offersJson) {
    const sellerId = offer?.seller_id ?? offer?.SellerId;
    const winner = boolish(offer?.is_buybox_winner ?? offer?.IsBuyBoxWinner) === true;
    if (!winner || sellerId !== ownSellerId) continue;
    const isFba = offerIsFba(offer);
    if (isFba === null) continue;
    if ((orderIsFba && !isFba) || (orderIsFbm && isFba)) continue;
    const price = offerTotalPrice(offer);
    if (price) return { price, isFba };
  }
  return null;
}

async function getOwnSellerId(
  supabase: any,
  userId: string,
  marketplaceCode: string,
  cache: SellerIdCache,
): Promise<string | null> {
  const key = `${userId}|${marketplaceCode}`;
  if (cache.has(key)) return cache.get(key)!;
  const marketplaceId = MARKETPLACE_CODE_TO_ID[marketplaceCode];
  if (!marketplaceId) {
    cache.set(key, null);
    return null;
  }
  const { data, error } = await supabase
    .from("seller_authorizations")
    .select("seller_id")
    .eq("user_id", userId)
    .eq("marketplace_id", marketplaceId)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(`[bbOwnEstimate] seller_authorizations lookup failed for user=${userId} mkt=${marketplaceCode}: ${error.message}`);
    cache.set(key, null);
    return null;
  }
  const sellerId = data?.seller_id ?? null;
  cache.set(key, sellerId);
  return sellerId;
}

export async function computeBbOwnEstimateFields(
  supabase: any,
  params: {
    userId: string;
    asin: string;
    marketplace: string | null; // 2-letter code: US/CA/MX/BR
    orderDateIso: string; // ISO purchase timestamp
    fulfillmentChannel: string | null; // AFN | MFN | FBA | FBM
  },
  cache: SellerIdCache,
): Promise<BbOwnEstimateFields> {
  const nowIso = new Date().toISOString();
  const empty: BbOwnEstimateFields = {
    bb_estimate_price: null,
    bb_estimate_owner_match: null,
    bb_estimate_snapshot_age_seconds: null,
    bb_estimate_captured_at: nowIso,
    bb_estimate_qualified: false,
    bb_estimate_marketplace: params.marketplace ?? null,
    bb_estimate_snapshot_fetched_at: null,
    bb_estimate_buybox_is_fba: null,
    bb_estimate_snapshot_id: null,
  };

  try {
    if (!params.userId || !params.asin || !params.marketplace || !params.orderDateIso) {
      return empty;
    }
    if (!MARKETPLACE_CODE_TO_ID[params.marketplace]) {
      // Unknown marketplace — skip silently
      return empty;
    }

    const orderTime = new Date(params.orderDateIso).getTime();
    if (!Number.isFinite(orderTime)) return empty;

    // Prefer most-recent snapshot AT OR BEFORE order time.
    const { data: beforeSnap, error } = await supabase
      .from("repricer_competitor_snapshots")
      .select("id, fetched_at, buybox_price, buybox_seller_id, buybox_is_fba, offers_json")
      .eq("user_id", params.userId)
      .eq("asin", params.asin)
      .eq("marketplace", params.marketplace)
      .lte("fetched_at", params.orderDateIso)
      .order("fetched_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn(`[bbOwnEstimate] snapshot lookup failed asin=${params.asin}: ${error.message}`);
      return empty;
    }

    let snap = beforeSnap;
    let ageSec = snap
      ? Math.round((orderTime - new Date(snap.fetched_at).getTime()) / 1000)
      : Number.POSITIVE_INFINITY;

    // If the pre-order snapshot is missing/stale, compare with the nearest
    // post-order capture and keep whichever is closest to the order time.
    if (!snap || ageSec > FRESHNESS_WINDOW_SECONDS) {
      const { data: afterSnap, error: afterError } = await supabase
        .from("repricer_competitor_snapshots")
        .select("id, fetched_at, buybox_price, buybox_seller_id, buybox_is_fba, offers_json")
        .eq("user_id", params.userId)
        .eq("asin", params.asin)
        .eq("marketplace", params.marketplace)
        .gte("fetched_at", params.orderDateIso)
        .order("fetched_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (afterError) {
        console.warn(`[bbOwnEstimate] after-snapshot lookup failed asin=${params.asin}: ${afterError.message}`);
      } else if (afterSnap) {
        const afterAgeSec = Math.round((orderTime - new Date(afterSnap.fetched_at).getTime()) / 1000);
        if (!snap || Math.abs(afterAgeSec) < Math.abs(ageSec)) {
          snap = afterSnap;
          ageSec = afterAgeSec;
        }
      }
    }

    if (!snap) return empty;

    const absAgeSec = Math.abs(ageSec);

    // Fulfillment match
    const fc = (params.fulfillmentChannel ?? "").toUpperCase();
    const orderIsFba = fc === "AFN" || fc === "FBA" || fc === "AMAZON";
    const orderIsFbm = fc === "MFN" || fc === "FBM" || fc === "MERCHANT";
    const ownSellerId = await getOwnSellerId(supabase, params.userId, params.marketplace, cache);
    const ownFeaturedOffer = findOwnFeaturedOffer(snap.offers_json, ownSellerId, orderIsFba, orderIsFbm);
    const effectiveBuyboxPrice = ownFeaturedOffer?.price ?? snap.buybox_price;
    const effectiveBuyboxIsFba = ownFeaturedOffer?.isFba ?? snap.buybox_is_fba;
    const ownerMatch = !!ownFeaturedOffer || (ownSellerId !== null && snap.buybox_seller_id !== null && snap.buybox_seller_id === ownSellerId);

    let fulfillmentMatch: boolean;
    if (orderIsFba) fulfillmentMatch = effectiveBuyboxIsFba === true;
    else if (orderIsFbm) fulfillmentMatch = effectiveBuyboxIsFba === false;
    else fulfillmentMatch = false; // unknown fulfillment ⇒ disqualify

    const fresh = absAgeSec <= FRESHNESS_WINDOW_SECONDS;
    const hasPrice = typeof effectiveBuyboxPrice === "number" && effectiveBuyboxPrice > 0;
    const qualified = fresh && ownerMatch && fulfillmentMatch && hasPrice;

    return {
      // This field is labeled as Pedu/own BB in the UI. Never write a
      // different seller's Buy Box price here; keep the snapshot metadata and
      // disqualification flags for audit, but only expose price when it truly
      // qualified as our BB at the order time.
      bb_estimate_price: qualified ? Math.round(effectiveBuyboxPrice * 100) / 100 : null,
      bb_estimate_owner_match: ownerMatch,
      bb_estimate_snapshot_age_seconds: ageSec,
      bb_estimate_captured_at: nowIso,
      bb_estimate_qualified: qualified,
      bb_estimate_marketplace: params.marketplace,
      bb_estimate_snapshot_fetched_at: snap.fetched_at,
      bb_estimate_buybox_is_fba: effectiveBuyboxIsFba,
      bb_estimate_snapshot_id: snap.id,
    };
  } catch (e: any) {
    console.warn(`[bbOwnEstimate] unexpected error: ${e?.message ?? e}`);
    return empty;
  }
}
