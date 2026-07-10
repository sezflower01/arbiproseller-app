ALTER TABLE public.repricer_rules
ADD COLUMN IF NOT EXISTS fbm_competition_mode TEXT
  CHECK (fbm_competition_mode IN ('fba_priority', 'all_sellers', 'lowest_seller'));

COMMENT ON COLUMN public.repricer_rules.fbm_competition_mode IS
'Three-way FBM competition selector. NULL = derive from legacy ignore_fbm_unless_buybox_owner boolean. Values: fba_priority (ignore FBM unless they own BB), all_sellers (treat FBM same as FBA, may still apply quality filters/smart_raise), lowest_seller (always anchor to lowest external seller of same fulfillment for FBM listings; disables smart_raise / eligible_gap_recovery_raise / FBA fallback while a lower same-fulfillment competitor exists; uses fbm_undercut_amount).';