
-- 1. Sales orders identity columns
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS buyer_id text,
  ADD COLUMN IF NOT EXISTS buyer_email text,
  ADD COLUMN IF NOT EXISTS buyer_name text,
  ADD COLUMN IF NOT EXISTS ship_to_hash text,
  ADD COLUMN IF NOT EXISTS customer_key text;

CREATE INDEX IF NOT EXISTS sales_orders_user_customer_key_idx
  ON public.sales_orders (user_id, customer_key)
  WHERE customer_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS sales_orders_user_buyer_email_idx
  ON public.sales_orders (user_id, buyer_email)
  WHERE buyer_email IS NOT NULL;

-- 2. customer_profiles rollup table
CREATE TABLE IF NOT EXISTS public.customer_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  customer_key text NOT NULL,
  buyer_id text,
  buyer_email text,
  buyer_name text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  orders_count integer NOT NULL DEFAULT 0,
  units_count integer NOT NULL DEFAULT 0,
  revenue_usd numeric(14,2) NOT NULL DEFAULT 0,
  refund_orders_count integer NOT NULL DEFAULT 0,
  refund_amount_usd numeric(14,2) NOT NULL DEFAULT 0,
  replacement_orders_count integer NOT NULL DEFAULT 0,
  distinct_asins_count integer NOT NULL DEFAULT 0,
  distinct_asins text[] NOT NULL DEFAULT '{}',
  order_ids text[] NOT NULL DEFAULT '{}',
  flag_level text NOT NULL DEFAULT 'new',
  last_refreshed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_profiles_user_key_uidx UNIQUE (user_id, customer_key)
);

GRANT SELECT ON public.customer_profiles TO authenticated;
GRANT ALL ON public.customer_profiles TO service_role;

ALTER TABLE public.customer_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own customer profiles"
  ON public.customer_profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Service role manages customer profiles"
  ON public.customer_profiles
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS customer_profiles_user_flag_idx
  ON public.customer_profiles (user_id, flag_level);

CREATE INDEX IF NOT EXISTS customer_profiles_user_last_seen_idx
  ON public.customer_profiles (user_id, last_seen_at DESC);

-- updated_at trigger (reuse existing helper if present)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column' AND pronamespace = 'public'::regnamespace
  ) THEN
    CREATE OR REPLACE FUNCTION public.update_updated_at_column()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = public
    AS $fn$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $fn$;
  END IF;
END $$;

DROP TRIGGER IF EXISTS customer_profiles_touch_updated_at ON public.customer_profiles;
CREATE TRIGGER customer_profiles_touch_updated_at
  BEFORE UPDATE ON public.customer_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 3. resolve_customer_key helper (deterministic identity resolution)
CREATE OR REPLACE FUNCTION public.resolve_customer_key(
  _buyer_id text,
  _buyer_email text,
  _buyer_name text,
  _ship_to_hash text
) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN _buyer_id IS NOT NULL AND length(trim(_buyer_id)) > 0
      THEN 'bid:' || lower(trim(_buyer_id))
    WHEN _buyer_email IS NOT NULL AND length(trim(_buyer_email)) > 0
      THEN 'email:' || lower(trim(_buyer_email))
    WHEN (_buyer_name IS NOT NULL AND length(trim(_buyer_name)) > 0)
     AND (_ship_to_hash IS NOT NULL AND length(trim(_ship_to_hash)) > 0)
      THEN 'nh:' || lower(trim(_buyer_name)) || '|' || _ship_to_hash
    ELSE NULL
  END;
$$;

-- 4. refresh_customer_profile — recompute one buyer's rollup
CREATE OR REPLACE FUNCTION public.refresh_customer_profile(
  _user_id uuid,
  _customer_key text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_first timestamptz;
  v_last  timestamptz;
  v_orders int;
  v_units  int;
  v_revenue numeric(14,2);
  v_refund_orders int;
  v_refund_amt numeric(14,2);
  v_replacement_orders int;
  v_asins text[];
  v_order_ids text[];
  v_buyer_id text;
  v_buyer_email text;
  v_buyer_name text;
  v_flag text;
  v_recent_refunds int;
  v_recent_replacement_units int;
  v_period_revenue numeric(14,2);
  v_period_refunds numeric(14,2);
BEGIN
  IF _customer_key IS NULL THEN RETURN; END IF;

  SELECT
    MIN(order_date), MAX(order_date),
    COUNT(DISTINCT CASE WHEN order_id NOT LIKE '%-REFUND%' THEN order_id END),
    COALESCE(SUM(CASE WHEN order_id NOT LIKE '%-REFUND%' THEN quantity ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN order_id NOT LIKE '%-REFUND%' THEN total_sale_amount ELSE 0 END), 0),
    COUNT(DISTINCT CASE WHEN refund_amount > 0 THEN split_part(order_id,'-REFUND',1) END),
    COALESCE(SUM(refund_amount), 0),
    COUNT(DISTINCT CASE WHEN is_replacement THEN order_id END),
    ARRAY(SELECT DISTINCT asin FROM public.sales_orders
          WHERE user_id = _user_id AND customer_key = _customer_key AND asin IS NOT NULL),
    ARRAY(SELECT DISTINCT split_part(order_id,'-REFUND',1) FROM public.sales_orders
          WHERE user_id = _user_id AND customer_key = _customer_key
          ORDER BY 1),
    MAX(buyer_id), MAX(buyer_email), MAX(buyer_name)
  INTO v_first, v_last, v_orders, v_units, v_revenue,
       v_refund_orders, v_refund_amt, v_replacement_orders,
       v_asins, v_order_ids,
       v_buyer_id, v_buyer_email, v_buyer_name
  FROM public.sales_orders
  WHERE user_id = _user_id AND customer_key = _customer_key;

  IF v_orders IS NULL OR v_orders = 0 THEN
    -- No non-refund orders means we should not keep a profile row (data likely cleared)
    DELETE FROM public.customer_profiles WHERE user_id = _user_id AND customer_key = _customer_key;
    RETURN;
  END IF;

  -- 30d + 90d windows for flag classification
  SELECT COUNT(DISTINCT split_part(order_id,'-REFUND',1))
  INTO v_recent_refunds
  FROM public.sales_orders
  WHERE user_id = _user_id AND customer_key = _customer_key
    AND refund_amount > 0
    AND order_date >= now() - interval '90 days';

  SELECT COALESCE(SUM(quantity), 0)
  INTO v_recent_replacement_units
  FROM public.sales_orders
  WHERE user_id = _user_id AND customer_key = _customer_key
    AND is_replacement = true
    AND order_date >= now() - interval '30 days';

  SELECT
    COALESCE(SUM(CASE WHEN order_id NOT LIKE '%-REFUND%' THEN total_sale_amount ELSE 0 END), 0),
    COALESCE(SUM(refund_amount), 0)
  INTO v_period_revenue, v_period_refunds
  FROM public.sales_orders
  WHERE user_id = _user_id AND customer_key = _customer_key
    AND order_date >= now() - interval '30 days';

  v_flag :=
    CASE
      WHEN v_period_revenue > 0
       AND v_period_refunds >= 0.9 * v_period_revenue
       AND v_period_refunds > 0
        THEN 'review'
      WHEN v_replacement_orders >= 2 AND v_refund_orders >= 1
        THEN 'review'
      WHEN v_recent_refunds >= 2
        THEN 'refunder'
      WHEN v_replacement_orders >= 2 OR v_recent_replacement_units >= 3
        THEN 'replacer'
      WHEN v_orders >= 2
        THEN 'returning'
      ELSE 'new'
    END;

  INSERT INTO public.customer_profiles (
    user_id, customer_key, buyer_id, buyer_email, buyer_name,
    first_seen_at, last_seen_at,
    orders_count, units_count, revenue_usd,
    refund_orders_count, refund_amount_usd,
    replacement_orders_count,
    distinct_asins_count, distinct_asins,
    order_ids, flag_level, last_refreshed_at
  ) VALUES (
    _user_id, _customer_key, v_buyer_id, v_buyer_email, v_buyer_name,
    v_first, v_last,
    v_orders, v_units, v_revenue,
    v_refund_orders, v_refund_amt,
    v_replacement_orders,
    COALESCE(array_length(v_asins,1),0), v_asins,
    v_order_ids, v_flag, now()
  )
  ON CONFLICT (user_id, customer_key) DO UPDATE SET
    buyer_id = COALESCE(EXCLUDED.buyer_id, public.customer_profiles.buyer_id),
    buyer_email = COALESCE(EXCLUDED.buyer_email, public.customer_profiles.buyer_email),
    buyer_name = COALESCE(EXCLUDED.buyer_name, public.customer_profiles.buyer_name),
    first_seen_at = EXCLUDED.first_seen_at,
    last_seen_at = EXCLUDED.last_seen_at,
    orders_count = EXCLUDED.orders_count,
    units_count = EXCLUDED.units_count,
    revenue_usd = EXCLUDED.revenue_usd,
    refund_orders_count = EXCLUDED.refund_orders_count,
    refund_amount_usd = EXCLUDED.refund_amount_usd,
    replacement_orders_count = EXCLUDED.replacement_orders_count,
    distinct_asins_count = EXCLUDED.distinct_asins_count,
    distinct_asins = EXCLUDED.distinct_asins,
    order_ids = EXCLUDED.order_ids,
    flag_level = EXCLUDED.flag_level,
    last_refreshed_at = now();
END;
$$;

-- 5. Trigger on sales_orders — mark customer_key + queue refresh
CREATE OR REPLACE FUNCTION public.sales_orders_customer_profile_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.customer_key IS NULL THEN
    NEW.customer_key := public.resolve_customer_key(
      NEW.buyer_id, NEW.buyer_email, NEW.buyer_name, NEW.ship_to_hash
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_orders_customer_key_biu ON public.sales_orders;
CREATE TRIGGER sales_orders_customer_key_biu
  BEFORE INSERT OR UPDATE OF buyer_id, buyer_email, buyer_name, ship_to_hash
  ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.sales_orders_customer_profile_trigger();

CREATE OR REPLACE FUNCTION public.sales_orders_customer_profile_refresh_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.customer_key IS NOT NULL THEN
      PERFORM public.refresh_customer_profile(OLD.user_id, OLD.customer_key);
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.customer_key IS NOT NULL THEN
    PERFORM public.refresh_customer_profile(NEW.user_id, NEW.customer_key);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.customer_key IS DISTINCT FROM NEW.customer_key
     AND OLD.customer_key IS NOT NULL THEN
    PERFORM public.refresh_customer_profile(OLD.user_id, OLD.customer_key);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_orders_customer_profile_aiud ON public.sales_orders;
CREATE TRIGGER sales_orders_customer_profile_aiud
  AFTER INSERT OR UPDATE OF customer_key, quantity, total_sale_amount, refund_amount, is_replacement, asin, order_date
  OR DELETE
  ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.sales_orders_customer_profile_refresh_trigger();
