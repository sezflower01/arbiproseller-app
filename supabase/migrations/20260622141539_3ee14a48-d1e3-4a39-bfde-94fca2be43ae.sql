CREATE TABLE public.learned_fee_multipliers (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  marketplace text NOT NULL,
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
  CONSTRAINT learned_fee_multipliers_marketplace_chk
    CHECK (marketplace IN ('CA','MX','BR')),
  CONSTRAINT learned_fee_multipliers_component_chk
    CHECK (fee_component IN ('referral','fba','closing','total')),
  CONSTRAINT learned_fee_multipliers_confidence_chk
    CHECK (confidence IN ('insufficient','low','medium','high')),
  CONSTRAINT learned_fee_multipliers_unique
    UNIQUE (user_id, marketplace, fee_component)
);

GRANT SELECT ON public.learned_fee_multipliers TO authenticated;
GRANT ALL ON public.learned_fee_multipliers TO service_role;

ALTER TABLE public.learned_fee_multipliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own learned multipliers"
  ON public.learned_fee_multipliers
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access"
  ON public.learned_fee_multipliers
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS learned_fee_multipliers_user_mp_idx
  ON public.learned_fee_multipliers (user_id, marketplace);

CREATE OR REPLACE FUNCTION public.touch_learned_fee_multipliers_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER learned_fee_multipliers_touch_updated_at
  BEFORE UPDATE ON public.learned_fee_multipliers
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_learned_fee_multipliers_updated_at();