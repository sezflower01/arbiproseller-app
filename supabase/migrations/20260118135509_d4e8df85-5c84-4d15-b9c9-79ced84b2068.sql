-- ONE-TIME REPAIR: Fix pending orders that have estimated prices "locked" in sold_price/item_price
-- This migrates the estimated value to estimated_price and clears sold_price/item_price
-- so they fall back to live inventory.price

UPDATE public.sales_orders
SET 
  -- Migrate current sold_price to estimated_price (preserve the estimate)
  estimated_price = CASE 
    WHEN estimated_price IS NULL OR estimated_price = 0 THEN sold_price 
    ELSE estimated_price 
  END,
  -- Clear the "locked" values so UI falls back to live inventory
  sold_price = 0,
  item_price = NULL,
  total_sale_amount = 0,
  -- Mark price_source as estimated
  price_source = CASE 
    WHEN price_source = 'inventory_price' THEN 'estimated:inventory'
    WHEN price_source = 'buy_box_cache' THEN 'estimated:buy_box'
    WHEN price_source = 'amazon_price' THEN 'estimated:amazon_price'
    WHEN price_source = 'order_total_pending' THEN 'estimated:order_total'
    ELSE 'estimated:migrated'
  END,
  updated_at = now()
WHERE order_status = 'Pending'
  AND sold_price > 0
  AND (
    price_source IN ('inventory_price', 'buy_box_cache', 'amazon_price', 'order_total_pending')
    OR price_calc_mode IN ('inventory_fallback', 'multi_item_inventory_fallback', 'order_total_div_qty')
  );