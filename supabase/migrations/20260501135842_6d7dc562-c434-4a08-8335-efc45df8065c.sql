CREATE TABLE public.mobile_scan_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  barcode text NOT NULL,
  barcode_format text,
  asin text,
  title text,
  image_url text,
  brand text,
  price numeric,
  currency text,
  marketplace text DEFAULT 'US',
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_mobile_scan_history_user_created ON public.mobile_scan_history (user_id, created_at DESC);
CREATE INDEX idx_mobile_scan_history_barcode ON public.mobile_scan_history (user_id, barcode);

ALTER TABLE public.mobile_scan_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own scans"
  ON public.mobile_scan_history FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own scans"
  ON public.mobile_scan_history FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own scans"
  ON public.mobile_scan_history FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own scans"
  ON public.mobile_scan_history FOR DELETE
  USING (auth.uid() = user_id);