-- Per-marketplace rule settings table
-- Allows each rule to have different min/max/undercut settings per marketplace
CREATE TABLE IF NOT EXISTS public.repricer_rule_marketplace_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  rule_id UUID NOT NULL REFERENCES public.repricer_rules(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL DEFAULT 'US',
  currency TEXT NOT NULL DEFAULT 'USD',
  min_price NUMERIC,
  max_price NUMERIC,
  undercut_amount NUMERIC NOT NULL DEFAULT 0.01,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  cooldown_minutes INTEGER DEFAULT 15,
  max_step_amount NUMERIC DEFAULT 0.50,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT unique_rule_marketplace UNIQUE (rule_id, marketplace)
);

-- Enable RLS
ALTER TABLE public.repricer_rule_marketplace_settings ENABLE ROW LEVEL SECURITY;

-- RLS policies (inherit from parent rule)
CREATE POLICY "Users can manage their own rule marketplace settings"
ON public.repricer_rule_marketplace_settings
FOR ALL
USING (
  EXISTS (
    SELECT 1 FROM public.repricer_rules r 
    WHERE r.id = repricer_rule_marketplace_settings.rule_id 
    AND r.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.repricer_rules r 
    WHERE r.id = repricer_rule_marketplace_settings.rule_id 
    AND r.user_id = auth.uid()
  )
);

-- Marketplace currency mapping reference
COMMENT ON TABLE public.repricer_rule_marketplace_settings IS 'Per-marketplace settings for repricer rules. Currencies: US=USD, CA=CAD, MX=MXN, BR=BRL';

-- Add index for fast lookup
CREATE INDEX idx_rule_marketplace_settings_rule_id ON public.repricer_rule_marketplace_settings(rule_id);
CREATE INDEX idx_rule_marketplace_settings_marketplace ON public.repricer_rule_marketplace_settings(marketplace);