
-- Add marketplace_schedule JSONB column to repricer_rules
-- Stores per-marketplace scheduling config: role, schedule_window, budget_share_pct, exception_triggers, cadence
ALTER TABLE public.repricer_rules 
ADD COLUMN IF NOT EXISTS marketplace_schedule jsonb DEFAULT '{}'::jsonb;

-- Add primary_marketplace to repricer_settings (user-level default)
ALTER TABLE public.repricer_settings
ADD COLUMN IF NOT EXISTS primary_marketplace text DEFAULT 'US';

-- Add marketplace_roles to repricer_settings (global fallback roles)
ALTER TABLE public.repricer_settings
ADD COLUMN IF NOT EXISTS marketplace_roles jsonb DEFAULT '{"US": "primary", "CA": "maintenance", "MX": "maintenance", "BR": "maintenance"}'::jsonb;
