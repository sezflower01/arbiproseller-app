
-- Table to store Buy Box price drop alerts
CREATE TABLE public.bb_price_alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  asin text NOT NULL,
  sku text,
  marketplace text NOT NULL DEFAULT 'US',
  bb_before numeric,
  bb_now numeric,
  drop_abs numeric,
  drop_pct numeric,
  my_price numeric,
  snapshot_id uuid,
  seen boolean NOT NULL DEFAULT false,
  dismissed boolean NOT NULL DEFAULT false,
  acted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for fast querying
CREATE INDEX idx_bb_price_alerts_user_created ON public.bb_price_alerts (user_id, created_at DESC);
CREATE INDEX idx_bb_price_alerts_dedup ON public.bb_price_alerts (user_id, asin, marketplace);

-- Enable RLS
ALTER TABLE public.bb_price_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own bb alerts"
  ON public.bb_price_alerts
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Trigger function: auto-create alert when BB drops on snapshot insert
CREATE OR REPLACE FUNCTION public.fn_detect_bb_drop()
RETURNS TRIGGER AS $$
DECLARE
  v_prev_bb numeric;
  v_my_price numeric;
  v_sku text;
  v_drop_abs numeric;
  v_drop_pct numeric;
  v_threshold_abs numeric := 0.02;  -- $0.02 default
  v_threshold_pct numeric := 0.5;   -- 0.5% default
  v_last_alert_bb numeric;
BEGIN
  -- Skip if no buybox price in new snapshot
  IF NEW.buybox_price IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get previous snapshot's BB price (within last 4 hours)
  SELECT s.buybox_price INTO v_prev_bb
  FROM public.repricer_competitor_snapshots s
  WHERE s.user_id = NEW.user_id
    AND s.asin = NEW.asin
    AND s.marketplace = NEW.marketplace
    AND s.id != NEW.id
    AND s.buybox_price IS NOT NULL
    AND s.fetched_at > (now() - interval '4 hours')
  ORDER BY s.fetched_at DESC
  LIMIT 1;

  -- No previous data to compare
  IF v_prev_bb IS NULL THEN
    RETURN NEW;
  END IF;

  -- Calculate drop
  v_drop_abs := v_prev_bb - NEW.buybox_price;
  IF v_prev_bb > 0 THEN
    v_drop_pct := (v_drop_abs / v_prev_bb) * 100;
  ELSE
    v_drop_pct := 0;
  END IF;

  -- Only alert on drops (not increases)
  IF v_drop_abs < v_threshold_abs AND v_drop_pct < v_threshold_pct THEN
    RETURN NEW;
  END IF;

  -- Dedup: check last alert for this ASIN - only alert if BB dropped FURTHER
  SELECT bb_now INTO v_last_alert_bb
  FROM public.bb_price_alerts
  WHERE user_id = NEW.user_id
    AND asin = NEW.asin
    AND marketplace = NEW.marketplace
    AND dismissed = false
    AND created_at > (now() - interval '2 hours')
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_last_alert_bb IS NOT NULL AND NEW.buybox_price >= v_last_alert_bb THEN
    -- BB hasn't dropped further since last alert, skip
    RETURN NEW;
  END IF;

  -- Get user's current price and SKU from assignment
  SELECT a.sku, 
         COALESCE(a.last_applied_price, i.my_price, i.price)
  INTO v_sku, v_my_price
  FROM public.repricer_assignments a
  LEFT JOIN public.inventory i ON i.asin = a.asin AND i.user_id = a.user_id
  WHERE a.user_id = NEW.user_id
    AND a.asin = NEW.asin
    AND a.marketplace = NEW.marketplace
    AND a.is_enabled = true
  LIMIT 1;

  -- Insert alert
  INSERT INTO public.bb_price_alerts (
    user_id, asin, sku, marketplace,
    bb_before, bb_now, drop_abs, drop_pct,
    my_price, snapshot_id
  ) VALUES (
    NEW.user_id, NEW.asin, v_sku, NEW.marketplace,
    v_prev_bb, NEW.buybox_price, v_drop_abs, v_drop_pct,
    v_my_price, NEW.id
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Attach trigger to competitor snapshots
CREATE TRIGGER trg_detect_bb_drop
  AFTER INSERT ON public.repricer_competitor_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_detect_bb_drop();

-- Auto-cleanup: delete alerts older than 7 days (optional manual cleanup)
