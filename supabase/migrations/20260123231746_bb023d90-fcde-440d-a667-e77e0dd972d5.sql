-- 1) Enrichment logs table (durable observability)
CREATE TABLE IF NOT EXISTS public.enrichment_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- What we tried to enrich
  order_id text NULL,
  asin text NULL,
  seller_sku text NULL,

  -- What we attempted
  enrichment_type text NOT NULL CHECK (enrichment_type IN ('price','fees','sync','repair')),
  source text NOT NULL DEFAULT 'unknown',

  -- Outcome
  status text NOT NULL CHECK (status IN ('started','success','failed','rate_limited','skipped')),
  http_status integer NULL,
  error_message text NULL,
  details jsonb NULL
);

ALTER TABLE public.enrichment_logs ENABLE ROW LEVEL SECURITY;

-- RLS: users can see their own logs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'enrichment_logs'
      AND policyname = 'Users can view their own enrichment logs'
  ) THEN
    CREATE POLICY "Users can view their own enrichment logs"
    ON public.enrichment_logs
    FOR SELECT
    USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'enrichment_logs'
      AND policyname = 'Users can insert their own enrichment logs'
  ) THEN
    CREATE POLICY "Users can insert their own enrichment logs"
    ON public.enrichment_logs
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_enrichment_logs_user_created_at
  ON public.enrichment_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_enrichment_logs_user_status
  ON public.enrichment_logs (user_id, status);


-- 2) Retry/queue columns on sales_orders (self-healing)
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS needs_price_enrich boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS needs_fee_enrich boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enrich_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_enrich_attempt_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_enrich_error text NULL,
  ADD COLUMN IF NOT EXISTS next_enrich_after timestamptz NULL;

CREATE INDEX IF NOT EXISTS idx_sales_orders_enrich_queue
  ON public.sales_orders (user_id, next_enrich_after)
  WHERE (needs_price_enrich OR needs_fee_enrich);
