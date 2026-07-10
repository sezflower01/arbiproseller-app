-- Add summary fields to source_discovery_runs
ALTER TABLE public.source_discovery_runs
  ADD COLUMN IF NOT EXISTS top_valid_price numeric,
  ADD COLUMN IF NOT EXISTS top_valid_url text,
  ADD COLUMN IF NOT EXISTS top_valid_domain text,
  ADD COLUMN IF NOT EXISTS qa_batch_id uuid;

CREATE INDEX IF NOT EXISTS idx_sdr_qa_batch ON public.source_discovery_runs(qa_batch_id) WHERE qa_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sdr_user_created ON public.source_discovery_runs(user_id, created_at DESC);

-- Saved sources (per-ASIN, per-user)
CREATE TABLE IF NOT EXISTS public.saved_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asin text NOT NULL,
  source_url text NOT NULL,
  domain text,
  price numeric,
  currency text DEFAULT 'USD',
  source_title text,
  source_image text,
  notes text,
  candidate_id uuid,
  run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, asin, source_url)
);

CREATE INDEX IF NOT EXISTS idx_saved_sources_user_asin ON public.saved_sources(user_id, asin);

ALTER TABLE public.saved_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own saved sources"
  ON public.saved_sources FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own saved sources"
  ON public.saved_sources FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own saved sources"
  ON public.saved_sources FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own saved sources"
  ON public.saved_sources FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER update_saved_sources_updated_at
  BEFORE UPDATE ON public.saved_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- QA batches
CREATE TABLE IF NOT EXISTS public.supplier_qa_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text,
  total_asins integer NOT NULL DEFAULT 0,
  completed_asins integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qa_batches_user_created ON public.supplier_qa_batches(user_id, created_at DESC);

ALTER TABLE public.supplier_qa_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own qa batches"
  ON public.supplier_qa_batches FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own qa batches"
  ON public.supplier_qa_batches FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own qa batches"
  ON public.supplier_qa_batches FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own qa batches"
  ON public.supplier_qa_batches FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER update_qa_batches_updated_at
  BEFORE UPDATE ON public.supplier_qa_batches
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();