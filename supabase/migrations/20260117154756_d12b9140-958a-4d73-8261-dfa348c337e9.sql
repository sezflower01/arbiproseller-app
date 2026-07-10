-- Table to store ROI snapshots for alerts (single source of truth)
CREATE TABLE public.roi_alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  order_date date NOT NULL,
  asin text NOT NULL,
  title text,
  image_url text,
  units integer NOT NULL DEFAULT 1,
  sales_total numeric NOT NULL DEFAULT 0,
  fees_total numeric NOT NULL DEFAULT 0,
  cog_total numeric NOT NULL DEFAULT 0,
  roi numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  order_ids text[] DEFAULT '{}',
  seen boolean NOT NULL DEFAULT false,
  email_sent boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  
  -- Unique constraint: one row per user + date + asin
  CONSTRAINT roi_alerts_user_date_asin_key UNIQUE (user_id, order_date, asin)
);

-- Enable RLS
ALTER TABLE public.roi_alerts ENABLE ROW LEVEL SECURITY;

-- Users can manage their own ROI alerts
CREATE POLICY "Users can manage their own ROI alerts"
ON public.roi_alerts
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Index for fast notification queries
CREATE INDEX idx_roi_alerts_user_date_roi ON public.roi_alerts (user_id, order_date, roi);
CREATE INDEX idx_roi_alerts_user_unseen ON public.roi_alerts (user_id, seen) WHERE seen = false;

-- Trigger for updated_at
CREATE TRIGGER update_roi_alerts_updated_at
BEFORE UPDATE ON public.roi_alerts
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();