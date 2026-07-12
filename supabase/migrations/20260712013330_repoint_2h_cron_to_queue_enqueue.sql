-- Option B (see .lovable/inventory-refresh-cron-vs-button-report.md): restore
-- full-inventory-refresh-2h as the feed for inventory_refresh_queue and run
-- it hourly instead of every 2h. This job was repointed on 2026-07-04
-- (migrations 20260704142833, 20260704150654) to call sync-inventory-report-all
-- (SP-API Reports API fan-out) instead, which stopped feeding the queue
-- entirely -- nothing has enqueued rows on a schedule since. Restoring the
-- pre-07-04 behavior (last seen in migration 20260531171107) so it lines up
-- with the throughput fix in the companion migration.
SELECT cron.unschedule('full-inventory-refresh-2h');

SELECT cron.schedule(
  'full-inventory-refresh-2h',
  '15 * * * *',
  $$ SELECT public.enqueue_full_inventory_refresh_all_users(); $$
);
