-- Cleanup: drop the temporary read-only cron-inspection helper added in
-- 20260721001500 for the amazon_sync/Reports-API confirmation-pipeline and
-- inventory_missing_review investigation. Investigation and fix are done.
DROP FUNCTION IF EXISTS public.debug_peek_all_cron_jobs();
