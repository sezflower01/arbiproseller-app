
ALTER TABLE public.live_verify_schedule
  ADD COLUMN is_running BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN run_started_at TIMESTAMPTZ,
  ADD COLUMN avg_runtime_seconds INTEGER,
  ADD COLUMN run_history_count INTEGER NOT NULL DEFAULT 0;
