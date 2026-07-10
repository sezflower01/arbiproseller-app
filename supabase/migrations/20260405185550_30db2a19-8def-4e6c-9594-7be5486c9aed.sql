
-- Activity events: raw learning stream from all repricer decisions
CREATE TABLE public.smart_engine_activity_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asin TEXT NOT NULL,
  sku TEXT,
  marketplace TEXT NOT NULL DEFAULT 'US',
  event_type TEXT NOT NULL,
  action_type TEXT,
  decision_label TEXT,
  tuning_signal TEXT,
  current_price NUMERIC,
  target_price NUMERIC,
  buy_box_price NUMERIC,
  lowest_fba_price NUMERIC,
  next_competitor_price NUMERIC,
  min_price NUMERIC,
  max_price NUMERIC,
  profit_floor NUMERIC,
  constraints_json JSONB DEFAULT '[]'::jsonb,
  engine_mode TEXT,
  confidence_score NUMERIC,
  was_price_changed BOOLEAN DEFAULT false,
  was_bb_owner BOOLEAN DEFAULT false,
  snapshot_json JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_activity_events_user_created ON public.smart_engine_activity_events(user_id, created_at DESC);
CREATE INDEX idx_activity_events_asin ON public.smart_engine_activity_events(user_id, asin, marketplace);
CREATE INDEX idx_activity_events_event_type ON public.smart_engine_activity_events(event_type, created_at DESC);

ALTER TABLE public.smart_engine_activity_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own activity events" ON public.smart_engine_activity_events FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users insert own activity events" ON public.smart_engine_activity_events FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- AI review batches
CREATE TABLE public.smart_engine_ai_review_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  selected_case_count INT NOT NULL DEFAULT 0,
  source_window TEXT DEFAULT '24h',
  selection_strategy TEXT DEFAULT 'significance',
  ai_model TEXT,
  ai_summary TEXT,
  recommendation_count INT DEFAULT 0,
  prompt_version TEXT DEFAULT 'v1',
  total_signals_seen INT DEFAULT 0,
  token_estimate INT DEFAULT 0
);

ALTER TABLE public.smart_engine_ai_review_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own AI batches" ON public.smart_engine_ai_review_batches FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users insert own AI batches" ON public.smart_engine_ai_review_batches FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users update own AI batches" ON public.smart_engine_ai_review_batches FOR UPDATE TO authenticated USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- Individual AI reviews
CREATE TABLE public.smart_engine_ai_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  batch_id UUID REFERENCES public.smart_engine_ai_review_batches(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asin TEXT NOT NULL,
  sku TEXT,
  marketplace TEXT NOT NULL DEFAULT 'US',
  event_type TEXT,
  decision_label TEXT,
  pricing_context JSONB DEFAULT '{}'::jsonb,
  constraints_json JSONB DEFAULT '[]'::jsonb,
  ai_judgment TEXT,
  ai_reasoning_summary TEXT,
  ai_tuning_suggestion TEXT,
  ai_confidence TEXT DEFAULT 'medium',
  accepted_status TEXT DEFAULT 'pending',
  prompt_version TEXT DEFAULT 'v1'
);

CREATE INDEX idx_ai_reviews_batch ON public.smart_engine_ai_reviews(batch_id);
CREATE INDEX idx_ai_reviews_user ON public.smart_engine_ai_reviews(user_id, created_at DESC);

ALTER TABLE public.smart_engine_ai_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own AI reviews" ON public.smart_engine_ai_reviews FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users insert own AI reviews" ON public.smart_engine_ai_reviews FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users update own AI reviews" ON public.smart_engine_ai_reviews FOR UPDATE TO authenticated USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
