---
name: Learned Intl Fee Multipliers v1 (Phase 1+2 — collection + pending read path)
description: Nightly learner stores actual/estimated multipliers for CA/MX/BR. Read path applies them only to PENDING intl rows in Live Sales + Sales Report, gated by per-user master + per-marketplace flags. Never touches confirmed/settled/FEC/raw SP-API estimate.
type: feature
---

## What it does

Edge fn `learn-intl-fee-multipliers` runs nightly (`learn-intl-fee-multipliers-nightly` cron @ `10 6 * * *`). For each user × {CA, MX, BR} × {referral, fba, closing, total} it:

1. Pulls last 180d of `financial_events_cache` (event_type='shipment') aggregated per amazon_order_id.
2. Joins `sales_orders` for the SP-API estimate captured at ingest (`referral_fee`/`fba_fee`/`closing_fee`/`total_fees`).
3. Filters out `is_cancelled`, `fees_invalid`, `-REFUND` orders, sales < $5 USD.
4. Computes multiplier = sum(actual settled) / sum(estimated). Clamps to `[0.5, 4.0]`.
5. Upserts into `learned_fee_multipliers (user_id, marketplace, fee_component)` PK.

Confidence tiers (sample count): `<10 insufficient` (multiplier may be null), `10-29 low`, `30-99 medium`, `100+ high`.

## Phase 2 — read path (LIVE)

Helpers (keep in lock-step):
- `src/lib/sales/learnedFeeMultipliers.ts` (browser)
- `supabase/functions/_shared/learned-fee-multipliers.ts` (Deno)

The `applyLearnedFeeMultiplier({ row, rawFeesUsd, settings, multipliers })` helper multiplies a pre-computed USD fee by `total_multiplier` if and only if ALL of:

- `settings.enabled === true` AND `settings.perMarketplace[mp] === true`
- `marketplace ∈ {CA, MX, BR}`
- Row is pending: `sold_price <= 0` AND `total_sale_amount <= 0` AND `price_confidence !== 'CONFIRMED'`
- Multiplier exists with `confidence ≥ 'low'` and `total > 0`
- `rawFeesUsd > 0`

Wired into:
- `src/pages/tools/LiveSales.tsx` — fees/cost effect, per-row fee accumulation
- `supabase/functions/_shared/live-sales-core.ts` — `computeFeesUsdLikeUi` used by `refresh-live-sales-summary` (Sales Report / period totals server path)

NOT wired (intentionally):
- `MobileLiveSales.tsx` — pending rows already contribute 0 fees (feeBasisUsd = 0 for unconfirmed), so the multiplier has nothing to scale.
- `calculate-roi` edge fn — that function returns raw SP-API fees for live ASIN lookups; the user contract says we must keep the raw SP-API estimate untouched. Apply learning only at the consumption point.
- Repricer ROI floors / `asin_fee_cache` writers — repricer math stays on raw SP-API.

## Per-user settings (user_settings columns, all DEFAULT TRUE)

| Column | Purpose |
|---|---|
| `intl_learned_fees_enabled` | Master kill switch |
| `intl_learned_fees_ca` | CA on/off (547 samples, high confidence) |
| `intl_learned_fees_mx` | MX on/off (207 samples, high confidence) |
| `intl_learned_fees_br` | BR on/off (only 22 samples, separately disable-able until ≥30) |

Flip via:
```sql
UPDATE public.user_settings SET intl_learned_fees_br = false WHERE user_id = '<uid>';
```

## Hard guarantees (do NOT loosen)

The read path NEVER:
- writes back to `sales_orders.referral_fee` / `fba_fee` / `closing_fee` / `total_fees`
- writes back to `sold_price` or `total_sale_amount`
- modifies any row with `price_confidence='CONFIRMED'`
- modifies any row from FEC settlement
- touches `asin_fee_cache`
- affects the repricer

Raw SP-API estimate stays on `sales_orders` for audit/debug. When the order eventually settles, FEC fees overwrite the estimate by the existing reconcile path and the multiplier path stops applying (row is no longer pending).

## Kill switches

```sql
-- Disable for one user globally:
UPDATE public.user_settings SET intl_learned_fees_enabled = false WHERE user_id = '<uid>';

-- Disable BR only (recommended once it has new settlements until pattern re-validates):
UPDATE public.user_settings SET intl_learned_fees_br = false WHERE user_id = '<uid>';

-- Stop the learner entirely (multipliers freeze at last value):
UPDATE cron.job SET active = false WHERE jobname = 'learn-intl-fee-multipliers-nightly';

-- Nuclear (wipe all learned data; renders revert to raw SP-API):
DELETE FROM public.learned_fee_multipliers WHERE user_id = '<uid>';
```

## Initial multipliers (user 020dd71f… as of 2026-06-22)

| Mkt | total_multiplier | Confidence | Samples |
|---|---|---|---|
| CA | 1.24× | high   | 547 |
| MX | 1.21× | high   | 207 |
| BR | 1.66× | low    | 22  |

BR is enabled by default per user request because the directional gap matches manual checks; flip `intl_learned_fees_br=false` if a new settlement skews it before sample size crosses 30.
