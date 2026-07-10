
-- Add home_currency to repricer_settings (seller-scoped, not global)
ALTER TABLE public.repricer_settings
ADD COLUMN IF NOT EXISTS home_currency TEXT NOT NULL DEFAULT 'USD';

-- Add a comment for clarity
COMMENT ON COLUMN public.repricer_settings.home_currency IS 'Seller base currency for cost entry. All FX conversions go from this currency to the target marketplace currency. Default USD preserves existing behavior.';
