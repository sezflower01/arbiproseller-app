-- Add Monopoly Mode and FBM handling fields to repricer_rules
ALTER TABLE public.repricer_rules 
ADD COLUMN IF NOT EXISTS enable_monopoly_mode boolean DEFAULT true,
ADD COLUMN IF NOT EXISTS monopoly_raise_step_dollars numeric DEFAULT 0.10,
ADD COLUMN IF NOT EXISTS monopoly_raise_step_percent numeric DEFAULT 1,
ADD COLUMN IF NOT EXISTS monopoly_cooldown_minutes integer DEFAULT 60,
ADD COLUMN IF NOT EXISTS monopoly_mode_type text DEFAULT 'conservative',
ADD COLUMN IF NOT EXISTS ignore_fbm_unless_buybox_owner boolean DEFAULT true;

-- Add comment explaining Monopoly Mode
COMMENT ON COLUMN public.repricer_rules.enable_monopoly_mode IS 'When enabled, proactively raises prices when user is the only FBA seller';
COMMENT ON COLUMN public.repricer_rules.monopoly_mode_type IS 'conservative or aggressive - controls raise step sizing';
COMMENT ON COLUMN public.repricer_rules.ignore_fbm_unless_buybox_owner IS 'Only react to FBM pricing if FBM actually owns the Buy Box';