-- ASIN-specific fee correction, mirroring learned_fee_multipliers but scoped
-- to (user_id, marketplace, asin). Fixes overcorrection where the account-wide
-- blended multiplier (e.g. CA total=1.2591, averaged across 462 orders of many
-- different products) gets applied uniformly to every ASIN, even ones whose
-- own raw fee estimate already tracks close to their real settled fees.
--
-- Read path prefers this table when an ASIN has enough of its own settlement
-- history (sample_count >= 3), falling back to the marketplace-wide blend
-- otherwise. See learn-intl-fee-multipliers/index.ts and
-- src/lib/sales/learnedFeeMultipliers.ts.

CREATE TABLE public.learned_fee_multipliers_asin (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  marketplace text NOT NULL,
  asin text NOT NULL,
  fee_component text NOT NULL,
  sample_count integer NOT NULL DEFAULT 0,
  multiplier numeric(6,4),
  confidence text NOT NULL DEFAULT 'insufficient',
  window_start date,
  window_end date,
  sample_orders jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_estimated_total numeric(14,4),
  raw_actual_total numeric(14,4),
  last_computed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learned_fee_multipliers_asin_marketplace_chk
    CHECK (marketplace IN ('CA','MX','BR')),
  CONSTRAINT learned_fee_multipliers_asin_component_chk
    CHECK (fee_component IN ('referral','fba','closing','total')),
  CONSTRAINT learned_fee_multipliers_asin_confidence_chk
    CHECK (confidence IN ('insufficient','low','medium','high')),
  CONSTRAINT learned_fee_multipliers_asin_unique
    UNIQUE (user_id, marketplace, asin, fee_component)
);

GRANT SELECT ON public.learned_fee_multipliers_asin TO authenticated;
GRANT ALL ON public.learned_fee_multipliers_asin TO service_role;

ALTER TABLE public.learned_fee_multipliers_asin ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own asin learned multipliers"
  ON public.learned_fee_multipliers_asin
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access asin multipliers"
  ON public.learned_fee_multipliers_asin
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS learned_fee_multipliers_asin_lookup_idx
  ON public.learned_fee_multipliers_asin (user_id, marketplace, asin);

CREATE TRIGGER learned_fee_multipliers_asin_touch_updated_at
  BEFORE UPDATE ON public.learned_fee_multipliers_asin
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_learned_fee_multipliers_updated_at();
