-- Add skip_lower_when_bb_owner to repricer_rules
-- Default TRUE so it's ON by default for AI Win Sales Booster
ALTER TABLE public.repricer_rules 
ADD COLUMN IF NOT EXISTS skip_lower_when_bb_owner boolean NOT NULL DEFAULT true;