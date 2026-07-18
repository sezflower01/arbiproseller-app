-- Drops the temporary read-only helper added in
-- 20260718210000_debug_cron_job_peek.sql, used only to investigate the
-- 30-vs-60/min throughput question live. Investigation is done; the finding
-- was that batch_size was correctly 60 all along, no code bug -- see commit
-- message / conversation for details.
DROP FUNCTION IF EXISTS public.debug_peek_cron_jobs();
