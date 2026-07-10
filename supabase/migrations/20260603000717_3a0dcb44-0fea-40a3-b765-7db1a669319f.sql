ALTER TABLE public.live_sales_summary
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.live_sales_today_by_asin
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();