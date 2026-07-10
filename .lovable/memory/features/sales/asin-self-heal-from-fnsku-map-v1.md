---
name: ASIN Self-Heal from fnsku_map
description: sync-sales-orders auto-corrects sales_orders.asin when it disagrees with the seller's fnsku_map (SKU→ASIN); prevents wrong title/image in Live Sales
type: feature
---

# Problem
Amazon's Orders API occasionally returns a stale/variation ASIN for a SellerSKU (e.g. seller relisted the SKU under a new ASIN). The order gets written with the wrong ASIN, then the wrong title/image surfaces in Live Sales.

# Contract
- SQL function `public.repair_sales_orders_asin_for_user(p_user_id uuid, p_days int)` is the single source of truth.
- For each recent `sales_orders` row with a `sku`, it joins `fnsku_map` via `user_spapi_credentials.seller_id` and rewrites `asin` (and `title`/`image_url` from inventory) when fnsku_map disagrees.
- On unique-violation (a correct-ASIN sibling row already exists), the wrong-ASIN row is deleted (treated as ghost duplicate).
- `sync-sales-orders` calls the RPC at two points:
  1. End of REFRESH_PENDING handler (`p_days=30`)
  2. End of historical sync (`p_days=60`)

# Do not
- Do not trust Amazon Orders API ASIN over fnsku_map when both exist for the same SKU.
- Do not remove the self-heal call from sync-sales-orders.
- Do not hard-delete rows outside the unique-violation branch.
