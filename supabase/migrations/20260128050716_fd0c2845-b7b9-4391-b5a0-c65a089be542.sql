-- Add new toggle columns to repricer_assignments for granular control
ALTER TABLE public.repricer_assignments
ADD COLUMN IF NOT EXISTS auto_set_minmax_if_missing BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS auto_lower_min_price BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS auto_raise_max_price BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS last_min_price_on_amazon NUMERIC,
ADD COLUMN IF NOT EXISTS last_max_price_on_amazon NUMERIC,
ADD COLUMN IF NOT EXISTS price_changes_today INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS price_changes_reset_at DATE,
ADD COLUMN IF NOT EXISTS last_price_change_at TIMESTAMP WITH TIME ZONE;

-- Add safety settings to repricer_settings
ALTER TABLE public.repricer_settings
ADD COLUMN IF NOT EXISTS absolute_min_price_floor NUMERIC DEFAULT 0.99,
ADD COLUMN IF NOT EXISTS max_price_change_percent_per_day NUMERIC DEFAULT 50,
ADD COLUMN IF NOT EXISTS max_minmax_changes_per_day INTEGER DEFAULT 10,
ADD COLUMN IF NOT EXISTS require_cost_for_min_calc BOOLEAN DEFAULT true;