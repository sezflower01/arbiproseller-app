
-- Index for Change History queries (user_id + created_at DESC)
CREATE INDEX IF NOT EXISTS idx_repricer_setting_changes_user_created
ON public.repricer_setting_changes (user_id, created_at DESC);

-- Index for feed submissions (submitted_at DESC) - also timing out
CREATE INDEX IF NOT EXISTS idx_repricer_feed_submissions_submitted_at
ON public.repricer_feed_submissions (submitted_at DESC);

-- Index for roi_alerts lookup
CREATE INDEX IF NOT EXISTS idx_roi_alerts_user_date_roi
ON public.roi_alerts (user_id, order_date, roi);

-- Index for repricer_monitor_checks
CREATE INDEX IF NOT EXISTS idx_repricer_monitor_checks_user_date
ON public.repricer_monitor_checks (user_id, check_date);
