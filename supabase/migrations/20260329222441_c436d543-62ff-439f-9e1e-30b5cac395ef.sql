
-- Clean up stale last_skip_reason = 'DAILY_CHECK_CAP' values 
-- This skip reason was set by old code that no longer exists
-- Items with recent sp_api_check should have their skip reason cleared
UPDATE repricer_assignments
SET last_skip_reason = NULL
WHERE last_skip_reason = 'DAILY_CHECK_CAP'
  AND last_sp_api_check_at > now() - interval '48 hours';

-- Also clean up DAILY_CHECK_CAP that's more than 7 days stale
UPDATE repricer_assignments
SET last_skip_reason = NULL
WHERE last_skip_reason = 'DAILY_CHECK_CAP'
  AND (last_sp_api_check_at IS NULL OR last_sp_api_check_at < now() - interval '7 days');
