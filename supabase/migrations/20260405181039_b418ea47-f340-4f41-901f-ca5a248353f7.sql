
-- Smart Engine Learning System tables

-- 1. Review batches (persisted snapshots)
CREATE TABLE public.smart_engine_review_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asin_count INT NOT NULL DEFAULT 0,
  optimal_count INT NOT NULL DEFAULT 0,
  review_needed_count INT NOT NULL DEFAULT 0,
  top_signal TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.smart_engine_review_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own batches" ON public.smart_engine_review_batches FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users insert own batches" ON public.smart_engine_review_batches FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- 2. Review items (individual ASIN reviews)
CREATE TABLE public.smart_engine_review_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES public.smart_engine_review_batches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asin TEXT NOT NULL,
  sku TEXT,
  marketplace TEXT NOT NULL DEFAULT 'US',
  decision_type TEXT NOT NULL,
  judgment TEXT NOT NULL,
  judgment_reason TEXT NOT NULL,
  tuning_signals TEXT[] NOT NULL DEFAULT '{}',
  confidence_score NUMERIC,
  current_price NUMERIC,
  buy_box_price NUMERIC,
  lowest_fba_price NUMERIC,
  next_competitor_price NUMERIC,
  min_price NUMERIC,
  max_price NUMERIC,
  profit_floor NUMERIC,
  bb_owner BOOLEAN DEFAULT false,
  constraints_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.smart_engine_review_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own items" ON public.smart_engine_review_items FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users insert own items" ON public.smart_engine_review_items FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE INDEX idx_review_items_batch ON public.smart_engine_review_items(batch_id);
CREATE INDEX idx_review_items_signal ON public.smart_engine_review_items(user_id, asin, created_at DESC);

-- 3. Learning signals (aggregated patterns)
CREATE TABLE public.smart_engine_learning_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL DEFAULT 'US',
  signal_key TEXT NOT NULL,
  signal_label TEXT NOT NULL,
  occurrence_count INT NOT NULL DEFAULT 0,
  affected_asin_count INT NOT NULL DEFAULT 0,
  avg_margin_gap NUMERIC,
  avg_bb_gap NUMERIC,
  avg_days_of_stock NUMERIC,
  recommendation_status TEXT NOT NULL DEFAULT 'watch',
  confidence_score NUMERIC DEFAULT 0,
  notes TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.smart_engine_learning_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own signals" ON public.smart_engine_learning_signals FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users manage own signals" ON public.smart_engine_learning_signals FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE UNIQUE INDEX idx_learning_signals_key ON public.smart_engine_learning_signals(user_id, marketplace, signal_key);

-- 4. Tuning recommendations
CREATE TABLE public.smart_engine_tuning_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_id UUID REFERENCES public.smart_engine_learning_signals(id) ON DELETE SET NULL,
  recommendation_type TEXT NOT NULL,
  parameter_key TEXT NOT NULL,
  current_value TEXT,
  suggested_value TEXT,
  reason TEXT NOT NULL,
  supporting_signal_count INT NOT NULL DEFAULT 0,
  confidence_score NUMERIC DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  safety_bound_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.smart_engine_tuning_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own recommendations" ON public.smart_engine_tuning_recommendations FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users manage own recommendations" ON public.smart_engine_tuning_recommendations FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- 5. Tuning actions (audit trail)
CREATE TABLE public.smart_engine_tuning_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recommendation_id UUID REFERENCES public.smart_engine_tuning_recommendations(id) ON DELETE SET NULL,
  parameter_key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by TEXT NOT NULL DEFAULT 'manual',
  rolled_back_at TIMESTAMPTZ,
  outcome_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.smart_engine_tuning_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own actions" ON public.smart_engine_tuning_actions FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Users manage own actions" ON public.smart_engine_tuning_actions FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
