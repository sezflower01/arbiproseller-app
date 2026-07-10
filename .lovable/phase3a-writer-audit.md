# Phase 3A — Repricer `is_enabled` Writer Audit

Every code path that flips `repricer_assignments.is_enabled = false`, what triggers it, why, whether it currently stamps audit fields, and whether it touches the new Phase 1 fact fields.

Legend:
- **Audit (legacy)** = stamps `last_disabled_by / last_disabled_reason / last_disabled_at`
- **Audit (new)** = stamps `auto_suspended_reason / auto_suspended_at / auto_suspended_by` (Phase 1 contract)
- **Facts** = updates `amazon_listing_state / inventory_confidence / intl_qty_confidence / marketplace_sellable*`

| # | Writer | Trigger / cron | Reason it disables | Audit (legacy) | Audit (new) | Facts |
|---|---|---|---|---|---|---|
| 1 | `sync-intl-marketplace/index.ts:265,269,329` | cron `sync-intl-marketplace-*` (every 6h, per marketplace) | Intl listing not ACTIVE / NOT_FOUND / backfill non-eligible | ❌ none | ❌ none | partial (`intl_listing_status` only) |
| 2 | `sync-intl-asin/index.ts:219,228,341` | on-demand from UI (per ASIN refresh) | Intl listing not eligible / NOT_FOUND | ❌ none | ❌ none | partial |
| 3 | `sync-amazon-inventory/index.ts:698` | cron `auto-inventory-sync-*` | Intl SKU discovered while inactive | ❌ none | ❌ none | partial |
| 4 | `sync-inventory-report/index.ts:1730` | cron `sync-inventory-report-4h` (via fan-out) | Bulk zero-stock disable | ✅ `last_disabled_reason='sync-inventory-report: zero stock'` | ❌ none | partial (qty only) |
| 5 | `cleanup-dead-assignments/index.ts:74` | cron every 6h | Intl ineligible / terminal listing_status / MISMATCH+0 stock >48h | ✅ | ❌ none | no |
| 6 | `clean-ghost-listings/index.ts:338` | cron nightly | Ghost (NOT_IN_CATALOG) | ✅ | ❌ none | no |
| 7 | `repricer-cleanup/index.ts:206` | cron / manual | Stuck / zero sellable stock | ✅ | ❌ none | no |
| 8 | `auto-assign-bulk/index.ts:766` | on-demand (after bulk assign) | Broken/deleted assignment | ✅ | ❌ none | no |
| 9 | `verify-intl-listings-existence/index.ts:133` | nightly cron + on-demand | SP-API reports listing deleted/not-in-catalog | ✅ | ❌ none | yes (`intl_listing_status='NOT_FOUND'`) |

**Highest-blast-radius silent disabler:** row 1 (`sync-intl-marketplace`) — it runs unattended every 6h across every non-US marketplace and writes `is_enabled:false` with **zero audit and no fact stamping**. This is the writer that re-disabled BR/CA/MX. Patched in this phase.

All others stamp the legacy audit fields, so they remain visible/explainable and are not silent. They will be migrated to the new contract in Phase 3B+.

## Phase 3A trigger guard

`fn_enforce_assignment_audit` (BEFORE UPDATE) rejects any update that flips `is_enabled` from TRUE → FALSE unless **one** of:
- `manual_paused` is being set to `true` in the same statement, OR
- `auto_suspended_reason` is non-null after the update (new contract), OR
- `last_disabled_reason` is non-null after the update (legacy contract — kept for back-compat until Phase 3B+).

Legacy rows that are already `is_enabled=false` are not touched. False→false updates pass through. Service role bypass is **not** added; the guard applies to every role so edge functions also obey it.
