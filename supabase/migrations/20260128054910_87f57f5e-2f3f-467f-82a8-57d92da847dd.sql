-- Add Smart Raise settings to repricer_rules
ALTER TABLE public.repricer_rules 
ADD COLUMN IF NOT EXISTS enable_smart_raise BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS raise_trigger_percent NUMERIC DEFAULT 2,
ADD COLUMN IF NOT EXISTS max_raise_step_dollars NUMERIC DEFAULT 0.25,
ADD COLUMN IF NOT EXISTS max_raise_step_percent NUMERIC DEFAULT 2,
ADD COLUMN IF NOT EXISTS only_raise_when_buybox_owner BOOLEAN DEFAULT true;

-- Add index for efficient queries
COMMENT ON COLUMN public.repricer_rules.enable_smart_raise IS 'When enabled, repricer will raise prices when market goes up';
COMMENT ON COLUMN public.repricer_rules.raise_trigger_percent IS 'Minimum % increase in Buy Box price to trigger a raise (default 2%)';
COMMENT ON COLUMN public.repricer_rules.max_raise_step_dollars IS 'Maximum amount to raise per step in dollars (default $0.25)';
COMMENT ON COLUMN public.repricer_rules.max_raise_step_percent IS 'Maximum percentage to raise per step (default 2%)';
COMMENT ON COLUMN public.repricer_rules.only_raise_when_buybox_owner IS 'Only raise when we currently own the Buy Box (safer)';