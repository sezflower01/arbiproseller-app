
-- source_discovery_runs
CREATE TABLE public.source_discovery_runs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  amazon_title TEXT,
  brand TEXT,
  model_number TEXT,
  upc TEXT,
  run_type TEXT NOT NULL DEFAULT 'retail',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  total_candidates INTEGER NOT NULL DEFAULT 0,
  extracted_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  unresolved_count INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  needs_review_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_source_discovery_runs_user_created ON public.source_discovery_runs (user_id, created_at DESC);
CREATE INDEX idx_source_discovery_runs_user_asin ON public.source_discovery_runs (user_id, asin);

ALTER TABLE public.source_discovery_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own discovery runs"
  ON public.source_discovery_runs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own discovery runs"
  ON public.source_discovery_runs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own discovery runs"
  ON public.source_discovery_runs FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own discovery runs"
  ON public.source_discovery_runs FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER trg_source_discovery_runs_updated
BEFORE UPDATE ON public.source_discovery_runs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- source_candidates
CREATE TABLE public.source_candidates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES public.source_discovery_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  source_url TEXT NOT NULL,
  domain TEXT,
  source_type TEXT NOT NULL DEFAULT 'retail',
  source_title TEXT,
  source_snippet TEXT,
  match_score INTEGER NOT NULL DEFAULT 0,
  match_reason TEXT,
  -- extractor mirror fields
  phase1_status TEXT,
  phase2_status TEXT,
  block_provider TEXT,
  final_resolution TEXT,
  extraction_method TEXT,
  current_price NUMERIC,
  original_price NUMERIC,
  currency TEXT,
  availability TEXT,
  confidence_score NUMERIC,
  needs_review BOOLEAN,
  review_reasons JSONB,
  image_url TEXT,
  extracted_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_run_source_url UNIQUE (run_id, source_url)
);

CREATE INDEX idx_source_candidates_run ON public.source_candidates (run_id, match_score DESC);
CREATE INDEX idx_source_candidates_user_asin ON public.source_candidates (user_id, asin);

ALTER TABLE public.source_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own candidates"
  ON public.source_candidates FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own candidates"
  ON public.source_candidates FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own candidates"
  ON public.source_candidates FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own candidates"
  ON public.source_candidates FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER trg_source_candidates_updated
BEFORE UPDATE ON public.source_candidates
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
