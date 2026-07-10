
CREATE TABLE public.extracted_product_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  url TEXT NOT NULL,
  domain TEXT,
  title TEXT,
  price_current NUMERIC,
  price_original NUMERIC,
  currency TEXT,
  availability TEXT,
  image_url TEXT,
  variant TEXT,
  extraction_method TEXT,
  confidence_score NUMERIC,
  raw_price_text TEXT,
  raw_payload JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_epd_user_created ON public.extracted_product_data (user_id, created_at DESC);
CREATE INDEX idx_epd_user_url ON public.extracted_product_data (user_id, url);

ALTER TABLE public.extracted_product_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own extractions"
  ON public.extracted_product_data FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own extractions"
  ON public.extracted_product_data FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own extractions"
  ON public.extracted_product_data FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own extractions"
  ON public.extracted_product_data FOR DELETE
  USING (auth.uid() = user_id);

CREATE TRIGGER trg_epd_updated_at
  BEFORE UPDATE ON public.extracted_product_data
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
