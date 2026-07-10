
ALTER TABLE public.repricer_settings
  ADD COLUMN IF NOT EXISTS sequential_sweep_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sequential_sweep_batch_size integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS sequential_sweep_interval_minutes integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS sequential_sweep_last_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS sequential_sweep_checked_this_pass integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sequential_sweep_total_eligible integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sequential_sweep_pass_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS sequential_sweep_passes_completed integer NOT NULL DEFAULT 0;
