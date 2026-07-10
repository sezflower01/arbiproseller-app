-- Add Profit Guard fields to repricer_rules table
ALTER TABLE public.repricer_rules
  ADD COLUMN IF NOT EXISTS min_profit_dollars NUMERIC DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS min_roi_percent NUMERIC DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS include_fees_in_floor BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS block_auto_apply_if_cost_missing BOOLEAN DEFAULT true;

-- Add comment for documentation
COMMENT ON COLUMN public.repricer_rules.min_profit_dollars IS 'Minimum profit floor in dollars for AI repricing';
COMMENT ON COLUMN public.repricer_rules.min_roi_percent IS 'Minimum ROI percentage floor for AI repricing';
COMMENT ON COLUMN public.repricer_rules.include_fees_in_floor IS 'Include fees when calculating profit floor price';
COMMENT ON COLUMN public.repricer_rules.block_auto_apply_if_cost_missing IS 'Block auto-apply if unit cost is unknown';