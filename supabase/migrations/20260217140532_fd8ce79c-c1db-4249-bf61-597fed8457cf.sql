
-- Auto-turbo rotation settings
ALTER TABLE public.repricer_settings
  ADD COLUMN IF NOT EXISTS auto_turbo_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_turbo_duration_minutes integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS auto_turbo_rule_id uuid REFERENCES public.repricer_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS auto_turbo_last_rotation_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_turbo_current_batch jsonb DEFAULT '[]'::jsonb;

-- auto_turbo_current_batch stores: [{ "assignment_id": "...", "asin": "...", "original_rule_id": "...|null", "started_at": "..." }]

COMMENT ON COLUMN public.repricer_settings.auto_turbo_enabled IS 'Enable automatic turbo rotation for BB price alert ASINs';
COMMENT ON COLUMN public.repricer_settings.auto_turbo_duration_minutes IS 'How long each batch of 5 stays in turbo (5,10,15,20,25,30)';
COMMENT ON COLUMN public.repricer_settings.auto_turbo_rule_id IS 'Rule to temporarily assign during turbo rotation';
COMMENT ON COLUMN public.repricer_settings.auto_turbo_current_batch IS 'Current batch of ASINs in auto-turbo with their original rule_ids';
