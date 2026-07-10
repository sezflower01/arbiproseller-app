CREATE TABLE public.mobile_scan_cost_memory (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  barcode TEXT,
  asin TEXT,
  total_cost NUMERIC,
  units INTEGER,
  sale_price_override NUMERIC,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.mobile_scan_cost_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users select own scan cost memory"
ON public.mobile_scan_cost_memory FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users insert own scan cost memory"
ON public.mobile_scan_cost_memory FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own scan cost memory"
ON public.mobile_scan_cost_memory FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users delete own scan cost memory"
ON public.mobile_scan_cost_memory FOR DELETE
USING (auth.uid() = user_id);

CREATE UNIQUE INDEX mobile_scan_cost_memory_user_barcode_uniq
  ON public.mobile_scan_cost_memory (user_id, barcode)
  WHERE barcode IS NOT NULL;

CREATE UNIQUE INDEX mobile_scan_cost_memory_user_asin_uniq
  ON public.mobile_scan_cost_memory (user_id, asin)
  WHERE barcode IS NULL AND asin IS NOT NULL;

CREATE INDEX mobile_scan_cost_memory_user_idx
  ON public.mobile_scan_cost_memory (user_id);

CREATE TRIGGER update_mobile_scan_cost_memory_updated_at
BEFORE UPDATE ON public.mobile_scan_cost_memory
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();