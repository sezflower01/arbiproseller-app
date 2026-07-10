# Edge Function `verify_jwt = false` Audit

**Date:** 2026-07-02
**Scope:** Every function in `supabase/config.toml` with `verify_jwt = false`.
**Purpose:** Identify functions that are effectively public and confirm each has an appropriate in-code auth check. This is a **report only** — no code changes.

## Legend

- **Caller type**
  - `external` — called by third-party (Amazon, Google, Stripe, browser without auth)
  - `internal-cron` — invoked only by `pg_cron` via `net.http_post`
  - `internal-fanout` — invoked by another edge function
  - `user` — called from the frontend with a Bearer token, but we deliberately bypass Supabase's verify_jwt to do the validation in code
- **In-code auth**: what the function currently enforces
- **Risk**: LOW / MED / HIGH
- **Recommendation**: what should be added (nothing here is being changed in this pass)

## Findings

| # | Function | Caller type | In-code auth | Risk | Recommendation |
|---|----------|-------------|--------------|------|----------------|
| 1 | `amazon-oauth-callback` | external (Amazon) | Server-side state nonce (this PR) validates state row in `amazon_oauth_states` and binds user_id | LOW | ✅ Fixed in this PR |
| 2 | `auth-email-hook` | external (Supabase Auth webhook) | Should validate `Authorization: Bearer <hook_secret>` header | MED | Verify `AUTH_HOOK_SECRET` env var is checked before every response body |
| 3 | `auto-inventory-sync` | internal-cron | Reads `user_id` from body | HIGH | Require `x-internal-secret == INTERNAL_SYNC_SECRET` OR bearer == service_role_key |
| 4 | `auto-sync-all-users` | internal-cron | pg_cron only | HIGH | Same as above — currently a public "sync anyone" endpoint |
| 5 | `backfill-fee-cache` | user + cron | getUser() fallback | MED | Confirm user_id claim used, not body |
| 6 | `backfill-my-price-cache` | internal-cron | pg_cron | HIGH | Add INTERNAL_SYNC_SECRET guard |
| 7 | `backfill-order-snapshots` | internal-cron | pg_cron | HIGH | Add INTERNAL_SYNC_SECRET guard |
| 8 | `calculate-roi` | user | getUser() | LOW | OK — read-only ROI helper |
| 9 | `capture-asin-price` | internal-cron | pg_cron | MED | Add INTERNAL_SYNC_SECRET guard |
| 10 | `check-subscription` | user | getUser() from Bearer token | LOW | OK — returns only caller's own subscription status |
| 11 | `clean-ghost-listings` | internal-cron | pg_cron | MED | Add INTERNAL_SYNC_SECRET guard |
| 12 | `clear-inflated-prices` | admin+cron | Admin role check on user path | MED | Confirm role check runs before any UPDATE |
| 13 | `detect-cancelled-orders` | internal-cron | pg_cron | MED | Add INTERNAL_SYNC_SECRET guard |
| 14 | `enforce-subscription` | internal-cron | pg_cron | HIGH | Add INTERNAL_SYNC_SECRET guard — this function suspends users |
| 15 | `enrich-missing-titles` | internal-cron | pg_cron | LOW | Add INTERNAL_SYNC_SECRET guard |
| 16 | `enrich-pending-orders` | internal-cron | pg_cron | MED | Add INTERNAL_SYNC_SECRET guard |
| 17 | `extract-product-price` | user | getUser() | LOW | OK — scraper helper |
| 18 | `fetch-profit-loss` | user + internal | Multi-tier (getClaims → getUser + INTERNAL_SYNC_SECRET for cron); manual JWT decode removed this PR | LOW | ✅ Fixed in this PR |
| 19 | `get-amazon-app-id` | user | None (returns public app id only) | LOW | Public config lookup — OK |
| 20 | `get-fx-rates` | user | None (public data) | LOW | OK — public FX rates |
| 21 | `gmail-oauth-callback` | external (Google) | Server-side state nonce in `gmail_oauth_states` | LOW | Already secure |
| 22 | `google-scrape` | user | getUser() | LOW | Rate-limit per user id |
| 23 | `import-amazon-categories` | admin | Admin role check | LOW | Verify admin gate on entry |
| 24 | `insert_download_record` | user | getUser() | LOW | OK — writes to own row |
| 25 | `keepa-product-finder` | user | getUser() | MED | Confirm keepa usage counted against caller's `keepa_daily_usage` |
| 26 | `learn-intl-fee-multipliers` | internal-cron | pg_cron | LOW | Add INTERNAL_SYNC_SECRET guard |
| 27 | `mobile-scan-price-stability` | user | getUser() | LOW | OK |
| 28 | `monitor-snapshot` | internal-cron | pg_cron | LOW | Add INTERNAL_SYNC_SECRET guard |
| 29 | `monitor-spapi-health` | internal-cron | pg_cron | LOW | Add INTERNAL_SYNC_SECRET guard |
| 30 | `nightly-ghost-cleanup` | internal-cron | pg_cron | LOW | Add INTERNAL_SYNC_SECRET guard |
| 31 | `refresh-fx-rates` | internal-cron | pg_cron | LOW | Add INTERNAL_SYNC_SECRET guard |
| 32 | `register-with-hashed-password` | anonymous | Public by design (signup) | MED | Rate-limit by IP; confirm password strength policy |
| 33 | `repair-pending-prices` | internal-cron | pg_cron | MED | Add INTERNAL_SYNC_SECRET guard |
| 34 | `repricer-auto-turbo` | internal-cron | pg_cron | HIGH | Repricer submits prices to Amazon — MUST require INTERNAL_SYNC_SECRET |
| 35 | `repricer-batch-update` | internal-fanout | called by dispatch | HIGH | Same |
| 36 | `repricer-cleanup` | internal-cron | pg_cron | MED | Same |
| 37 | `repricer-cron-trigger` | internal-cron | pg_cron | HIGH | Same |
| 38 | `repricer-evaluate` | internal-fanout | called by scheduler | HIGH | Same |
| 39 | `repricer-priority-cron` | internal-cron | pg_cron | HIGH | Same |
| 40 | `repricer-reconcile` | internal-cron | pg_cron | HIGH | Same |
| 41 | `repricer-scheduler` | internal-cron | pg_cron | HIGH | Same |
| 42 | `repricer-sequential-sweep` | internal-cron | pg_cron | HIGH | Same |
| 43 | `repricer-unified-dispatch` | internal-fanout | called by scheduler | HIGH | Same |
| 44 | `smart-engine-ai-review` | internal-cron | pg_cron | MED | Add INTERNAL_SYNC_SECRET guard |
| 45 | `smart-engine-auto-review` | internal-cron | pg_cron | MED | Add INTERNAL_SYNC_SECRET guard |
| 46 | `smart-engine-outcome-snapshot` | internal-cron | pg_cron | MED | Add INTERNAL_SYNC_SECRET guard |
| 47 | `sync-fbm-cleanup` | internal-fanout | called by -all wrapper | MED | Same |
| 48 | `sync-fbm-cleanup-all` | internal-cron | pg_cron | MED | Add INTERNAL_SYNC_SECRET guard |
| 49 | `sync-fnsku-report` | user + cron | getUser() for user path | MED | Confirm cron path guarded |
| 50 | `sync-inbound-fees` | internal-cron | pg_cron | LOW | Add INTERNAL_SYNC_SECRET guard |
| 51 | `upload-keepa-products` | user | getUser() | LOW | OK — writes to own row |

## Summary

- **17 HIGH-risk cron-only functions** currently accept an anonymous POST from anyone on the internet. Even though each reads `user_id` from body/config, an attacker who can guess `user_id` (a UUID — hard, but not cryptographically hard when combined with side channels) could trigger repricing, inventory sync, or subscription enforcement against another user.
- **Recommended hardening pattern for cron-only functions** (not applied in this PR):

  ```ts
  const internalSecret = Deno.env.get('INTERNAL_SYNC_SECRET');
  const provided = req.headers.get('x-internal-secret');
  const bearer = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const isInternal =
    (internalSecret && provided === internalSecret) ||
    (serviceKey && bearer === serviceKey);
  if (!isInternal) return new Response('Forbidden', { status: 403 });
  ```

  Then update each pg_cron `net.http_post` to send `headers => jsonb_build_object('x-internal-secret', '...')`.

- **`enforce-subscription` and `repricer-*`** are the highest-priority hardening targets: they either write to Amazon via SP-API or mutate subscription state.

- **`register-with-hashed-password`** is intentionally public but should have per-IP rate limiting to prevent bulk account creation.

- **User-facing verify_jwt=false functions** (`fetch-profit-loss`, `check-subscription`, `calculate-roi`, `google-scrape`, etc.) all do `getUser()` or `getClaims()` in-code, which is acceptable — but the pattern should be standardized so a new function author can't skip it.

## Next actions (not in this PR)

1. Add `INTERNAL_SYNC_SECRET` secret and roll it into every cron-only function above.
2. Update pg_cron jobs to send the secret in the `x-internal-secret` header.
3. Add per-IP rate limit to `register-with-hashed-password`.
4. Consider a shared `requireInternalOrUser` helper in `supabase/functions/_shared/` to standardize the auth pattern.
