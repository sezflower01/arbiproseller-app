-- Create order_price_snapshots table to permanently store listing prices at moment of order discovery
-- This ensures historical price accuracy even for pending orders before Amazon provides actual sold_price

CREATE TABLE public.order_price_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  order_id text NOT NULL,
  asin text NOT NULL,
  seller_sku text,
  marketplace_id text DEFAULT 'ATVPDKIKX0DER',
  
  -- Price snapshot data
  snapshot_price numeric NOT NULL,
  snapshot_source text NOT NULL DEFAULT 'inventory',
  currency text DEFAULT 'USD',
  
  -- Metadata
  captured_at timestamp with time zone NOT NULL DEFAULT now(),
  inventory_price_at_capture numeric,
  listing_api_price_at_capture numeric,
  
  -- Constraints
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(user_id, order_id, asin)
);

-- Enable RLS
ALTER TABLE public.order_price_snapshots ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own price snapshots"
  ON public.order_price_snapshots FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own price snapshots"
  ON public.order_price_snapshots FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role full access"
  ON public.order_price_snapshots FOR ALL
  USING ((auth.jwt() ->> 'role') = 'service_role');

-- Index for fast lookups
CREATE INDEX idx_order_price_snapshots_lookup 
  ON public.order_price_snapshots(user_id, order_id, asin);

CREATE INDEX idx_order_price_snapshots_user_asin 
  ON public.order_price_snapshots(user_id, asin, captured_at DESC);

-- Add comment explaining the table purpose
COMMENT ON TABLE public.order_price_snapshots IS 
  'Permanently stores listing prices at the exact moment an order is first discovered. 
   This ensures that if you sell the same ASIN twice on the same day at different prices ($40 and $50), 
   both prices are preserved even before Amazon provides the actual sold_price through enrichment.';