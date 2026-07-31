-- Clean up the temporary debug helpers added to investigate sync-inventory-report.
DROP FUNCTION IF EXISTS public.debug_cron_run_details(text, int);
DROP FUNCTION IF EXISTS public.debug_list_cron_jobs();
