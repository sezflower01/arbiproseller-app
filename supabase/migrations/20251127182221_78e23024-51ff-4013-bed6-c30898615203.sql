-- Create FNSKU mapping table for persistent ASIN → FNSKU lookups
CREATE TABLE IF NOT EXISTS public.fnsku_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id TEXT NOT NULL,
  marketplace_id TEXT NOT NULL,
  asin TEXT NOT NULL,
  seller_sku TEXT,
  fnsku TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create unique index on seller_id, marketplace_id, asin
CREATE UNIQUE INDEX IF NOT EXISTS fnsku_map_unique_idx ON public.fnsku_map(seller_id, marketplace_id, asin);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS fnsku_map_seller_asin_idx ON public.fnsku_map(seller_id, asin);

-- Enable RLS
ALTER TABLE public.fnsku_map ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read their own mappings
CREATE POLICY "Users can view their own FNSKU mappings"
  ON public.fnsku_map
  FOR SELECT
  USING (
    seller_id IN (
      SELECT seller_id FROM public.seller_authorizations WHERE user_id = auth.uid()
    )
  );

-- Allow authenticated users to insert/update their own mappings
CREATE POLICY "Users can manage their own FNSKU mappings"
  ON public.fnsku_map
  FOR ALL
  USING (
    seller_id IN (
      SELECT seller_id FROM public.seller_authorizations WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    seller_id IN (
      SELECT seller_id FROM public.seller_authorizations WHERE user_id = auth.uid()
    )
  );

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_fnsku_map_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fnsku_map_updated_at
  BEFORE UPDATE ON public.fnsku_map
  FOR EACH ROW
  EXECUTE FUNCTION update_fnsku_map_updated_at();