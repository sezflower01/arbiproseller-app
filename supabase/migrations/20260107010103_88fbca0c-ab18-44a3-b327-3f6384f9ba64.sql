-- Add total_fees column to buy_box_cache to store real Amazon fees
ALTER TABLE public.buy_box_cache 
ADD COLUMN IF NOT EXISTS total_fees NUMERIC DEFAULT NULL;

-- Add a comment explaining the column
COMMENT ON COLUMN public.buy_box_cache.total_fees IS 'Real total fees from Amazon Fees API, not estimated';