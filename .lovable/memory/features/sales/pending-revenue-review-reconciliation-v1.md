---
name: Pending Revenue Review Auto-Reconciliation
description: Daily reconciler + weekly count for the 59 pending_revenue_review_needed audit rows; self-heals to 0 once FEC settles, never mutates pending rows
type: feature
---
Two SQL helpers added for the qty>1 audit sweep follow-up:

- `public.reconcile_pending_revenue_review()` — scans open `pending_revenue_review_needed` rows (no later resolved/repaired sibling) whose `sales_orders` row is now settled (`price_confidence='CONFIRMED'` OR `price_source` in financial_events / orders_itemprice / sold_price_intl / settlement). If stored `total_sale_amount >= 0.9 × sold_price × quantity`, logs `pending_revenue_review_resolved` (no mutation). If materially low, sets `total_sale_amount = sold_price × quantity`, recomputes `roi` from `unit_cost × quantity`, and logs `pending_revenue_review_repaired_by_settlement`.
- `public.report_pending_revenue_review_weekly()` — inserts a `pending_revenue_review_weekly_report` audit row (order_id='WEEKLY_REPORT') with the remaining open count.

Cron jobs:
- `reconcile-pending-revenue-review-daily` — `20 6 * * *`
- `pending-revenue-review-weekly-report` — `0 13 * * 1` (Mon 13:00 UTC)

Never mutates pending (unsettled) rows. The 59-row audit batch was created `2026-06-06`; tracked to 0 via the weekly report.
