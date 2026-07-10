
-- ============================================================
-- PHASE 1+2: Unified Dispatch Architecture
-- ============================================================

-- 1. Evaluation Acknowledgment Table
-- Persists what was observed after every eval to prevent re-triggers on unchanged conditions
CREATE TABLE IF NOT EXISTS public.repricer_eval_acks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asin text NOT NULL,
  marketplace text NOT NULL DEFAULT 'US',
  -- Market snapshot at time of evaluation
  buybox_price numeric,
  lowest_fba_price numeric,
  lowest_fbm_price numeric,
  my_price numeric,
  is_buybox_owner boolean,
  -- Result of evaluation
  result text NOT NULL DEFAULT 'no_change', -- 'changed', 'no_change', 'blocked', 'error'
  reason text,
  constraint_applied text, -- e.g. 'floor_applied', 'delta_too_small'
  recommended_price numeric,
  applied_price numeric,
  -- Metadata
  trigger_source text, -- 'unified_dispatch', 'manual', etc.
  evaluation_ms integer, -- how long the eval took
  acked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, asin, marketplace)
);

-- Index for fast lookups during dispatch scoring
CREATE INDEX IF NOT EXISTS idx_eval_acks_user_asin ON public.repricer_eval_acks(user_id, asin, marketplace);
CREATE INDEX IF NOT EXISTS idx_eval_acks_acked_at ON public.repricer_eval_acks(user_id, acked_at DESC);

ALTER TABLE public.repricer_eval_acks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own eval acks"
  ON public.repricer_eval_acks FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- 2. Dispatch Metrics Table
-- Tracks per-cycle metrics for the unified dispatcher
CREATE TABLE IF NOT EXISTS public.repricer_dispatch_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cycle_started_at timestamptz NOT NULL DEFAULT now(),
  cycle_ended_at timestamptz,
  -- Throughput metrics
  total_eligible integer DEFAULT 0,
  total_dispatched integer DEFAULT 0,
  total_evaluated integer DEFAULT 0,
  total_applied integer DEFAULT 0,
  total_skipped integer DEFAULT 0,
  total_errors integer DEFAULT 0,
  -- Quality metrics
  duplicate_selections integer DEFAULT 0,
  duplicate_evals_within_5min integer DEFAULT 0,
  active_in_stock_pct numeric, -- % of budget spent on active in-stock
  inactive_filtered integer DEFAULT 0,
  -- Timing
  scoring_ms integer,
  dispatch_ms integer,
  total_ms integer,
  -- Score distribution (top reasons for selection)
  top_reasons jsonb,
  -- Budget usage
  sp_api_calls_used integer DEFAULT 0,
  sp_api_budget_cap integer,
  budget_utilization_pct numeric
);

CREATE INDEX IF NOT EXISTS idx_dispatch_metrics_user ON public.repricer_dispatch_metrics(user_id, cycle_started_at DESC);

ALTER TABLE public.repricer_dispatch_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own dispatch metrics"
  ON public.repricer_dispatch_metrics FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- 3. Add dispatch scoring columns to assignments (if not already present)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'repricer_assignments' AND column_name = 'dispatch_score') THEN
    ALTER TABLE public.repricer_assignments ADD COLUMN dispatch_score numeric DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'repricer_assignments' AND column_name = 'dispatch_reason') THEN
    ALTER TABLE public.repricer_assignments ADD COLUMN dispatch_reason text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'repricer_assignments' AND column_name = 'last_dispatch_at') THEN
    ALTER TABLE public.repricer_assignments ADD COLUMN last_dispatch_at timestamptz;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'repricer_assignments' AND column_name = 'last_ack_result') THEN
    ALTER TABLE public.repricer_assignments ADD COLUMN last_ack_result text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'repricer_assignments' AND column_name = 'last_ack_reason') THEN
    ALTER TABLE public.repricer_assignments ADD COLUMN last_ack_reason text;
  END IF;
END $$;
