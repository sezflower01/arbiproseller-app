
-- Add oscillation handling fields to repricer_rules
ALTER TABLE public.repricer_rules
  ADD COLUMN IF NOT EXISTS oscillation_mode text NOT NULL DEFAULT 'safe',
  ADD COLUMN IF NOT EXISTS oscillation_cooldown_minutes integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS oscillation_max_reactions integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS oscillation_bb_loss_limit integer NOT NULL DEFAULT 1;

-- Add oscillation state tracking fields to repricer_assignments
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS oscillation_state text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS oscillation_detected_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS oscillation_reaction_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS oscillation_cooldown_until timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS oscillation_last_mode_used text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_stable_price numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_bb_loss_after_raise_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS oscillation_last_reason text DEFAULT NULL;

-- Add constraint to validate oscillation_mode values
ALTER TABLE public.repricer_rules
  ADD CONSTRAINT check_oscillation_mode CHECK (oscillation_mode IN ('safe', 'balanced', 'aggressive'));
