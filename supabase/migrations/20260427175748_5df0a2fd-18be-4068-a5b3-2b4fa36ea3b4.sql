
-- Stagger auto-sync-all-users-v2 (full report sync) to minute 15
-- so it doesn't collide with auto-sync-inventory-every-4-hours (jobid 2) at minute 0.
DO $$
DECLARE
  v_command text;
BEGIN
  SELECT command INTO v_command FROM cron.job WHERE jobid = 26;
  IF v_command IS NOT NULL THEN
    PERFORM cron.alter_job(job_id := 26, schedule := '15 */4 * * *');
    RAISE NOTICE 'Rescheduled job 26 (auto-sync-all-users-v2) to 15 */4 * * *';
  END IF;
END $$;
