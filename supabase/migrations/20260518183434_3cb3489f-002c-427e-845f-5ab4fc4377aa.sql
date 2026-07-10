
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS marketplace_sellable boolean,
  ADD COLUMN IF NOT EXISTS marketplace_sellability_reason text,
  ADD COLUMN IF NOT EXISTS marketplace_checked_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_repricer_assignments_mkt_sellable
  ON public.repricer_assignments (user_id, marketplace, marketplace_sellable)
  WHERE marketplace <> 'US';

CREATE INDEX IF NOT EXISTS idx_repricer_assignments_mkt_checked_at
  ON public.repricer_assignments (marketplace, marketplace_checked_at NULLS FIRST)
  WHERE marketplace <> 'US';
