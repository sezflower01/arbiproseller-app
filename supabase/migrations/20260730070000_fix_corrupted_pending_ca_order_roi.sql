-- The FIX_UNIT_COSTS / REFRESH_ALL_UNIT_COSTS / RECALCULATE_FEES maintenance
-- endpoints in sync-sales-orders previously computed ROI using sold_price
-- directly with no currency awareness. For at least one CA order
-- (702-5604770-7531434, ASIN B07VSNBTSH) this left a stale roi=127.3 on the
-- row from a pass where sold_price transiently held the native CAD amount
-- (26.79) treated as if it were already USD. The order is still Pending
-- (sold_price=0), so per the existing insert-time convention ("ROI will be
-- calculated elsewhere based on roi_source"), roi should be 0 until
-- settlement, not a stale corrupted value. The code path itself is now fixed
-- (see supabase/functions/_shared/salesCurrencyGuard.ts); this just repairs
-- the one row already affected.
update sales_orders
set roi = 0
where order_id = '702-5604770-7531434'
  and asin = 'B07VSNBTSH'
  and status = 'pending'
  and sold_price = 0
  and roi = 127.3;
