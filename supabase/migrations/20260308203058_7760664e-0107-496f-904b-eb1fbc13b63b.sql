
-- ============================================================
-- 1. sales_correction_history: real delta persistence
-- ============================================================
CREATE TABLE public.sales_correction_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  order_id TEXT NOT NULL,
  asin TEXT NOT NULL DEFAULT '',
  sku TEXT,
  marketplace TEXT,
  correction_type TEXT NOT NULL, -- 'price_upgrade', 'fee_upgrade', 'price_and_fee'
  previous_price_source TEXT,
  new_price_source TEXT,
  previous_unit_price NUMERIC,
  new_unit_price NUMERIC,
  previous_fee_source TEXT,
  new_fee_source TEXT,
  previous_total_fees NUMERIC,
  new_total_fees NUMERIC,
  previous_profit NUMERIC,
  new_profit NUMERIC,
  revenue_delta NUMERIC DEFAULT 0,
  fee_delta NUMERIC DEFAULT 0,
  profit_delta NUMERIC DEFAULT 0,
  sync_trace_id UUID,
  corrected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_correction_history_user_date ON public.sales_correction_history (user_id, corrected_at);
CREATE INDEX idx_correction_history_order ON public.sales_correction_history (user_id, order_id);

ALTER TABLE public.sales_correction_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own correction history"
  ON public.sales_correction_history FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- ============================================================
-- 2. sync_traces: end-to-end sync traceability
-- ============================================================
CREATE TABLE public.sync_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  sync_type TEXT NOT NULL, -- 'unified', 'financial_events', 'refunds', 'enrichment', 'historical', 'repair'
  phase TEXT, -- 'orders', 'snapshots', 'fees', 'settlements', etc.
  status TEXT NOT NULL DEFAULT 'started', -- 'started', 'completed', 'failed'
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  rows_fetched INT DEFAULT 0,
  rows_inserted INT DEFAULT 0,
  rows_updated INT DEFAULT 0,
  duplicates_skipped INT DEFAULT 0,
  rows_corrected INT DEFAULT 0,
  rows_missing_price INT DEFAULT 0,
  rows_missing_fees INT DEFAULT 0,
  error_count INT DEFAULT 0,
  retry_count INT DEFAULT 0,
  error_message TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_traces_user ON public.sync_traces (user_id, started_at DESC);
CREATE INDEX idx_sync_traces_type ON public.sync_traces (user_id, sync_type, started_at DESC);

ALTER TABLE public.sync_traces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own sync traces"
  ON public.sync_traces FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Service role can insert (edge functions)
CREATE POLICY "Service can insert sync traces"
  ON public.sync_traces FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ============================================================
-- 3. Trigger: auto-capture corrections on sales_orders updates
-- ============================================================
CREATE OR REPLACE FUNCTION public.fn_capture_sales_correction()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $$
DECLARE
  v_price_changed BOOLEAN := FALSE;
  v_fee_changed BOOLEAN := FALSE;
  v_correction_type TEXT;
  v_old_price NUMERIC;
  v_new_price NUMERIC;
  v_old_fees NUMERIC;
  v_new_fees NUMERIC;
BEGIN
  -- Only track meaningful transitions (estimated/snapshot → actual)
  v_old_price := COALESCE(OLD.sold_price, 0);
  v_new_price := COALESCE(NEW.sold_price, 0);
  v_old_fees := COALESCE(OLD.total_fees, 0);
  v_new_fees := COALESCE(NEW.total_fees, 0);

  -- Check if price source upgraded
  IF (OLD.price_source IS DISTINCT FROM NEW.price_source)
     AND NEW.price_source IN ('actual', 'settled', 'fees_api')
     AND (OLD.price_source IS NULL OR OLD.price_source IN ('estimated', 'snapshot', 'inventory', 'fallback'))
     AND ABS(v_new_price - v_old_price) > 0.005 THEN
    v_price_changed := TRUE;
  END IF;

  -- Check if fees upgraded
  IF (OLD.fees_source IS DISTINCT FROM NEW.fees_source)
     AND NEW.fees_source IN ('actual', 'settled', 'fees_api', 'from_cache')
     AND (OLD.fees_source IS NULL OR OLD.fees_source IN ('unavailable', 'estimated', 'cache'))
     AND ABS(v_new_fees - v_old_fees) > 0.005 THEN
    v_fee_changed := TRUE;
  END IF;

  IF NOT v_price_changed AND NOT v_fee_changed THEN
    RETURN NEW;
  END IF;

  IF v_price_changed AND v_fee_changed THEN
    v_correction_type := 'price_and_fee';
  ELSIF v_price_changed THEN
    v_correction_type := 'price_upgrade';
  ELSE
    v_correction_type := 'fee_upgrade';
  END IF;

  INSERT INTO public.sales_correction_history (
    user_id, order_id, asin, sku, marketplace,
    correction_type,
    previous_price_source, new_price_source,
    previous_unit_price, new_unit_price,
    previous_fee_source, new_fee_source,
    previous_total_fees, new_total_fees,
    revenue_delta, fee_delta, profit_delta,
    corrected_at
  ) VALUES (
    NEW.user_id, NEW.order_id, COALESCE(NEW.asin, ''), NEW.seller_sku, NEW.marketplace,
    v_correction_type,
    OLD.price_source, NEW.price_source,
    v_old_price, v_new_price,
    OLD.fees_source, NEW.fees_source,
    v_old_fees, v_new_fees,
    (v_new_price - v_old_price) * COALESCE(NEW.quantity, 1),
    (v_new_fees - v_old_fees) * COALESCE(NEW.quantity, 1),
    ((v_new_price - v_old_price) - (v_new_fees - v_old_fees)) * COALESCE(NEW.quantity, 1),
    now()
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_correction_capture
  AFTER UPDATE ON public.sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_capture_sales_correction();
