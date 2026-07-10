
-- 1. Columns on repricer_assignments for current suppression state
ALTER TABLE public.repricer_assignments
  ADD COLUMN IF NOT EXISTS pricing_suppression_raw_code TEXT,
  ADD COLUMN IF NOT EXISTS pricing_suppression_raw_message TEXT,
  ADD COLUMN IF NOT EXISTS pricing_suppression_categories TEXT[],
  ADD COLUMN IF NOT EXISTS pricing_suppression_enforcement_actions TEXT[],
  ADD COLUMN IF NOT EXISTS pricing_suppression_severity TEXT,
  ADD COLUMN IF NOT EXISTS pricing_suppression_detected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pricing_suppression_cleared_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pricing_suppression_pending_clear_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pricing_suppression_last_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_pricing_suppression BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS listing_issue_unknown_flagged BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS listing_issue_unknown_categories TEXT[];

CREATE INDEX IF NOT EXISTS idx_repricer_assignments_pricing_suppression
  ON public.repricer_assignments (user_id, marketplace)
  WHERE is_pricing_suppression = true;

CREATE INDEX IF NOT EXISTS idx_repricer_assignments_unknown_listing_issue
  ON public.repricer_assignments (user_id, marketplace)
  WHERE listing_issue_unknown_flagged = true;

-- 2. Per-run audit table
CREATE TABLE IF NOT EXISTS public.repricer_pricing_suppression_checks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  run_id UUID NOT NULL,
  sku TEXT NOT NULL,
  asin TEXT,
  marketplace TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  summaries_non_empty BOOLEAN NOT NULL,
  trust_gate_passed BOOLEAN NOT NULL,
  issues_seen JSONB NOT NULL DEFAULT '[]'::jsonb,
  action_taken TEXT NOT NULL,
  notes TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.repricer_pricing_suppression_checks TO authenticated;
GRANT ALL ON public.repricer_pricing_suppression_checks TO service_role;

ALTER TABLE public.repricer_pricing_suppression_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own suppression checks"
  ON public.repricer_pricing_suppression_checks FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Service role manages suppression checks"
  ON public.repricer_pricing_suppression_checks FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_suppression_checks_user_time
  ON public.repricer_pricing_suppression_checks (user_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_suppression_checks_run
  ON public.repricer_pricing_suppression_checks (run_id);
CREATE INDEX IF NOT EXISTS idx_suppression_checks_sku
  ON public.repricer_pricing_suppression_checks (user_id, marketplace, sku);

-- 3. Closed-episode history
CREATE TABLE IF NOT EXISTS public.repricer_pricing_suppression_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  sku TEXT NOT NULL,
  asin TEXT,
  marketplace TEXT NOT NULL,
  raw_code TEXT,
  raw_message TEXT,
  categories TEXT[],
  enforcement_actions TEXT[],
  severity TEXT,
  was_pricing_suppression BOOLEAN NOT NULL DEFAULT false,
  detected_at TIMESTAMPTZ NOT NULL,
  cleared_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.repricer_pricing_suppression_history TO authenticated;
GRANT ALL ON public.repricer_pricing_suppression_history TO service_role;

ALTER TABLE public.repricer_pricing_suppression_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own suppression history"
  ON public.repricer_pricing_suppression_history FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Service role manages suppression history"
  ON public.repricer_pricing_suppression_history FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_suppression_history_user_time
  ON public.repricer_pricing_suppression_history (user_id, cleared_at DESC);
CREATE INDEX IF NOT EXISTS idx_suppression_history_sku
  ON public.repricer_pricing_suppression_history (user_id, marketplace, sku);
