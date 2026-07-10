ALTER TABLE public.repricer_rules
  ADD COLUMN IF NOT EXISTS fbm_undercut_amount NUMERIC;

COMMENT ON COLUMN public.repricer_rules.fbm_undercut_amount IS
  'Per-rule FBM-specific undercut amount (in dollars). When NULL, the engine falls back to undercut_amount (which now functions as the FBA undercut). Used only when the seller listing is FBM and anchored to the lowest FBM competitor.';