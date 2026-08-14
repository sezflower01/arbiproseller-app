-- Supports the MOMENTUM_SMART hybrid preset: asymmetric cooldown (fast while
-- losing the Buy Box, slow while holding it) and a "market-supported raise"
-- gate that requires the competitor floor to have moved, not just the Buy
-- Box price, before enable_smart_raise fires. NULL for every existing rule
-- (including all other presets) so this is purely additive -- the pricing
-- engine falls back to the existing single cooldown_minutes/raw smart-raise
-- behavior whenever these are unset.
ALTER TABLE public.repricer_rules
  ADD COLUMN IF NOT EXISTS cooldown_minutes_losing_bb integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cooldown_minutes_winning_bb integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS require_market_supported_raise boolean NOT NULL DEFAULT false;
