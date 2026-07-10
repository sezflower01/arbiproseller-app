CREATE UNIQUE INDEX IF NOT EXISTS admin_refresh_runs_one_running_per_user
  ON public.admin_refresh_runs (target_user_id)
  WHERE status = 'running';