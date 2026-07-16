-- Auto Inventory Sync cron status is becoming a SaaS-wide feature, not an
-- admin-only debug tool -- every user should be able to see cron health and
-- manually trigger their own sync. auto_inventory_sync_runs has no user_id
-- column (it's one row per whole cron cycle, aggregating counts across all
-- users), so there's no per-user data to leak here, just aggregate counts.
DROP POLICY IF EXISTS "Admins can read sync runs" ON public.auto_inventory_sync_runs;

CREATE POLICY "Authenticated users can read sync runs"
ON public.auto_inventory_sync_runs
FOR SELECT
TO authenticated
USING (true);
