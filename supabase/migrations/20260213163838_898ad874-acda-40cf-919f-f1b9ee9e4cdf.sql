
-- Add momentum check settings to repricer_settings
ALTER TABLE public.repricer_settings 
ADD COLUMN IF NOT EXISTS momentum_check_enabled boolean NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS momentum_threshold_pct integer NOT NULL DEFAULT 50;

COMMENT ON COLUMN public.repricer_settings.momentum_check_enabled IS 'Enable/disable Today Momentum Drop detection';
COMMENT ON COLUMN public.repricer_settings.momentum_threshold_pct IS 'Threshold: trigger momentum drop when today sales < X% of 7d ADS (default 50%)';
