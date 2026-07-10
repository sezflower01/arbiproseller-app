-- Create table for ASIN price history tracking
CREATE TABLE public.asin_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  asin text NOT NULL,
  marketplace text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  listing_price numeric NOT NULL,
  buybox_price numeric,
  currency_code text NOT NULL,
  price_usd numeric,
  source text NOT NULL DEFAULT 'pricing_api',
  fx_rate numeric,
  CONSTRAINT asin_price_history_unique UNIQUE(user_id, asin, marketplace, captured_at)
);

-- Create index for efficient querying
CREATE INDEX idx_asin_price_history_lookup ON public.asin_price_history (user_id, asin, marketplace, captured_at DESC);

-- Enable RLS
ALTER TABLE public.asin_price_history ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own price history"
ON public.asin_price_history
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own price history"
ON public.asin_price_history
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own price history"
ON public.asin_price_history
FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to price history"
ON public.asin_price_history
FOR ALL
USING ((auth.jwt() ->> 'role'::text) = 'service_role');