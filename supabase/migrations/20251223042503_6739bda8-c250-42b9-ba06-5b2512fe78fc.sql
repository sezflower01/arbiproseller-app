-- Create table to track FBA inbound transportation fees per shipment
CREATE TABLE public.fba_inbound_fees (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  shipment_id TEXT,
  fee_type TEXT NOT NULL,
  fee_reason TEXT,
  fee_amount NUMERIC NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  posted_date DATE NOT NULL,
  asin TEXT,
  sku TEXT,
  fnsku TEXT,
  event_description TEXT,
  raw_event JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create index for efficient queries
CREATE INDEX idx_fba_inbound_fees_user_date ON public.fba_inbound_fees (user_id, posted_date);
CREATE INDEX idx_fba_inbound_fees_shipment ON public.fba_inbound_fees (user_id, shipment_id);

-- Create unique constraint to prevent duplicates
CREATE UNIQUE INDEX idx_fba_inbound_fees_unique ON public.fba_inbound_fees (user_id, shipment_id, fee_type, posted_date, COALESCE(asin, ''), COALESCE(sku, ''));

-- Enable Row Level Security
ALTER TABLE public.fba_inbound_fees ENABLE ROW LEVEL SECURITY;

-- Create RLS policy for users to manage their own fees
CREATE POLICY "Users can manage their own inbound fees" 
ON public.fba_inbound_fees 
FOR ALL 
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Add trigger for updated_at
CREATE TRIGGER update_fba_inbound_fees_updated_at
BEFORE UPDATE ON public.fba_inbound_fees
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();