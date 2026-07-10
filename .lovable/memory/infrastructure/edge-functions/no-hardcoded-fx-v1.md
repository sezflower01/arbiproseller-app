---
name: No Hardcoded FX in Edge Functions
description: All non-USD fee/price math in edge functions MUST go through fx_rates / convertCurrency / FX_RATES_CACHE. Never write native-currency amounts into USD columns. asin_fee_cache.fba_fee_fixed is USD.
type: constraint
---
**Rule:** Any edge function that reads SP-API fees, prices, or financial amounts in a non-USD marketplace MUST convert to USD before writing to a USD column (sales_orders.referral_fee/fba_fee/total_fees, asin_fee_cache.fba_fee_fixed, etc.).

**Past offenders (all fixed):**
- `sync-sales-orders/index.ts` — was multiplying native price × referral rate into USD column (BR R$134.71 × 12% → "$16.17"). Fixed 2026-06-22 by FX-normalizing `effectivePrice` / `orderPrice` first.
- `calculate-roi/index.ts` — was upserting `productData.fees.fbaFee` (local) directly into `asin_fee_cache.fba_fee_fixed` (USD). Fixed 2026-06-22 with `convertCurrency(local→USD)` before upsert; skips upsert if FX missing.

**How to apply:** Before writing fees/prices for BR/MX/CA/EU into any "USD" column or cache, call `convertCurrency(amount, marketplaceCurrency, 'USD', supabase)` or divide by `FX_RATES_CACHE[ccy]`. Refuse to write (skip + warn) if FX is unavailable — never fall back to storing native as USD.

**Cache contract reminder:** `asin_fee_cache.fba_fee_fixed` is USD; `referral_rate` is currency-neutral (fraction). All writers must respect this.
