---
name: Orders API Per-Unit ItemPrice Quirk
description: Amazon SP-API GetOrderItems sometimes returns ItemPrice per-unit (not line-total) on multi-qty Pending orders; sync-sales-orders detects and corrects it instead of writing a 1/qty sold_price.
type: feature
---

## Problem

Amazon SP-API `GetOrderItems` is documented to return `OrderItem.ItemPrice.Amount`
as the **line total** (qty × unit). In practice, for some multi-quantity
**Pending** orders (observed on US), Amazon returns `ItemPrice = unit price`.

Old behavior in `supabase/functions/sync-sales-orders/index.ts` (both
`enrichFromSpApiFallback` and the secondary enrichment path) did:
```
unitPrice = ItemPrice.Amount / quantity   // 22.38 / 7 = $3.20  ← wrong
sold_price = unitPrice
total_sale_amount = ItemPrice.Amount       // $22.38  ← wrong
```
Reality from Seller Central: 7 × $22.38 = **$156.66**.

The existing `SUSPICIOUS_HALF_PRICE_HOLD` guard would have caught this
(`$3.20 < 0.6 × est $22.46`), but `enrichFromSpApiFallback`'s SELECT did
not include `estimated_price`, so `refPrice = 0` and the guard was a no-op.

Confirmed case: order `114-2517244-0299440`, ASIN `B01D0BD8CM`, user
`020dd71f-78ce-4bc2-9117-dc997c533ab9`, repaired manually to
sold_price=$22.38, total=$156.66.

## Fix (both enrichment paths)

1. **SELECT must include `estimated_price` and `item_price`** in the enrichment
   loader (`enrichFromSpApiFallback`) so the reference price exists.
2. **Inverse per-unit detector** before the half-price hold:
   ```
   refPrice = max(estimated_price, item_price, sold_price)
   if qty > 1
      AND refPrice > 0
      AND rawItemPrice / qty < refPrice * 0.6
      AND rawItemPrice  ∈ [refPrice * 0.8, refPrice * 1.2]:
        // Amazon returned per-unit. Treat rawItemPrice as the unit price.
        unitPrice = rawItemPrice
        line_total = rawItemPrice * qty
        log "🔁 ORDERS_API_PER_UNIT_FIX"
   ```
3. If the unit looks suspicious but rawItemPrice does NOT match the listing
   price, the existing `SUSPICIOUS_HALF_PRICE_HOLD` still fires (stay pending
   for FEC settlement). No silent guess.

## Invariants

- Never divide `ItemPrice` by `quantity` without first comparing to a
  reference unit price (snapshot / estimated / prior item_price).
- Never write `sold_price` < 60% of reference unless we explicitly
  identified the API as returning line-total (i.e., raw ≥ refPrice × 0.6 × qty).
- Repair sweeps that touch `sold_price`/`total_sale_amount` must set
  `price_last_error = 'REPAIRED_ORDERS_API_PER_UNIT'` for audit.

## Tagging

- Per-unit corrected writes log `🔁 ORDERS_API_PER_UNIT_FIX`.
- Suspicious-without-signal writes log `🛑 SUSPICIOUS_HALF_PRICE_HOLD`.
- Repaired historical rows carry `price_last_error =
  'REPAIRED_ORDERS_API_PER_UNIT'`.
