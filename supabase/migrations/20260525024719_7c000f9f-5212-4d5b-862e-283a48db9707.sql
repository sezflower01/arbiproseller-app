
-- Fix the bad snapshot ($47 from Keepa hint) for today's pending order
UPDATE public.order_price_snapshots
SET snapshot_item_price = 53,
    snapshot_price = 53,
    snapshot_source = 'inventory',
    inventory_price_at_capture = 53,
    captured_at = now()
WHERE order_id = '113-0499634-8103462'
  AND asin = 'B0BVQ7M886'
  AND snapshot_item_price = 47;

-- Reset the corresponding sales_orders row so resync rehydrates from the corrected snapshot
UPDATE public.sales_orders
SET estimated_price = 53,
    price_confidence = 'HIGH_CONFIDENCE_PENDING',
    needs_price_enrich = true
WHERE order_id = '113-0499634-8103462'
  AND asin = 'B0BVQ7M886'
  AND (sold_price IS NULL OR sold_price = 0);
