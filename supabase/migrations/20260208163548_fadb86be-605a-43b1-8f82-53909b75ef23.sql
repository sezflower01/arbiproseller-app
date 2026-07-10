
-- Add granular fee columns to financial_events_cache for Sellerboard-style breakdown
-- These were previously lumped into other_fees or reimbursements

ALTER TABLE public.financial_events_cache
  ADD COLUMN IF NOT EXISTS compensated_clawback numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hrr_non_apparel numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS digital_services_fee numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS warehouse_lost numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS warehouse_damage numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reversal_reimbursement numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS free_replacement_refund_items numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fba_inbound_convenience_fee numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS liquidations_brokerage_fee numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS re_commerce_grading_charge numeric DEFAULT 0;
