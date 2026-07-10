CREATE INDEX IF NOT EXISTS idx_ra_user_monitor_covering
  ON public.repricer_assignments (user_id)
  INCLUDE (asin, status, last_sp_api_check_at, marketplace, rule_id, is_enabled);

ANALYZE public.repricer_assignments;