
-- Audit table for admin-triggered SP-API refreshes (self or remote single-user)
CREATE TABLE IF NOT EXISTS public.admin_refresh_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by_user_id UUID NOT NULL,
  triggered_by_email TEXT,
  target_user_id UUID NOT NULL,
  target_email TEXT,
  scope TEXT NOT NULL DEFAULT 'single_user', -- 'self' | 'single_user' | 'all_users'
  source TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'self_auto'
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'success' | 'failed' | 'skipped_locked' | 'skipped_cron_recent'
  skipped_reason TEXT,
  error_message TEXT,
  detail JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_admin_refresh_runs_started_at ON public.admin_refresh_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_refresh_runs_target_user ON public.admin_refresh_runs(target_user_id, started_at DESC);

GRANT SELECT ON public.admin_refresh_runs TO authenticated;
GRANT ALL ON public.admin_refresh_runs TO service_role;

ALTER TABLE public.admin_refresh_runs ENABLE ROW LEVEL SECURITY;

-- Admins can read all audit rows
CREATE POLICY "Admins can read all admin refresh runs"
ON public.admin_refresh_runs FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));
