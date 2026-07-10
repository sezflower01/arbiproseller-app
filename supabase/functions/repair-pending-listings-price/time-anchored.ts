// Shared helpers for repair-pending-listings-price.
//
// Extracted so the unit test can import the REAL implementations instead of
// keeping an inline copy that silently drifts. Do not add any Deno.serve or
// top-level side effects to this file — it must be importable from a test.

export const TIME_ANCHORED_SOURCES = new Set([
  'seller_derived:repricer_action',
  'seller_derived:snapshot',
  'seller_derived:recent_sale',
]);

export function isAlreadyTimeAnchored(row: {
  price_source?: string | null;
  estimated_price?: number | string | null;
  price_confidence?: string | null;
}): boolean {
  const ps = String(row.price_source || '').toLowerCase();
  return (
    TIME_ANCHORED_SOURCES.has(ps) &&
    Number(row.estimated_price || 0) > 0 &&
    String(row.price_confidence || '') === 'HIGH_CONFIDENCE_PENDING'
  );
}

// Tier A + Tier B resolver. Returns null when neither tier has a value
// ≤ purchase_ts; caller then falls through to Tier C (Listings API "now").
export async function resolveTimeAnchoredPrice(
  supabase: any,
  row: {
    user_id: string;
    order_id: string;
    asin: string;
    marketplace: string;
    purchase_timestamp_utc: string | null;
  },
): Promise<{ price: number; source: string; calc_mode: string; anchored_at: string } | null> {
  const purchaseTs = row.purchase_timestamp_utc;
  if (!purchaseTs) return null; // caller is responsible for backfilling first

  // Tier A: latest successful repricer action ≤ purchase_ts.
  if (row.asin && row.asin !== 'UNKNOWN' && row.asin !== 'PENDING') {
    const { data: rpa } = await supabase
      .from('repricer_price_actions')
      .select('new_price, amazon_accepted_price, created_at')
      .eq('user_id', row.user_id)
      .eq('asin', row.asin)
      .eq('marketplace', row.marketplace || 'US')
      .eq('success', true)
      .lte('created_at', purchaseTs)
      .not('new_price', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const px = Number(rpa?.amazon_accepted_price || rpa?.new_price || 0);
    if (px > 0) {
      return {
        price: px,
        source: 'seller_derived:repricer_action',
        calc_mode: 'seller_derived_repricer',
        anchored_at: rpa.created_at,
      };
    }
  }

  // Tier B: order_price_snapshots frozen at discovery.
  const { data: snap } = await supabase
    .from('order_price_snapshots')
    .select('snapshot_item_price, captured_at')
    .eq('user_id', row.user_id)
    .eq('order_id', row.order_id)
    .eq('asin', row.asin)
    .gt('snapshot_item_price', 0)
    .order('captured_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (snap?.snapshot_item_price && Number(snap.snapshot_item_price) > 0) {
    return {
      price: Number(snap.snapshot_item_price),
      source: 'seller_derived:snapshot',
      calc_mode: 'seller_derived_snapshot',
      anchored_at: snap.captured_at,
    };
  }

  return null;
}
