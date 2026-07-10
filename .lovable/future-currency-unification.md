# Future: Multi-Currency / Multi-Marketplace Unification

**Status:** DEFERRED. App is US-only in practice. Hardcoded `$` / `USD` across tools is intentionally acceptable for now.
**Do not** start this project without an explicit decision to expand beyond US sellers. Doing it piecemeal will drift.

This doc exists so future-you doesn't re-audit the codebase to figure out what already works vs. what's missing.

---

## ✅ Plumbing that already exists and works

Do NOT rebuild these — wire consumers to them when the time comes.

| Concern | Where it lives | Notes |
|---|---|---|
| Resolve seller's home marketplace + currency + symbol (frontend) | `src/hooks/use-home-marketplace.ts` | Returns `{ homeMarketplace, homeCurrency, homeCurrencySymbol, isAdmin, filterMarketplaces, formatHomeCurrency }`. Reads `repricer_settings.primary_marketplace` + `home_currency`, falls back to `profiles.primary_marketplace_id`. |
| Marketplace → currency config | `src/lib/marketplaceCurrency.ts` | `MARKETPLACE_CONFIGS` covers US, CA, MX, BR, UK, DE, ES. Has `formatPrice`, `formatPriceWithUsdEquivalent`, `getSpApiEndpoint`, `convertCurrencyClient`. |
| Currency conversion (edge functions) | `supabase/functions/_shared/fx-utils.ts` | `convertCurrency(amount, from, to, supabase)` — USD-cross-rate math against `fx_rates` table. `getSellerHomeCurrency(supabase, userId)` reads `repricer_settings.home_currency`, defaults `'USD'`. |
| Sales row currency conversion | `src/lib/sales/currencyConversion.ts` | `convertNativeToUsd`, `getConfirmedSalesOrderRevenueUsd`. Guards against double-conversion. Referenced by memory `[Sales Currency Contract]`. |
| Home-currency FX in repricer engine | `supabase/functions/repricer-ai-evaluate/index.ts` ~line 5485 | Already converts unitCost from `home_currency` → marketplace currency before pricing math. |
| DB column | `repricer_settings.home_currency` | Exists. Read by engine + hook. |
| Rate table | `fx_rates` (base=USD, quote=X, rate) | Populated. Do NOT hardcode FX literals — see memory `[No Hardcoded FX]`. |

---

## ❌ Actually broken / missing (the real work)

### 1. No UI writer for `home_currency`
Nothing in `src/pages/Settings.tsx`, signup, or `CompleteProfile.tsx` ever sets `repricer_settings.home_currency`. Existing rows are `NULL` or `'USD'`. Fix path:
- Auto-derive from `primary_marketplace` on save (either DB trigger or app-side upsert).
- Backfill: `UPDATE repricer_settings SET home_currency = <derived> WHERE home_currency IS NULL`.
- Optionally add a Settings field for override.

### 2. Engine currency map is NA-only
`supabase/functions/repricer-ai-evaluate/index.ts` line ~18:
```ts
const MARKETPLACE_CURRENCIES = { US: 'USD', CA: 'CAD', MX: 'MXN', BR: 'BRL' };
```
UK, DE, ES, FR, IT, JP, AU, IN, SG, AE, SA, PL, SE, TR **silently fall back to `'USD'`**. This means an EU seller pricing against an EUR listing would compare USD cost vs EUR competitor prices — wrong.
Any other repricer edge functions that build local currency lookups should be audited the same way (`rg "MARKETPLACE_CURRENCIES|marketplaceCurrency" supabase/functions/`).

### 3. Hardcoded `$` / `USD` in UI tools
Every tool component uses literal `$` or `'USD'` rather than importing from `useHomeMarketplace` / `marketplaceCurrency.ts`. Audit command when the time comes:
```bash
rg -n "\\\$\{|'\\\$'|\"USD\"|toLocaleString.*USD" src/pages/tools src/components
```
Recommended fix: one shared `formatCurrency(amount, currency)` helper, every tool imports it, no direct `$` literals in JSX.

### 4. Cost entry currency is implicit USD
`cost_price` inputs across the app assume USD. There's no per-row currency column on inventory cost inputs. If a UK seller enters `10.00` intending GBP, it gets stored as `10.00` and later treated as USD by ROI/repricer.
Decisions needed at expansion time:
- Store cost in seller's `home_currency` only (simplest, requires FX at pricing time — engine already does this)?
- Or per-marketplace native cost columns (schema change, migration)?
Memory `[No Hardcoded FX]` locks in the "convert at write, store USD" contract for `asin_fee_cache.fba_fee_fixed`. Cost columns are a separate decision.

### 5. Fee cache coverage
`asin_fee_cache` is populated primarily for US ASINs. Non-US marketplaces have gaps — see memory `[Missing Non-US Fee Cache Warning]`. Expanding marketplaces requires fee-cache population workers for each new marketplace.

### 6. SP-API region routing
`src/lib/marketplaceCurrency.ts` has `getSpApiEndpoint` with NA/EU logic only. Adding JP/AU/IN needs FE (Far East) endpoint routing — check every edge function that hardcodes `sellingpartnerapi-na.amazon.com`.

---

## Recommended phasing (when the time comes)

1. **Phase 0 — currency-display cleanup (US-only, no marketplace expansion).** Centralize `formatCurrency`. Remove hardcoded `$` from JSX. Everything still shows USD. Zero risk. Do this first even if you never expand — it's the foundation.
2. **Phase 1 — auto-derive `home_currency`.** Add trigger/writer + backfill. US sellers still see USD (no behavior change), but the plumbing is now correct.
3. **Phase 2 — one region at a time.** Pick UK+DE+ES+FR+IT (EUR/GBP). Expand `MARKETPLACE_CURRENCIES` in engine. Verify with real orders. Populate fee cache. Only *then* open the marketplace picker for new signups.
4. **Phase 3+** — JP/AU/IN/etc. as separate projects, each with its own SP-API routing + fee-cache validation.

**Do not** open the marketplace picker for regular users before the corresponding phase is verified with real order data. Silent USD fallback in the engine is worse than "marketplace unsupported."

---

## Related memories (don't violate)

- `[Stabilization Phase]` — no new intelligence/UI surfaces. Phase 0 is permitted as cleanup; Phase 1+ needs explicit exit-from-stabilization decision.
- `[No Hardcoded FX]` — always route through `fx_rates` / `convertCurrency`. Never literal `BRL: 0.17`.
- `[Sales Currency Contract]` — mixed historical data; source-aware guards in `currencyConversion.ts`.
- `[Home Marketplace Constraints]` — non-admin users are already locked to their home marketplace at the data layer.
- `[Intl FX Logic]`, `[Intl ROI Enforcement]` — marketplace-aware FX + ROI logic already partially implemented for CA/MX/BR.

---

*Last updated: 2026-07-04. Update this doc when phases ship or when new hardcoded-currency hotspots are found.*

---

## Post-NA-unlock watch items (added 2026-07-04)

After opening CA/MX/BR to regular users:

- **FBM label fee FX (FIXED 2026-07-04):** `poll-fbm-label-costs/index.ts` now converts SP-API label cost from native currency → USD via `_shared/fx-utils.ts::convertCurrency` before writing `shipping_label_fee` (USD column). If FX is unavailable, the row is left pollable rather than corrupted. Regression test at `poll-fbm-label-costs/fx_conversion_test.ts` (MXN/CAD/BRL fixtures). Watch for `[poll] SKIP` log lines — indicates `fx_rates` gap.
- **Refund GROSS/NET on CA/MX/BR (WATCH):** `src/lib/sales/refundMath.ts` formula is currency-agnostic and `fetchCanonicalRefunds` accepts marketplace param, but the regression test `refundGrossNetDrift.test.ts` only exercises a US incident order. When the first real CA/MX/BR refund event lands, manually reconcile it against the formula before trusting silently going forward. If it drifts, add a per-marketplace fixture.
- **Promo tripwire (already armed):** `_shared/promo-tripwire.ts` emits `PROMO_NON_US_SO_DISCOUNT_DETECTED` on first non-US `promotion_discount > 0` write. First fire = do the P&L parity refactor (§12 in architecture-audit.md). Live Sales core already converts.
