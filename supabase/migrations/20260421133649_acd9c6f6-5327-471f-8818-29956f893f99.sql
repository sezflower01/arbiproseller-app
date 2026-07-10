
ALTER TABLE public.smart_engine_tuning_actions
  ADD COLUMN IF NOT EXISTS experiment_start_at timestamptz;

COMMENT ON COLUMN public.smart_engine_tuning_actions.experiment_start_at IS
  'Timestamp the treatment/control split actually went live. Use this (not applied_at) to align baseline/measured windows in outcome snapshots.';

CREATE INDEX IF NOT EXISTS idx_tuning_actions_experiment_start
  ON public.smart_engine_tuning_actions (experiment_start_at DESC)
  WHERE experiment_start_at IS NOT NULL;
