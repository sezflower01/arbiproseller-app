-- Momentum Smart V2: tighten the market-supported raise gate rather than
-- abandon it. Real data (Rule Performance dashboard) showed 5/43 raises
-- (11.6%, Wilson 95% CI 5.1-24.5%) lost the Buy Box afterward vs Momentum
-- Builder's 0/175 (rule-of-three upper bound ~1.7%) over the same window --
-- confounded by different ASIN portfolios per preset, not a proven causal
-- gap, but a real enough signal to justify tightening now (tightening only
-- trades away potential margin upside, it can't hurt Buy Box retention).
--
-- min_floor_support_ratio: instead of "competitor floor rose at all",
-- require the floor's rise to be at least this fraction of the Buy Box's
-- rise -- filters out cases where the BB moved but the real market barely
-- did. NULL preserves the V1 "any rise" behavior for every other preset.
--
-- post_raise_cooldown_hours: block another raise attempt on the same
-- assignment for this many hours after ANY raise (successful or not),
-- regardless of outcome -- prevents Raise -> Raise -> Raise stacking before
-- there's evidence the market actually held the new price. NULL = no
-- cooldown (every other preset's existing behavior, unchanged).
ALTER TABLE public.repricer_rules
  ADD COLUMN IF NOT EXISTS min_floor_support_ratio numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS post_raise_cooldown_hours numeric DEFAULT NULL;

-- Stamped by repricer-scheduler whenever a submitted price change is a raise
-- (new price > prior price), regardless of which preset/rule caused it --
-- only presets with post_raise_cooldown_hours set will actually read it.
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS last_raise_at timestamptz DEFAULT NULL;
