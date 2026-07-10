
-- 1) Cost sanity guard column
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS cost_invalid boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_sales_orders_cost_invalid
  ON public.sales_orders (user_id) WHERE cost_invalid = true;

-- 2) Shared API rate limit bucket
CREATE TABLE IF NOT EXISTS public.api_rate_limits (
  bucket text PRIMARY KEY,
  tokens_available numeric NOT NULL,
  capacity numeric NOT NULL,
  refill_per_sec numeric NOT NULL,
  last_refill_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.api_rate_limits TO service_role;

ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role only" ON public.api_rate_limits;
CREATE POLICY "service role only" ON public.api_rate_limits
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Seed Fees API bucket: Amazon SP-API Fees endpoint allows ~1 req/sec, burst 2.
INSERT INTO public.api_rate_limits (bucket, tokens_available, capacity, refill_per_sec)
VALUES ('fees_api', 2, 2, 1.0)
ON CONFLICT (bucket) DO NOTHING;

-- Seed Order Items bucket for shared use across functions.
INSERT INTO public.api_rate_limits (bucket, tokens_available, capacity, refill_per_sec)
VALUES ('order_items_api', 2, 2, 0.5)
ON CONFLICT (bucket) DO NOTHING;

-- 3) Atomic consume RPC. Returns true if a token was taken; otherwise wait_ms hints how long to back off.
CREATE OR REPLACE FUNCTION public.consume_api_token(
  p_bucket text,
  p_count numeric DEFAULT 1
)
RETURNS TABLE(allowed boolean, wait_ms integer, tokens_left numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.api_rate_limits%ROWTYPE;
  v_now timestamptz := now();
  v_elapsed numeric;
  v_new_tokens numeric;
BEGIN
  SELECT * INTO v_row FROM public.api_rate_limits WHERE bucket = p_bucket FOR UPDATE;
  IF NOT FOUND THEN
    -- Unknown bucket → allow (don't block callers on misconfig)
    RETURN QUERY SELECT true, 0, 0::numeric;
    RETURN;
  END IF;

  v_elapsed := EXTRACT(EPOCH FROM (v_now - v_row.last_refill_at));
  v_new_tokens := LEAST(v_row.capacity, v_row.tokens_available + v_elapsed * v_row.refill_per_sec);

  IF v_new_tokens >= p_count THEN
    UPDATE public.api_rate_limits
       SET tokens_available = v_new_tokens - p_count,
           last_refill_at = v_now,
           updated_at = v_now
     WHERE bucket = p_bucket;
    RETURN QUERY SELECT true, 0, (v_new_tokens - p_count);
  ELSE
    -- Save refilled token count so concurrent callers don't double-add
    UPDATE public.api_rate_limits
       SET tokens_available = v_new_tokens,
           last_refill_at = v_now,
           updated_at = v_now
     WHERE bucket = p_bucket;
    RETURN QUERY SELECT
      false,
      GREATEST(50, CEIL(((p_count - v_new_tokens) / v_row.refill_per_sec) * 1000))::integer,
      v_new_tokens;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.consume_api_token(text, numeric) TO service_role;
