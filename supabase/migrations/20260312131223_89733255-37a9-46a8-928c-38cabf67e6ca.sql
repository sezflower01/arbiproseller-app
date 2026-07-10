
-- Enhance fn_detect_bb_drop to also mark the repricer_assignment as needing immediate priority evaluation
-- by setting last_price_change_at = now() which the cron-trigger uses for HOT classification
CREATE OR REPLACE FUNCTION public.fn_detect_bb_drop()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prev_bb numeric;
  v_my_price numeric;
  v_sku text;
  v_drop_abs numeric;
  v_drop_pct numeric;
  v_threshold_abs numeric := 0.02;
  v_threshold_pct numeric := 0.5;
  v_last_alert_bb numeric;
BEGIN
  IF NEW.buybox_price IS NULL THEN
    RETURN NEW;
  END IF;

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

  IF v_prev_bb IS NULL THEN
    RETURN NEW;
  END IF;

  v_drop_abs := v_prev_bb - NEW.buybox_price;
  IF v_prev_bb > 0 THEN
    v_drop_pct := (v_drop_abs / v_prev_bb) * 100;
  ELSE
    v_drop_pct := 0;
  END IF;

  IF v_drop_abs < v_threshold_abs AND v_drop_pct < v_threshold_pct THEN
    RETURN NEW;
  END IF;

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
    RETURN NEW;
  END IF;

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

  INSERT INTO public.bb_price_alerts (
    user_id, asin, sku, marketplace,
    bb_before, bb_now, drop_abs, drop_pct,
    my_price, snapshot_id
  ) VALUES (
    NEW.user_id, NEW.asin, v_sku, NEW.marketplace,
    v_prev_bb, NEW.buybox_price, v_drop_abs, v_drop_pct,
    v_my_price, NEW.id
  );

  -- EVENT-DRIVEN FAST PATH: Mark assignment for immediate HOT tier classification
  -- Setting last_price_change_at triggers the cron-trigger to classify this ASIN as HOT
  UPDATE public.repricer_assignments
  SET last_price_change_at = now(),
      buybox_lost_at = CASE 
        WHEN last_buybox_status = 'owned' THEN now()
        ELSE buybox_lost_at
      END
  WHERE user_id = NEW.user_id
    AND asin = NEW.asin
    AND marketplace = NEW.marketplace
    AND is_enabled = true;

  RETURN NEW;
END;
$function$;
