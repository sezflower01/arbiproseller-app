-- Create enrichment_logs table to track all enrichment attempts
CREATE TABLE IF NOT EXISTS public.enrichment_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  order_id TEXT,
  asin TEXT,
  seller_sku TEXT,
  enrichment_type TEXT NOT NULL CHECK (enrichment_type IN ('price', 'fees', 'both')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'rate_limited', 'timeout')),
  source TEXT, -- 'global_sync', 'manual_button', 'scheduled_cron', 'retry'
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE
);

-- Add index for querying by user and status
CREATE INDEX idx_enrichment_logs_user_status ON public.enrichment_logs(user_id, status);
CREATE INDEX idx_enrichment_logs_created_at ON public.enrichment_logs(created_at);

-- Enable RLS
ALTER TABLE public.enrichment_logs ENABLE ROW LEVEL SECURITY;

-- Users can view their own logs
CREATE POLICY "Users can view own enrichment logs" 
ON public.enrichment_logs 
FOR SELECT 
USING (auth.uid() = user_id);

-- Users can insert their own logs
CREATE POLICY "Users can insert own enrichment logs" 
ON public.enrichment_logs 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

-- Allow edge functions to manage logs (service role)
CREATE POLICY "Service role full access to enrichment logs" 
ON public.enrichment_logs 
FOR ALL 
USING (auth.jwt() ->> 'role' = 'service_role');

-- Add retry queue columns to sales_orders
ALTER TABLE public.sales_orders 
ADD COLUMN IF NOT EXISTS needs_price_enrich BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS needs_fee_enrich BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS enrich_attempts INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_enrich_error TEXT,
ADD COLUMN IF NOT EXISTS last_enrich_at TIMESTAMP WITH TIME ZONE;

-- Add index for retry queue queries
CREATE INDEX IF NOT EXISTS idx_sales_orders_needs_enrich 
ON public.sales_orders(user_id, needs_price_enrich, needs_fee_enrich) 
WHERE needs_price_enrich = TRUE OR needs_fee_enrich = TRUE;