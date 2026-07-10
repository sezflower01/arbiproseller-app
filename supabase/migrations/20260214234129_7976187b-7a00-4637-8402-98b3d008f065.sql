
-- Create listing_validations table to store validation history
CREATE TABLE public.listing_validations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  asin TEXT NOT NULL,
  sku TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'US',
  mode TEXT NOT NULL DEFAULT 'VALIDATION_PREVIEW',
  status TEXT,
  issues_count INTEGER NOT NULL DEFAULT 0,
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_response JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.listing_validations ENABLE ROW LEVEL SECURITY;

-- Users can manage their own validations
CREATE POLICY "Users can manage their own listing validations"
ON public.listing_validations
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Index for quick lookup
CREATE INDEX idx_listing_validations_user_asin ON public.listing_validations (user_id, asin, created_at DESC);
