
-- Remove the redundant 15-minute full auto-sync (too frequent, causes overlaps)
SELECT cron.unschedule(5);

-- Remove the redundant midnight auto-sync (redundant with 4-hour job)
SELECT cron.unschedule(1);
