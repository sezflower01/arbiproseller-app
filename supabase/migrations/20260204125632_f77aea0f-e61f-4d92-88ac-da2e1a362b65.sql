-- Add competitor quality filtering columns to repricer_rules
ALTER TABLE public.repricer_rules
ADD COLUMN IF NOT EXISTS min_seller_rating integer DEFAULT 80,
ADD COLUMN IF NOT EXISTS max_handling_days integer DEFAULT 2,
ADD COLUMN IF NOT EXISTS ships_from_filter text DEFAULT 'ANY',
ADD COLUMN IF NOT EXISTS top_n_competitors integer DEFAULT 8,
ADD COLUMN IF NOT EXISTS competitor_quality_preset text DEFAULT 'balanced';

-- Add comments for documentation
COMMENT ON COLUMN public.repricer_rules.min_seller_rating IS 'Minimum seller positive rating percentage (0-100) to consider as competition';
COMMENT ON COLUMN public.repricer_rules.max_handling_days IS 'Maximum handling time in days to consider seller as competition';
COMMENT ON COLUMN public.repricer_rules.ships_from_filter IS 'Ships from filter: US_ONLY, DOMESTIC, or ANY';
COMMENT ON COLUMN public.repricer_rules.top_n_competitors IS 'Only consider top N competitors after quality filtering';
COMMENT ON COLUMN public.repricer_rules.competitor_quality_preset IS 'Preset: conservative, balanced, aggressive, or custom';