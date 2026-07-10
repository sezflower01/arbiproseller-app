-- Create cached financial events table for fast P&L retrieval
CREATE TABLE public.financial_events_cache (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  event_type TEXT NOT NULL, -- 'shipment', 'refund', 'service_fee', 'adjustment', 'removal', 'liquidation'
  event_date DATE NOT NULL,
  amazon_order_id TEXT,
  asin TEXT,
  
  -- Financial amounts (all in USD)
  sales NUMERIC DEFAULT 0,
  refunds NUMERIC DEFAULT 0,
  shipping_credits NUMERIC DEFAULT 0,
  shipping_credit_refunds NUMERIC DEFAULT 0,
  gift_wrap_credits NUMERIC DEFAULT 0,
  gift_wrap_credit_refunds NUMERIC DEFAULT 0,
  promotional_rebates NUMERIC DEFAULT 0,
  promotional_rebate_refunds NUMERIC DEFAULT 0,
  other_income NUMERIC DEFAULT 0,
  reimbursements NUMERIC DEFAULT 0,
  liquidations NUMERIC DEFAULT 0,
  
  -- Fees
  referral_fees NUMERIC DEFAULT 0,
  fba_fees NUMERIC DEFAULT 0,
  variable_closing_fees NUMERIC DEFAULT 0,
  fixed_closing_fees NUMERIC DEFAULT 0,
  fba_inbound_fees NUMERIC DEFAULT 0,
  fba_storage_fees NUMERIC DEFAULT 0,
  fba_removal_fees NUMERIC DEFAULT 0,
  fba_disposal_fees NUMERIC DEFAULT 0,
  fba_long_term_storage_fees NUMERIC DEFAULT 0,
  other_fees NUMERIC DEFAULT 0,
  
  -- Tax
  sales_tax_collected NUMERIC DEFAULT 0,
  marketplace_facilitator_tax NUMERIC DEFAULT 0,
  sales_tax_refunds NUMERIC DEFAULT 0,
  marketplace_facilitator_tax_refunds NUMERIC DEFAULT 0,
  
  -- Metadata
  raw_event JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create unique constraint to prevent duplicates
CREATE UNIQUE INDEX idx_financial_events_unique ON public.financial_events_cache 
  (user_id, event_type, event_date, COALESCE(amazon_order_id, ''), COALESCE(asin, ''));

-- Create indexes for fast date-range queries
CREATE INDEX idx_financial_events_user_date ON public.financial_events_cache (user_id, event_date);
CREATE INDEX idx_financial_events_date ON public.financial_events_cache (event_date);

-- Track last sync date per user
CREATE TABLE public.financial_sync_state (
  user_id UUID PRIMARY KEY,
  last_synced_date DATE NOT NULL,
  last_sync_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.financial_events_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_sync_state ENABLE ROW LEVEL SECURITY;

-- RLS Policies - users can only see their own data
CREATE POLICY "Users can view their own financial events" 
ON public.financial_events_cache 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can view their own sync state" 
ON public.financial_sync_state 
FOR SELECT 
USING (auth.uid() = user_id);