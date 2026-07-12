
-- Table to store "new seller detected" (hijacker) alerts.
-- Same shape/conventions as bb_price_alerts (see 20260216221549_...sql).
CREATE TABLE public.hijacker_alerts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  asin text NOT NULL,
  sku text,
  marketplace text NOT NULL DEFAULT 'US',
  new_seller_id text NOT NULL,
  new_seller_name text,
  previous_seller_count integer,
  new_seller_count integer,
  seen boolean NOT NULL DEFAULT false,
  dismissed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for fast querying
CREATE INDEX idx_hijacker_alerts_user_created ON public.hijacker_alerts (user_id, created_at DESC);
CREATE INDEX idx_hijacker_alerts_dedup ON public.hijacker_alerts (user_id, asin, marketplace);

-- Enable RLS
ALTER TABLE public.hijacker_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own hijacker alerts"
  ON public.hijacker_alerts
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Trigger function: auto-create alert when a seller_id appears in offers_json
-- that wasn't present in the previous snapshot for the same ASIN/marketplace.
CREATE OR REPLACE FUNCTION public.fn_detect_new_seller()
RETURNS TRIGGER AS $$
DECLARE
  v_prev_offers jsonb;
  v_prev_seller_ids text[];
  v_new_seller_ids text[];
  v_added_seller_ids text[];
  v_prev_count integer;
  v_new_count integer;
  v_sku text;
  v_seller_id text;
  v_seller_name text;
  v_existing_alert_id uuid;
BEGIN
  -- Skip if no offers on the new snapshot
  IF NEW.offers_json IS NULL OR jsonb_typeof(NEW.offers_json) != 'array' THEN
    RETURN NEW;
  END IF;

  -- Distinct, non-empty seller_ids in the new snapshot
  SELECT array_agg(DISTINCT elem->>'seller_id')
  INTO v_new_seller_ids
  FROM jsonb_array_elements(NEW.offers_json) elem
  WHERE elem->>'seller_id' IS NOT NULL AND elem->>'seller_id' != '';

  IF v_new_seller_ids IS NULL THEN
    RETURN NEW;
  END IF;

  -- Previous snapshot for the same ASIN/marketplace, within the last 4 hours
  -- (same freshness window as fn_detect_bb_drop, to avoid diffing against
  -- stale data after a long gap in fetching).
  SELECT s.offers_json INTO v_prev_offers
  FROM public.repricer_competitor_snapshots s
  WHERE s.user_id = NEW.user_id
    AND s.asin = NEW.asin
    AND s.marketplace = NEW.marketplace
    AND s.id != NEW.id
    AND s.offers_json IS NOT NULL
    AND s.fetched_at > (now() - interval '4 hours')
  ORDER BY s.fetched_at DESC
  LIMIT 1;

  -- No previous snapshot to compare against yet (first fetch, or gap > 4h) —
  -- nothing to diff, and we don't want to alert on every seller on cold start.
  IF v_prev_offers IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT array_agg(DISTINCT elem->>'seller_id')
  INTO v_prev_seller_ids
  FROM jsonb_array_elements(v_prev_offers) elem
  WHERE elem->>'seller_id' IS NOT NULL AND elem->>'seller_id' != '';

  -- Sellers present now but absent from the previous snapshot
  SELECT array_agg(sid) INTO v_added_seller_ids
  FROM unnest(v_new_seller_ids) sid
  WHERE sid != ALL (COALESCE(v_prev_seller_ids, ARRAY[]::text[]));

  IF v_added_seller_ids IS NULL OR array_length(v_added_seller_ids, 1) = 0 THEN
    RETURN NEW;
  END IF;

  v_prev_count := COALESCE(array_length(v_prev_seller_ids, 1), 0);
  v_new_count := COALESCE(array_length(v_new_seller_ids, 1), 0);

  -- SKU for context (best-effort, from an active assignment)
  SELECT a.sku INTO v_sku
  FROM public.repricer_assignments a
  WHERE a.user_id = NEW.user_id
    AND a.asin = NEW.asin
    AND a.marketplace = NEW.marketplace
    AND a.is_enabled = true
  LIMIT 1;

  -- One alert row per newly-appeared seller. Dedup: skip a seller_id that
  -- already has an undismissed alert for this ASIN in the last 24h, so a
  -- persistent hijacker doesn't spam a new row on every repricer cycle.
  FOREACH v_seller_id IN ARRAY v_added_seller_ids LOOP
    SELECT id INTO v_existing_alert_id
    FROM public.hijacker_alerts
    WHERE user_id = NEW.user_id
      AND asin = NEW.asin
      AND marketplace = NEW.marketplace
      AND new_seller_id = v_seller_id
      AND dismissed = false
      AND created_at > (now() - interval '24 hours')
    LIMIT 1;

    IF v_existing_alert_id IS NOT NULL THEN
      CONTINUE;
    END IF;

    SELECT elem->>'seller_name' INTO v_seller_name
    FROM jsonb_array_elements(NEW.offers_json) elem
    WHERE elem->>'seller_id' = v_seller_id
    LIMIT 1;

    INSERT INTO public.hijacker_alerts (
      user_id, asin, sku, marketplace,
      new_seller_id, new_seller_name,
      previous_seller_count, new_seller_count
    ) VALUES (
      NEW.user_id, NEW.asin, v_sku, NEW.marketplace,
      v_seller_id, v_seller_name,
      v_prev_count, v_new_count
    );
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Attach trigger to competitor snapshots
CREATE TRIGGER trg_detect_new_seller
  AFTER INSERT ON public.repricer_competitor_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_detect_new_seller();
