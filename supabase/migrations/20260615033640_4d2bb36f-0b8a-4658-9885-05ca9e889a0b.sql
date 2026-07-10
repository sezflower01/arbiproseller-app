
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS is_replacement boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS replacement_reason text,
  ADD COLUMN IF NOT EXISTS related_order_id text;

CREATE INDEX IF NOT EXISTS sales_orders_is_replacement_idx
  ON public.sales_orders (user_id, is_replacement)
  WHERE is_replacement = true;

-- Backfill from existing order_type values returned by Orders API
UPDATE public.sales_orders
SET is_replacement = true,
    replacement_reason = 'orders_api_replacement'
WHERE is_replacement = false
  AND order_type IN ('Replacement','Exchange','SourcingOnDemandOrder');

CREATE TABLE IF NOT EXISTS public.replacement_detection_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  order_id text NOT NULL,
  asin text,
  detection_source text NOT NULL,
  prior_is_replacement boolean,
  prior_sold_price numeric,
  quantity integer,
  unit_cost numeric,
  cogs_impact numeric,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.replacement_detection_audit TO authenticated;
GRANT ALL ON public.replacement_detection_audit TO service_role;

ALTER TABLE public.replacement_detection_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read their own replacement audit"
  ON public.replacement_detection_audit
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS replacement_detection_audit_user_created_idx
  ON public.replacement_detection_audit (user_id, created_at DESC);
