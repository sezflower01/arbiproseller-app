-- Add smart_profile column to repricer_rules
ALTER TABLE public.repricer_rules 
ADD COLUMN smart_profile text NOT NULL DEFAULT 'CUSTOM';

-- Add comment for documentation
COMMENT ON COLUMN public.repricer_rules.smart_profile IS 'Smart Engine profile preset: CUSTOM, VELOCITY_DOMINATOR, MOMENTUM_BUILDER, BALANCED_PRO, MARGIN_BUILDER, PROFIT_EXTRACTOR';