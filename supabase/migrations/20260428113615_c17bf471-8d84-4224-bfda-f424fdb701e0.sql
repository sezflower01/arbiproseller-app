SELECT cron.schedule('auto-sync-inventory-every-4-hours', '0 */4 * * *', $$SELECT 1 WHERE false;$$);
SELECT cron.schedule('auto-sync-all-users-v2', '15 */4 * * *', $$SELECT 1 WHERE false;$$);