-- Add worker shard column to repricer_settings for parallel dispatch
ALTER TABLE public.repricer_settings 
  ADD COLUMN IF NOT EXISTS dispatch_worker_shard TEXT DEFAULT 'A';

-- Add worker_id to dispatch_metrics for observability
ALTER TABLE public.repricer_dispatch_metrics 
  ADD COLUMN IF NOT EXISTS worker_id TEXT DEFAULT 'A';

-- Index for fast shard-based queries
CREATE INDEX IF NOT EXISTS idx_repricer_settings_worker_shard 
  ON public.repricer_settings (dispatch_worker_shard) 
  WHERE scheduler_enabled = true;