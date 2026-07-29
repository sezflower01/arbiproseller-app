-- Fix fn_detect_new_seller firing a false "new seller" alert storm when the
-- "previous" snapshot it compares against is internally inconsistent: some
-- older snapshot-writers stored offers_count > 0 while offers_json was an
-- empty array (a parsing/throttle artifact, not a genuine "zero sellers"
-- read). The trigger read that as "0 sellers previously", so every real
-- seller in the next good snapshot looked like a brand-new hijacker,
-- creating one alert row per seller (confirmed live: 18 simultaneous
-- alerts for a single ASIN, all "Unknown Seller" since Amazon's Offers
-- array often omits seller_name, making genuinely-distinct alerts look
-- like duplicate spam in the UI).
--
-- Fix: exclude a candidate "previous" snapshot from consideration entirely
-- when it's self-evidently corrupt (offers_count > 0 but offers_json is an
-- empty array), instead of trusting its empty array as a real baseline. If
-- no other snapshot exists in the 4h freshness window, the trigger already
-- falls back to its existing "no previous snapshot -> skip" safe path.
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
  -- stale data after a long gap in fetching). Excludes self-evidently
  -- corrupt rows (offers_count > 0 but offers_json empty) so a parsing
  -- artifact never gets trusted as a real "zero sellers" baseline.
  SELECT s.offers_json INTO v_prev_offers
  FROM public.repricer_competitor_snapshots s
  WHERE s.user_id = NEW.user_id
    AND s.asin = NEW.asin
    AND s.marketplace = NEW.marketplace
    AND s.id != NEW.id
    AND s.offers_json IS NOT NULL
    AND NOT (jsonb_array_length(s.offers_json) = 0 AND COALESCE(s.offers_count, 0) > 0)
    AND s.fetched_at > (now() - interval '4 hours')
  ORDER BY s.fetched_at DESC
  LIMIT 1;

  -- No previous snapshot to compare against yet (first fetch, gap > 4h, or
  -- only corrupt candidates in the window) — nothing trustworthy to diff,
  -- and we don't want to alert on every seller on cold start.
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
