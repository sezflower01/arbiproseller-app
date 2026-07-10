ALTER TABLE public.repricer_rules 
ADD COLUMN IF NOT EXISTS target_anchor text NOT NULL DEFAULT 'smart';