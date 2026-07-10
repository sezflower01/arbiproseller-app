ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS intl_learned_fees_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS intl_learned_fees_ca      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS intl_learned_fees_mx      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS intl_learned_fees_br      boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.user_settings.intl_learned_fees_enabled IS
  'Phase 2 master switch for learned international fee multipliers. When false, pending CA/MX/BR fee estimates revert to raw SP-API output.';
COMMENT ON COLUMN public.user_settings.intl_learned_fees_br IS
  'Separate kill switch for BR. BR currently has low sample size (22 settled orders); leave on while pattern is consistent, flip off if a new settlement skews the multiplier.';