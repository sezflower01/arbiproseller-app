-- Add AI_WIN_SALES_BOOSTER strategy to the enum
ALTER TYPE repricer_strategy ADD VALUE IF NOT EXISTS 'AI_WIN_SALES_BOOSTER';

-- Add new columns to repricer_rules for AI rule settings
ALTER TABLE public.repricer_rules
ADD COLUMN IF NOT EXISTS rule_type text DEFAULT 'standard',
ADD COLUMN IF NOT EXISTS when_only_seller text DEFAULT 'DO_NOT_REPRICE',
ADD COLUMN IF NOT EXISTS when_not_buybox_eligible text DEFAULT 'CUSTOM_PRICE',
ADD COLUMN IF NOT EXISTS when_buybox_suppressed text DEFAULT 'AI_REPRICE',
ADD COLUMN IF NOT EXISTS when_condition_used text DEFAULT 'AI_REPRICE',
ADD COLUMN IF NOT EXISTS when_backordered text DEFAULT 'MIN_PRICE',
ADD COLUMN IF NOT EXISTS when_below_min_price text DEFAULT 'MIN_PRICE',
ADD COLUMN IF NOT EXISTS compete_with_amazon boolean DEFAULT true,
ADD COLUMN IF NOT EXISTS compete_with_fba boolean DEFAULT true,
ADD COLUMN IF NOT EXISTS compete_with_fbm boolean DEFAULT true,
ADD COLUMN IF NOT EXISTS max_step_amount numeric DEFAULT 0.50,
ADD COLUMN IF NOT EXISTS max_step_percent numeric DEFAULT 5.0,
ADD COLUMN IF NOT EXISTS cooldown_minutes integer DEFAULT 15,
ADD COLUMN IF NOT EXISTS use_ai_tuning boolean DEFAULT true,
ADD COLUMN IF NOT EXISTS ai_settings jsonb DEFAULT '{}'::jsonb;

-- Add index for rule_type
CREATE INDEX IF NOT EXISTS idx_repricer_rules_rule_type ON public.repricer_rules(rule_type);

-- Create table for AI repricing activity/decisions log
CREATE TABLE IF NOT EXISTS public.repricer_ai_decisions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  assignment_id uuid REFERENCES public.repricer_assignments(id) ON DELETE CASCADE,
  asin text NOT NULL,
  sku text,
  marketplace text NOT NULL DEFAULT 'US',
  rule_id uuid REFERENCES public.repricer_rules(id) ON DELETE SET NULL,
  
  -- Input state
  current_price numeric,
  buybox_price numeric,
  buybox_seller_type text, -- 'Amazon', 'FBA', 'FBM'
  lowest_fba_price numeric,
  lowest_fbm_price numeric,
  lowest_overall_price numeric,
  offers_count integer,
  is_only_seller boolean DEFAULT false,
  is_buybox_eligible boolean DEFAULT true,
  is_buybox_suppressed boolean DEFAULT false,
  is_backordered boolean DEFAULT false,
  
  -- Decision output
  mode text NOT NULL, -- 'DO_NOT_REPRICE', 'MIN_PRICE', 'CUSTOM_PRICE', 'AI_REPRICE', 'SKIP'
  new_price numeric,
  price_delta numeric,
  reason text NOT NULL,
  
  -- AI tuning (if used)
  ai_aggressiveness numeric,
  ai_note text,
  ai_model text,
  
  -- Guardrails applied
  min_price_used numeric,
  max_price_used numeric,
  cooldown_applied boolean DEFAULT false,
  max_step_applied boolean DEFAULT false,
  
  -- Timestamps
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  applied_at timestamp with time zone,
  apply_status text DEFAULT 'pending' -- 'pending', 'applied', 'failed', 'skipped'
);

-- Enable RLS
ALTER TABLE public.repricer_ai_decisions ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Users can manage their own AI decisions"
ON public.repricer_ai_decisions
FOR ALL
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_repricer_ai_decisions_user_asin ON public.repricer_ai_decisions(user_id, asin);
CREATE INDEX IF NOT EXISTS idx_repricer_ai_decisions_created_at ON public.repricer_ai_decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_repricer_ai_decisions_assignment ON public.repricer_ai_decisions(assignment_id);

-- Add column for last repriced timestamp to assignments (for cooldown)
ALTER TABLE public.repricer_assignments
ADD COLUMN IF NOT EXISTS last_repriced_at timestamp with time zone;