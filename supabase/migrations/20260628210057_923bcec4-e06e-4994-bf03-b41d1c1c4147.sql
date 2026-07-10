
-- ============================================================
-- Step 1: immutable cost_history table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.cost_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  listing_id    uuid NULL,
  asin          text NULL,
  sku           text NULL,
  cost          numeric NOT NULL,
  effective_date date NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  source        text NOT NULL DEFAULT 'created_listings_edit',
  prev_cost     numeric NULL
);

GRANT SELECT, INSERT ON public.cost_history TO authenticated;
GRANT ALL ON public.cost_history TO service_role;

ALTER TABLE public.cost_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own cost_history"
  ON public.cost_history FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "service role manage cost_history"
  ON public.cost_history FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_cost_history_user_asin_eff
  ON public.cost_history(user_id, asin, effective_date DESC, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_history_user_sku_eff
  ON public.cost_history(user_id, sku, effective_date DESC, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_history_listing
  ON public.cost_history(listing_id, recorded_at DESC);

-- ============================================================
-- Step 2: trigger — every cost-related change writes a new row
-- ============================================================
CREATE OR REPLACE FUNCTION public.created_listings_log_cost_history()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_unit_new numeric;
  v_unit_old numeric;
  v_eff date;
BEGIN
  v_unit_new := CASE
    WHEN COALESCE(NEW.amount,0) > 0 THEN NEW.amount
    WHEN COALESCE(NEW.cost,0) > 0 AND COALESCE(NEW.units,0) > 0 THEN NEW.cost / NEW.units
    ELSE NULL
  END;

  IF TG_OP = 'UPDATE' THEN
    v_unit_old := CASE
      WHEN COALESCE(OLD.amount,0) > 0 THEN OLD.amount
      WHEN COALESCE(OLD.cost,0) > 0 AND COALESCE(OLD.units,0) > 0 THEN OLD.cost / OLD.units
      ELSE NULL
    END;
    IF v_unit_new IS NULL OR v_unit_new <= 0 THEN RETURN NEW; END IF;
    IF v_unit_old IS NOT DISTINCT FROM v_unit_new
       AND OLD.date_created IS NOT DISTINCT FROM NEW.date_created THEN
      RETURN NEW;
    END IF;
  ELSE
    IF v_unit_new IS NULL OR v_unit_new <= 0 THEN RETURN NEW; END IF;
  END IF;

  v_eff := GREATEST(
    COALESCE(NEW.date_created, NEW.created_at::date),
    -- Effective date can never precede the moment we recorded it.
    -- For brand-new rows this is created_at; for edits it's now().
    CASE WHEN TG_OP = 'INSERT' THEN NEW.created_at::date ELSE now()::date END
  );

  INSERT INTO public.cost_history
    (user_id, listing_id, asin, sku, cost, effective_date, recorded_at, source, prev_cost)
  VALUES
    (NEW.user_id, NEW.id, NEW.asin, NEW.sku, v_unit_new, v_eff, now(),
     CASE WHEN TG_OP='INSERT' THEN 'created_listings_insert' ELSE 'created_listings_edit' END,
     v_unit_old);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_created_listings_cost_history ON public.created_listings;
CREATE TRIGGER trg_created_listings_cost_history
AFTER INSERT OR UPDATE OF cost, amount, units, date_created
ON public.created_listings
FOR EACH ROW
EXECUTE FUNCTION public.created_listings_log_cost_history();

-- ============================================================
-- Step 3: baseline backfill — one row per current listing,
-- using the row's own date_created/created_at as the effective_date
-- and created_at as recorded_at. This gives the resolver a
-- starting point that respects original cost timing.
-- (Future cost edits will append new rows.)
-- ============================================================
INSERT INTO public.cost_history
  (user_id, listing_id, asin, sku, cost, effective_date, recorded_at, source, prev_cost)
SELECT
  cl.user_id,
  cl.id,
  cl.asin,
  cl.sku,
  CASE
    WHEN COALESCE(cl.amount,0) > 0 THEN cl.amount
    WHEN COALESCE(cl.cost,0) > 0 AND COALESCE(cl.units,0) > 0 THEN cl.cost / cl.units
    ELSE NULL
  END AS unit_cost,
  COALESCE(cl.date_created, cl.created_at::date) AS effective_date,
  cl.created_at AS recorded_at,
  'baseline_backfill_v1' AS source,
  NULL
FROM public.created_listings cl
WHERE
  (COALESCE(cl.amount,0) > 0 OR (COALESCE(cl.cost,0) > 0 AND COALESCE(cl.units,0) > 0))
  AND NOT EXISTS (
    SELECT 1 FROM public.cost_history h WHERE h.listing_id = cl.id
  );

-- ============================================================
-- Step 4: updated resolver RPC
-- New top historical tier: cost_history (strict — recorded_at <= order_date).
-- Existing created_listings tier gets strict 3-clause guard:
--   date_created <= order_date
--   AND created_at::date <= order_date
--   AND updated_at::date <= order_date
-- ============================================================
CREATE OR REPLACE FUNCTION public.resolve_unit_cost_v1(
  p_user_id uuid, p_asin text, p_sku text, p_order_date date,
  p_snapshot_unit_cost numeric DEFAULT NULL::numeric
)
RETURNS TABLE(unit_cost numeric, source text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_cost numeric;
  v_source text;
  v_valid_asin boolean := p_asin IS NOT NULL AND btrim(p_asin) <> '' AND p_asin <> 'PENDING' AND p_asin <> 'UNKNOWN';
  v_valid_sku  boolean := p_sku  IS NOT NULL AND btrim(p_sku)  <> '';
BEGIN
  -- 1. Locked sale-time snapshot wins.
  IF COALESCE(p_snapshot_unit_cost, 0) > 0 THEN
    RETURN QUERY SELECT round(p_snapshot_unit_cost::numeric, 2), 'salesOrders'::text;
    RETURN;
  END IF;

  -- 2. Manual override (date-aware).
  IF v_valid_asin AND p_order_date IS NOT NULL THEN
    SELECT o.unit_cost INTO v_cost
    FROM public.asin_cost_overrides o
    WHERE o.user_id = p_user_id AND o.asin = p_asin AND o.effective_from <= p_order_date
    ORDER BY o.effective_from DESC LIMIT 1;
    IF COALESCE(v_cost, 0) > 0 THEN
      RETURN QUERY SELECT round(v_cost::numeric, 2), 'manualOverride'::text;
      RETURN;
    END IF;
  END IF;

  -- 3a. Immutable cost_history (preferred). Strict: effective_date AND recorded_at both <= order_date.
  IF p_order_date IS NOT NULL AND (v_valid_sku OR v_valid_asin) THEN
    SELECT h.cost, 'costHistory'::text
      INTO v_cost, v_source
    FROM public.cost_history h
    WHERE h.user_id = p_user_id
      AND h.cost > 0
      AND h.effective_date <= p_order_date
      AND h.recorded_at::date <= p_order_date
      AND (
        (v_valid_sku  AND h.sku  = p_sku)
        OR (v_valid_asin AND h.asin = p_asin)
      )
    ORDER BY
      CASE WHEN v_valid_sku AND h.sku = p_sku THEN 0 ELSE 1 END,
      h.effective_date DESC,
      h.recorded_at DESC
    LIMIT 1;
    IF COALESCE(v_cost, 0) > 0 THEN
      RETURN QUERY SELECT round(v_cost::numeric, 2), v_source;
      RETURN;
    END IF;
  END IF;

  -- 3b. Purchase batches + created_listings unified timeline, with STRICT 3-clause guard on listings.
  IF p_order_date IS NOT NULL AND (v_valid_sku OR v_valid_asin) THEN
    WITH cost_candidates AS (
      SELECT
        p.unit_cost::numeric AS candidate_cost,
        CASE WHEN v_valid_sku AND cl.sku = p_sku THEN 0 ELSE 1 END AS match_rank,
        p.purchase_date AS cost_ts,
        p.created_at AS created_ts,
        p.id::text AS stable_id,
        0 AS tie_rank,
        'purchaseBatch'::text AS candidate_source
      FROM public.created_listing_purchases p
      JOIN public.created_listings cl ON cl.id = p.listing_id
      WHERE p.user_id = p_user_id AND cl.user_id = p_user_id
        AND p.unit_cost > 0
        AND p.purchase_date < (p_order_date::timestamp with time zone + interval '1 day')
        AND ((v_valid_sku AND cl.sku = p_sku) OR (v_valid_asin AND cl.asin = p_asin))

      UNION ALL

      SELECT
        CASE
          WHEN COALESCE(cl.amount,0) > 0 THEN cl.amount
          WHEN COALESCE(cl.cost,0) > 0 AND COALESCE(cl.units,0) > 0 THEN cl.cost / cl.units
          ELSE NULL
        END::numeric AS candidate_cost,
        CASE WHEN v_valid_sku AND cl.sku = p_sku THEN 0 ELSE 1 END AS match_rank,
        COALESCE(cl.date_created::timestamp with time zone, cl.created_at) AS cost_ts,
        cl.created_at AS created_ts,
        cl.id::text AS stable_id,
        1 AS tie_rank,
        'listingsHistorical'::text AS candidate_source
      FROM public.created_listings cl
      WHERE cl.user_id = p_user_id
        AND ((v_valid_sku AND cl.sku = p_sku) OR (v_valid_asin AND cl.asin = p_asin))
        -- STRICT 3-clause guard
        AND COALESCE(cl.date_created, cl.created_at::date) <= p_order_date
        AND cl.created_at::date <= p_order_date
        AND cl.updated_at::date <= p_order_date
        AND (COALESCE(cl.amount,0) > 0 OR (COALESCE(cl.cost,0) > 0 AND COALESCE(cl.units,0) > 0))
    )
    SELECT c.candidate_cost, c.candidate_source INTO v_cost, v_source
    FROM cost_candidates c WHERE COALESCE(c.candidate_cost,0) > 0
    ORDER BY c.match_rank ASC, c.cost_ts DESC NULLS LAST, c.created_ts DESC NULLS LAST,
             c.tie_rank ASC, c.stable_id DESC
    LIMIT 1;
    IF COALESCE(v_cost,0) > 0 THEN
      RETURN QUERY SELECT round(v_cost::numeric, 2), COALESCE(v_source,'listingsHistorical')::text;
      RETURN;
    END IF;
  END IF;

  -- 4. Legacy no-date fallback: newest listing.
  IF p_order_date IS NULL AND (v_valid_sku OR v_valid_asin) THEN
    SELECT CASE
      WHEN COALESCE(cl.amount,0) > 0 THEN cl.amount
      WHEN COALESCE(cl.cost,0) > 0 AND COALESCE(cl.units,0) > 0 THEN cl.cost / cl.units
      ELSE NULL
    END INTO v_cost
    FROM public.created_listings cl
    WHERE cl.user_id = p_user_id
      AND ((v_valid_sku AND cl.sku = p_sku) OR (v_valid_asin AND cl.asin = p_asin))
      AND (COALESCE(cl.amount,0) > 0 OR (COALESCE(cl.cost,0) > 0 AND COALESCE(cl.units,0) > 0))
    ORDER BY COALESCE(cl.date_created, cl.created_at::date) DESC, cl.created_at DESC
    LIMIT 1;
    IF COALESCE(v_cost,0) > 0 THEN
      RETURN QUERY SELECT round(v_cost::numeric, 2), 'listingsFallback'::text;
      RETURN;
    END IF;
  END IF;

  -- 5. Current inventory final fallback.
  SELECT CASE
    WHEN COALESCE(i.amount,0) > 0 THEN i.amount
    WHEN COALESCE(i.cost,0) > 0 AND COALESCE(i.units,0) > 0 THEN i.cost / i.units
    ELSE NULL
  END INTO v_cost
  FROM public.inventory i
  WHERE i.user_id = p_user_id
    AND ((v_valid_sku AND i.sku = p_sku) OR (v_valid_asin AND i.asin = p_asin))
  LIMIT 1;
  IF COALESCE(v_cost,0) > 0 THEN
    RETURN QUERY SELECT round(v_cost::numeric, 2), 'inventoryFallback'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT 0::numeric, 'unresolved'::text;
END;
$function$;
