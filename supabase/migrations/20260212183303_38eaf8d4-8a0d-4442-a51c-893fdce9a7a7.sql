
-- Add profit_guard_mode to repricer_rules
-- 'strict' = current behavior (profit guard can keep price above min)
-- 'respect_min_max' = profit guard warns/tags but min/max are the hard clamp
-- 'off' = no profit guard at all
ALTER TABLE public.repricer_rules 
ADD COLUMN IF NOT EXISTS profit_guard_mode text NOT NULL DEFAULT 'strict';

-- Add a comment for clarity
COMMENT ON COLUMN public.repricer_rules.profit_guard_mode IS 'Controls how Profit Guard interacts with Min/Max: strict (default, profit guard overrides min), respect_min_max (min/max are hard clamp, profit guard only warns), off (disabled)';
