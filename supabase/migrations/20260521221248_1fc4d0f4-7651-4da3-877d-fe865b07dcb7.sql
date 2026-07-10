-- Analyzer Decision Memory: Phase 1 (data capture only)

CREATE TABLE public.analyzer_decision_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  source TEXT NOT NULL DEFAULT 'web', -- 'web' | 'extension'
  cost NUMERIC,
  fees NUMERIC,
  sale_price NUMERIC,
  roi NUMERIC,
  profit NUMERIC,
  margin NUMERIC,
  bsr INTEGER,
  est_sales_month INTEGER,
  buy_box NUMERIC,
  lowest_fba NUMERIC,
  lowest_fbm NUMERIC,
  seller_count INTEGER,
  swing_3m NUMERIC,
  swing_6m NUMERIC,
  swing_1y NUMERIC,
  eligibility TEXT,
  hazmat BOOLEAN,
  prep_required BOOLEAN,
  pl_risk TEXT,
  ip_risk TEXT,
  competition_level TEXT,
  final_decision TEXT,
  confidence TEXT,
  ai_reasoning TEXT,
  raw_snapshot JSONB,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_adl_user_asin_scanned ON public.analyzer_decision_log (user_id, asin, scanned_at DESC);
CREATE INDEX idx_adl_user_scanned ON public.analyzer_decision_log (user_id, scanned_at DESC);

ALTER TABLE public.analyzer_decision_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners view own decision logs"
  ON public.analyzer_decision_log FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Owners insert own decision logs"
  ON public.analyzer_decision_log FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Owners update own decision logs"
  ON public.analyzer_decision_log FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Owners delete own decision logs"
  ON public.analyzer_decision_log FOR DELETE
  USING (auth.uid() = user_id);


CREATE TABLE public.analyzer_decision_action (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  decision_id UUID NOT NULL REFERENCES public.analyzer_decision_log(id) ON DELETE CASCADE,
  asin TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  action TEXT NOT NULL, -- 'buy' | 'skip' | 'watch' | 'bought_units'
  units INTEGER,
  notes TEXT,
  acted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ada_user_asin ON public.analyzer_decision_action (user_id, asin, acted_at DESC);

ALTER TABLE public.analyzer_decision_action ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners view own decision actions"
  ON public.analyzer_decision_action FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Owners insert own decision actions"
  ON public.analyzer_decision_action FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Owners update own decision actions"
  ON public.analyzer_decision_action FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Owners delete own decision actions"
  ON public.analyzer_decision_action FOR DELETE
  USING (auth.uid() = user_id);