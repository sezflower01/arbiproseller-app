-- Stock-Aware Aggression Overlay columns on repricer_rules
ALTER TABLE public.repricer_rules
  ADD COLUMN IF NOT EXISTS stock_overlay_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS velocity_weight_7d numeric NOT NULL DEFAULT 0.6,
  ADD COLUMN IF NOT EXISTS velocity_weight_30d numeric NOT NULL DEFAULT 0.4,
  ADD COLUMN IF NOT EXISTS stock_threshold_critical integer NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS stock_threshold_low integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS stock_threshold_healthy_max integer NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS stock_threshold_heavy integer NOT NULL DEFAULT 180,
  ADD COLUMN IF NOT EXISTS stock_modifier_critical numeric NOT NULL DEFAULT 0.75,
  ADD COLUMN IF NOT EXISTS stock_modifier_low numeric NOT NULL DEFAULT 0.85,
  ADD COLUMN IF NOT EXISTS stock_modifier_normal numeric NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS stock_modifier_heavy numeric NOT NULL DEFAULT 1.10,
  ADD COLUMN IF NOT EXISTS stock_modifier_overstock numeric NOT NULL DEFAULT 1.30;
