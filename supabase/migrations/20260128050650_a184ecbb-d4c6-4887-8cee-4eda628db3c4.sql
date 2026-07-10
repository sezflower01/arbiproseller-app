-- First check if the table exists and drop if it has issues
DROP TABLE IF EXISTS public.repricer_price_actions;

-- Create repricer_price_actions table for audit trail
CREATE TABLE public.repricer_price_actions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  assignment_id UUID,
  asin TEXT NOT NULL,
  sku TEXT,
  marketplace TEXT DEFAULT 'US',
  
  -- Price changes
  old_price NUMERIC,
  new_price NUMERIC,
  old_min_price NUMERIC,
  new_min_price NUMERIC,
  old_max_price NUMERIC,
  new_max_price NUMERIC,
  
  -- Action details
  action_type TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  reason TEXT,
  intelligence_factors JSONB,
  
  -- Result
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  amazon_response JSONB,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.repricer_price_actions ENABLE ROW LEVEL SECURITY;

-- RLS policies for price actions
CREATE POLICY "Users can view their own price actions" 
ON public.repricer_price_actions 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own price actions" 
ON public.repricer_price_actions 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role full access to price actions" 
ON public.repricer_price_actions 
FOR ALL 
USING ((auth.jwt() ->> 'role'::text) = 'service_role');

-- Add indexes
CREATE INDEX idx_repricer_price_actions_user_asin 
ON public.repricer_price_actions(user_id, asin);

CREATE INDEX idx_repricer_price_actions_created 
ON public.repricer_price_actions(created_at DESC);